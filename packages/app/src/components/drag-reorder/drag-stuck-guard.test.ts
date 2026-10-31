/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armDragStuckGuard } from "./drag-stuck-guard";

let escapes = 0;
const onKeydown = (event: KeyboardEvent) => {
  if (event.code === "Escape") escapes += 1;
};

beforeEach(() => {
  vi.useFakeTimers();
  escapes = 0;
  document.addEventListener("keydown", onKeydown);
});

afterEach(() => {
  document.removeEventListener("keydown", onKeydown);
  vi.useRealTimers();
});

describe("armDragStuckGuard", () => {
  it("cancels when the window loses focus mid-drag", () => {
    const disarm = armDragStuckGuard(window, document);
    window.dispatchEvent(new Event("blur"));
    expect(escapes).toBe(1);
    disarm();
  });

  it("cancels when a mouse move arrives with no button held (mouseup was lost)", () => {
    const disarm = armDragStuckGuard(window, document);
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 }));
    expect(escapes).toBe(0);
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
    expect(escapes).toBe(1);
    disarm();
  });

  it("cancels only if the drag is still armed shortly after a release", () => {
    const disarm = armDragStuckGuard(window, document);
    window.dispatchEvent(new MouseEvent("mouseup"));
    vi.advanceTimersByTime(300);
    expect(escapes).toBe(1);
    disarm();
  });

  it("does nothing after dnd-kit ended the drag normally (disarmed before the grace period)", () => {
    const disarm = armDragStuckGuard(window, document);
    window.dispatchEvent(new MouseEvent("mouseup"));
    disarm();
    vi.advanceTimersByTime(300);
    window.dispatchEvent(new Event("blur"));
    expect(escapes).toBe(0);
  });

  it("sends Escape only once per drag", () => {
    const disarm = armDragStuckGuard(window, document);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
    expect(escapes).toBe(1);
    disarm();
  });
});
