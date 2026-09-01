import { afterEach, describe, expect, it, vi } from "vitest";

import { applyVisualViewportHeight } from "./visual-viewport-height";

describe("applyVisualViewportHeight", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { document?: unknown }).document = originalDocument;
    vi.restoreAllMocks();
  });

  it("does nothing when window.visualViewport is unavailable", () => {
    const setProperty = vi.fn();
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty } },
    };

    applyVisualViewportHeight();

    expect(setProperty).not.toHaveBeenCalled();
  });

  it("sets the CSS variable to the current visualViewport height and updates it on resize", () => {
    const setProperty = vi.fn();
    const listeners: Record<string, () => void> = {};
    const visualViewport = {
      height: 640,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
    };
    (globalThis as { window?: unknown }).window = { visualViewport };
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty } },
    };

    applyVisualViewportHeight();

    expect(setProperty).toHaveBeenCalledWith("--paseo-vvh", "640px");
    expect(visualViewport.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));

    visualViewport.height = 560;
    listeners.resize();

    expect(setProperty).toHaveBeenLastCalledWith("--paseo-vvh", "560px");
  });
});
