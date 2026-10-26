// Pure rules for resuming a chat where the reader stopped. The stored value is a timeline seq plus
// the epoch it belongs to; a seq is meaningless under another epoch.

export interface StoredReadPosition {
  enabled: boolean;
  seq: number | null;
  epoch: string | null;
}

/** Where to reopen, and which row starts the "ここから未読" stretch. */
export interface ResumePick {
  /** The row to put at the top of the viewport. */
  restoreSeq: number;
  /** The first row after the stored position: the divider sits right above it. */
  firstUnreadSeq: number;
  /** The newest row at the time of the restore; reaching it dismisses the divider. */
  newestSeq: number;
}

// Open at the row just before the first unread row, so the reader still sees the last thing they
// read above the "ここから未読" divider. When the stored row is not among the loaded rows, start at
// the first unread row itself.
export function pickResume(input: {
  stored: StoredReadPosition | null;
  timelineEpoch: string | null;
  loadedSeqs: readonly number[];
}): ResumePick | null {
  const { stored, timelineEpoch, loadedSeqs } = input;
  if (!stored?.enabled || stored.seq === null || timelineEpoch === null) return null;
  if (stored.epoch !== timelineEpoch || loadedSeqs.length === 0) return null;
  const readSeq = stored.seq;
  const sorted = [...loadedSeqs].sort((a, b) => a - b);
  const newestSeq = sorted[sorted.length - 1] as number;
  // Nothing newer than the stored row: the ordinary open-at-the-bottom already shows everything.
  if (readSeq >= newestSeq) return null;
  const firstUnreadSeq = sorted.find((seq) => seq > readSeq) as number;
  const previousSeqs = sorted.filter((seq) => seq < firstUnreadSeq);
  const restoreSeq = previousSeqs.length > 0 ? (previousSeqs.at(-1) as number) : firstUnreadSeq;
  return { restoreSeq, firstUnreadSeq, newestSeq };
}

// Reads only move forward: an older view of the same timeline must not pull the record back.
export function nextHighWater(current: number | null, viewedSeq: number | null): number | null {
  if (viewedSeq === null) return null;
  return current === null || viewedSeq > current ? viewedSeq : null;
}

// The divider is a marker for "what I had not read when I opened this": once the reader has seen
// the newest row that existed at that moment, it has served its purpose and goes away.
export function shouldDismissUnreadDivider(
  highWater: number | null,
  dismissAtSeq: number | null,
): boolean {
  return highWater !== null && dismissAtSeq !== null && highWater >= dismissAtSeq;
}
