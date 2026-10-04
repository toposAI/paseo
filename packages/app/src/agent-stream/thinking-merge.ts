import type { StreamItem, ThoughtItem } from "@/types/stream";

/**
 * Reasoning reaches the client as many separate `thought` items even though nothing
 * visible sits between them: a discarded event (a Claude task tool call the reducer
 * drops, an in-place todo/plugin update) still flushes the streaming head, so the next
 * reasoning chunk starts a fresh item. `flushHeadToTail` never merges adjacent
 * thoughts, so a settled turn renders one "Thinking" row per segment.
 *
 * The presentation layer already reshapes source items into display rows (Markdown
 * blocks for assistant messages, Overview groups for tool calls), so adjacent thoughts
 * are collapsed here rather than in the streaming reducer.
 */
const THOUGHT_JOIN = "\n\n";

interface CachedMergedThought {
  last: ThoughtItem;
  length: number;
  merged: ThoughtItem;
}

// Keyed by the run's first item, which is stable while the run only grows at its end.
const mergedThoughtCache = new WeakMap<ThoughtItem, CachedMergedThought>();

function mergeThoughtRun(run: readonly ThoughtItem[]): ThoughtItem {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const cached = mergedThoughtCache.get(first);
  if (cached && cached.last === last && cached.length === run.length) {
    return cached.merged;
  }

  const merged: ThoughtItem = {
    kind: "thought",
    id: first.id,
    ...(first.turnId !== undefined ? { turnId: first.turnId } : {}),
    ...(last.timelineCursor !== undefined ? { timelineCursor: last.timelineCursor } : {}),
    text: run.map((item) => item.text).join(THOUGHT_JOIN),
    timestamp: last.timestamp,
    status: run.every((item) => item.status === "ready") ? "ready" : "loading",
  };
  mergedThoughtCache.set(first, { last, length: run.length, merged });
  return merged;
}

/**
 * Collapse runs of adjacent thought items into a single row. Turns are never merged
 * across, so a turn boundary still breaks the run. Returns the input array unchanged
 * when there is nothing to merge, which keeps downstream identity checks intact.
 */
export function mergeAdjacentThoughts(items: StreamItem[]): StreamItem[] {
  let output: StreamItem[] | null = null;
  let index = 0;

  while (index < items.length) {
    const item = items[index]!;
    if (item.kind !== "thought") {
      output?.push(item);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < items.length) {
      const next = items[end]!;
      if (next.kind !== "thought" || next.turnId !== item.turnId) {
        break;
      }
      end += 1;
    }

    if (end - index === 1) {
      output?.push(item);
      index = end;
      continue;
    }

    output ??= items.slice(0, index);
    output.push(mergeThoughtRun(items.slice(index, end) as ThoughtItem[]));
    index = end;
  }

  return output ?? items;
}
