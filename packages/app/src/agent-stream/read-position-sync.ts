// Pure rules for syncing "how far the reader has seen" across devices. The stored value is a
// timeline seq plus the epoch it belongs to; a seq is meaningless under another epoch.

export interface StoredReadPosition {
  enabled: boolean;
  seq: number | null;
  epoch: string | null;
}

// Where to reopen: the last row the reader saw, unless nothing is newer than it (then the
// ordinary open-at-the-bottom already shows everything) or the stored seq belongs to a
// different timeline.
export function pickRestoreSeq(input: {
  stored: StoredReadPosition | null;
  timelineEpoch: string | null;
  loadedSeqs: readonly number[];
}): number | null {
  const { stored, timelineEpoch, loadedSeqs } = input;
  if (!stored?.enabled || stored.seq === null || timelineEpoch === null) return null;
  if (stored.epoch !== timelineEpoch || loadedSeqs.length === 0) return null;
  const newest = Math.max(...loadedSeqs);
  return stored.seq < newest ? stored.seq : null;
}

// Reads only move forward: an older view of the same timeline must not pull the record back.
export function nextHighWater(current: number | null, viewedSeq: number | null): number | null {
  if (viewedSeq === null) return null;
  return current === null || viewedSeq > current ? viewedSeq : null;
}
