import { useEffect } from "react";
import { decideDirectionLock, shouldReleaseLock } from "./direction-lock";

function isInsideHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== root) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

export function attachLeftSwipeDirectionLock(root: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null;
  let state: "undecided" | "locked" | "released" = "released";
  let skipLock = false;

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1) {
      start = null;
      state = "released";
      return;
    }
    start = { x: touch.clientX, y: touch.clientY };
    state = "undecided";
    skipLock = isInsideHorizontalScroller(event.target, root);
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!start || !touch || event.touches.length !== 1 || state === "released") {
      return;
    }
    if (state === "undecided") {
      const deltaX = touch.clientX - start.x;
      const decision = decideDirectionLock({ deltaX, deltaY: touch.clientY - start.y });
      if (decision === "undecided") {
        return;
      }
      state = decision === "lock_horizontal" && deltaX < 0 && !skipLock ? "locked" : "released";
    }
    if (state === "locked" && shouldReleaseLock(touch.clientX - start.x, touch.clientY - start.y)) {
      state = "released";
    }
    if (state === "locked" && event.cancelable) {
      event.preventDefault();
    }
  };
  const onTouchEnd = () => {
    start = null;
    state = "released";
  };

  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: false });
  root.addEventListener("touchend", onTouchEnd, { passive: true });
  root.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", onTouchEnd);
    root.removeEventListener("touchcancel", onTouchEnd);
  };
}

// Mobile web: the panel keeps `touch-action: pan-y` so its lists scroll natively, but iOS then
// cancels the touch as soon as it commits to a vertical scroll. Lock a leftward-horizontal start
// by preventing default on the remaining moves (needs a non-passive listener on the element).
// The host is looked up by id because GestureDetector's web wrapper overrides a child's ref.
export function useWebLeftSwipeDirectionLock(hostId: string, enabled: boolean): void {
  useEffect(() => {
    const root = enabled ? document.getElementById(hostId) : null;
    if (!root) {
      return;
    }
    return attachLeftSwipeDirectionLock(root);
  }, [hostId, enabled]);
}
