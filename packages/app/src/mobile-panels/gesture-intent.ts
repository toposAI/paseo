export type MobilePanelGestureDirection = -1 | 1;
export type MobilePanelGestureIntent = "activate" | "fail" | "wait";

export function resolveMobilePanelGestureIntent(input: {
  deltaX: number;
  deltaY: number;
  direction: MobilePanelGestureDirection;
  openGesturesBlocked: boolean;
}): MobilePanelGestureIntent {
  "worklet";
  if (input.openGesturesBlocked) {
    return "fail";
  }
  const directedDelta = input.deltaX * input.direction;
  const absDeltaX = Math.abs(input.deltaX);
  const absDeltaY = Math.abs(input.deltaY);
  // Edge swipes by thumb drift vertically at the start; only bail out once the motion is
  // clearly vertical, and activate as soon as it is mostly horizontal.
  if (directedDelta <= -24 || (absDeltaY > 28 && absDeltaY > absDeltaX * 1.5)) {
    return "fail";
  }
  if (directedDelta >= 12 && absDeltaX * 1.25 > absDeltaY) {
    return "activate";
  }
  return "wait";
}
