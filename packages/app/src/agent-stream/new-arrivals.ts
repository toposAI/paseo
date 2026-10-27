import type { StreamItem } from "@/types/stream";

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

/**
 * Rows newer than the baseline. Older history loading in above the reader has smaller seqs, so it
 * is never counted as news.
 */
export function countArrivalsAfter(
  items: readonly StreamItem[],
  epoch: string | null,
  baselineSeq: number | null,
): number {
  if (baselineSeq === null) return 0;
  let count = 0;
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (cursor && cursor.epoch === epoch && cursor.seq > baselineSeq) count += 1;
  }
  return count;
}
