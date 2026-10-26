import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { continuesTurn } from "@/agent-stream/turn-membership";
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
 * expand. The tail and the head are merged separately, so the last thought of a turn and
 * the first thought of the next refresh arrive here as two thoughts with no tool call
 * between them; folding those would make the row flip between a Thinking row and a badge.
 * A run therefore becomes a group only once a tool call joins it, and it keeps the first
 * item's id, so the row stays in the same place in the stream.
 */
function isThoughtsOnly(items: readonly ActivityItem[]): boolean {
  return items.every((item) => item.kind === "thought");
}

/**
 * Turns are never merged across, following the canonical turn rule rather than comparing
 * turn ids here: a timeline without turn ids (old daemons, persisted rows) has no boundary
 * to compare, and treating a missing id as a different turn would cut one response in two.
 */
function startsNewRun(pending: readonly ActivityItem[], item: ActivityItem): boolean {
  const last = pending.at(-1);
  return last !== undefined && !continuesTurn(last, item);
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

/**
 * A running tool keeps a history-hosted run live, because tool calls settle in retained
 * tail while the streaming head moves on. A thought does not: by the time it is in the
 * history with nothing new behind it, the stream has moved past it, so a thought still
 * loading there was left behind by an interruption.
 */
function isStaleThought(items: readonly ActivityItem[]): boolean {
  return items.some((item) => item.kind === "thought" && item.status !== "ready");
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
  if (isThoughtsOnly(input.items)) {
    input.output.push(...input.items);
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
  // The history items at the front of `pending` are already drawn as part of the tail, so a
  // run that ends up ungrouped must only re-emit the items that came from the head.
  let historyCount = pending.length;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    // A run hosted by the history with nothing new in the head is not live: whatever is
    // still loading there was left behind by an interruption, so it stays sealed. Its
    // spinner still follows the item statuses; only the "still thinking" claim is dropped.
    const isHistoryOnly = hostPlacement === "history" && !pendingIncludesHead;
    const run = isThoughtsOnly(pending)
      ? null
      : createRun(pending, isSealed || (isHistoryOnly && isStaleThought(pending)));
    if (run) {
      if (hostPlacement === "head") {
        head.push(createHost(run));
      }
      if (hostPlacement === "head" || pendingIncludesHead || !isSealed) {
        const group = input.buildGroup(run);
        liveGroups.set(run.id, group);
        if (hostPlacement === "history") {
          historyGroupUpdates.set(run.id, group);
        }
      }
    } else {
      for (const item of pending.slice(historyCount)) {
        head.push(item);
      }
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
    historyCount = 0;
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
