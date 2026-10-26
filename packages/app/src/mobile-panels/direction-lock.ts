export type DirectionLockDecision = "undecided" | "lock_horizontal" | "release";

// Decide the swipe axis from the first few pixels of a touch. Once the finger has clearly gone
// sideways we keep it sideways, so a thumb drifting vertically later cannot hand the touch to the
// browser's native vertical scroll (which cancels the pointer stream and aborts the swipe).
export function decideDirectionLock(input: {
  deltaX: number;
  deltaY: number;
  slopPx?: number;
  horizontalDominance?: number;
}): DirectionLockDecision {
  const slopPx = input.slopPx ?? 8;
  const horizontalDominance = input.horizontalDominance ?? 1.2;
  const absDx = Math.abs(input.deltaX);
  const absDy = Math.abs(input.deltaY);
  if (Math.max(absDx, absDy) < slopPx) {
    return "undecided";
  }
  return absDx > absDy * horizontalDominance ? "lock_horizontal" : "release";
}
