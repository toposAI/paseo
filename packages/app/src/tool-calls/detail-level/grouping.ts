import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ThoughtItem, ToolCallItem } from "@/types/stream";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Reasoning and tool calls are the invisible work between two visible messages, so they
 * share a run: a thought that sits between two tool calls must not split the run into
 * three consecutive badges (one per segment). Anything the reader must see on its own —
 * an assistant message, a todo list, a notification, a plan/approval call, `speak` —
 * still ends the run.
 */
export type ActivityItem = ThoughtItem | ToolCallItem;

export interface ActivityRun {
  id: string;
  items: readonly ActivityItem[];
  latest: ActivityItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingCalls: readonly ActivityItem[];
}

export interface GroupedToolCalls<TGroup> {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ToolCallGroupLookup<TGroup>;
  historyGroupUpdatesByHostId: ToolCallGroupLookup<TGroup>;
}

export interface ToolCallGroupLookup<TGroup> {
  readonly size: number;
  get(id: string): TGroup | undefined;
  has(id: string): boolean;
}

const EMPTY_GROUPS = new Map<string, never>();

export function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status,
    error: data.error,
  };
}

export function isGroupableToolCall(item: StreamItem): item is ToolCallItem {
  if (item.kind !== "tool_call") {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

export function isGroupableActivityItem(item: StreamItem): item is ActivityItem {
  return item.kind === "thought" || isGroupableToolCall(item);
}

/**
 * A row of nothing but reasoning is still an ordinary Thinking row: folding it would hide
 * its text behind a second press and would leave `autoExpandReasoning` with nothing to
 * expand. So a lone thought is never a group; the row turns into one only once a tool call
 * joins it, which keeps the same id and therefore the same place in the stream.
 */
function isLoneThought(items: readonly ActivityItem[]): boolean {
  return items.length === 1 && items[0]!.kind === "thought";
}

/** Turns are never merged across, the same rule adjacent thoughts already follow. */
function startsNewRun(pending: readonly ActivityItem[], item: ActivityItem): boolean {
  const last = pending.at(-1);
  return last !== undefined && last.turnId !== item.turnId;
}

function createRun(items: readonly ActivityItem[], isSealed: boolean): ActivityRun {
  const first = items[0];
  const latest = items.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty activity run");
  }
  return { id: first.id, items, latest, isSealed };
}

/**
 * A run of one item is its own host, so a lone thought keeps its identity. A longer run
 * is hosted by its latest item so the row carries the newest cursor/status, but it keeps
 * the first item's id: the host must stay addressable while the run grows at its tail.
 */
function createHost(run: ActivityRun): StreamItem {
  if (run.items.length === 1) {
    return run.items[0]!;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(call: ToolCallItem): boolean {
  const status = describeToolCall(call).status;
  return status === "running" || status === "executing";
}

/** A thought is still streaming until its status settles, so it keeps the run active. */
function isRunningItem(item: ActivityItem): boolean {
  return item.kind === "thought" ? item.status !== "ready" : isRunning(item);
}

function appendRun<TGroup>(input: {
  items: readonly ActivityItem[];
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ActivityRun) => TGroup;
}): void {
  if (input.items.length === 0) {
    return;
  }
  if (isLoneThought(input.items)) {
    input.output.push(input.items[0]!);
    return;
  }
  const run = createRun(input.items, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ActivityRun) => TGroup;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: ActivityItem[] = [];

  for (const item of input.tail) {
    if (isGroupableActivityItem(item)) {
      if (startsNewRun(pending, item)) {
        appendRun({
          items: pending,
          isSealed: true,
          output,
          groups,
          buildGroup: input.buildGroup,
        });
        pending = [];
      }
      pending.push(item);
      continue;
    }
    appendRun({
      items: pending,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
    output.push(item);
  }

  appendRun({
    items: pending,
    isSealed: true,
    output,
    groups,
    buildGroup: input.buildGroup,
  });

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    pendingCalls: pending,
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ActivityRun) => TGroup;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  // History rows that are hosted by a run growing in the head. A history row can become a
  // host without already having a group (it started as a lone thought), so this is tracked
  // as the run is flushed rather than derived from the history's group map.
  const historyGroupUpdates = new Map<string, TGroup>();
  let pending = [...input.history.pendingCalls];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    const run = isLoneThought(pending) ? null : createRun(pending, isSealed);
    if (hostPlacement === "head") {
      head.push(run ? createHost(run) : pending[0]!);
    }
    if (run && (hostPlacement === "head" || pendingIncludesHead || !isSealed)) {
      const group = input.buildGroup(run);
      liveGroups.set(run.id, group);
      if (hostPlacement === "history") {
        historyGroupUpdates.set(run.id, group);
      }
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isGroupableActivityItem(item)) {
      if (pending.length === 0) {
        hostPlacement = "head";
      } else if (startsNewRun(pending, item)) {
        flush(true);
        hostPlacement = "head";
      }
      pending.push(item);
      pendingIncludesHead = true;
      continue;
    }
    flush(true);
    head.push(item);
  }
  // Tool calls live in retained tail rather than the streaming head. The agent
  // lifecycle snapshot can still be idle while a newly received tool call is
  // already running, so its direct timeline status is the authoritative start
  // signal. The lifecycle state continues to keep completed calls live between
  // sequential tool updates.
  const trailingRunIsActive = input.isTurnActive || pending.some(isRunningItem);
  flush(!trailingRunIsActive);

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  if (input.history.groupsByHostId.size === 0) {
    return {
      tail: input.history.tail,
      head,
      groupsByHostId: liveGroups,
      historyGroupUpdatesByHostId:
        historyGroupUpdates.size > 0 ? historyGroupUpdates : EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    if (input.history.groupsByHostId.has(id)) {
      historyGroupUpdates.set(id, group);
    }
  }
  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId: historyGroupUpdates.size > 0 ? historyGroupUpdates : EMPTY_GROUPS,
  };
}
