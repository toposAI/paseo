import type { StreamItem } from "@/types/stream";
import { getStreamItemMessageId } from "./presentation";

// Rows that arrive while the reader is away from the bottom do not move the view; they are only
// counted, so the "new messages" button can say how many are waiting below.

/** The newest committed row of this history epoch, or null when none is loaded. */
export function newestSeqOf(items: readonly StreamItem[], epoch: string | null): number | null {
  let newest: number | null = null;
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (!cursor || cursor.epoch !== epoch) continue;
    if (newest === null || cursor.seq > newest) newest = cursor.seq;
  }
  return newest;
}

// Rows that are the agent working rather than a message to read: thinking, tool calls and the like.
const NON_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "thought",
  "tool_call",
  "todo_list",
  "compaction",
  "plugin",
  "notification",
]);

/**
 * Messages newer than the baseline. Older history loading in above the reader has smaller seqs, so
 * it is never counted as news. An assistant message is several rows, so rows are counted once per
 * message, and the reader's own sent messages are not news.
 */
export function countArrivalsAfter(
  items: readonly StreamItem[],
  epoch: string | null,
  baselineSeq: number | null,
): number {
  if (baselineSeq === null) return 0;
  const messages = new Set<string>();
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (item.kind === "user_message" || NON_MESSAGE_KINDS.has(item.kind)) continue;
    if (cursor && cursor.epoch === epoch && cursor.seq > baselineSeq) {
      messages.add(getStreamItemMessageId(item));
    }
  }
  return messages.size;
}
