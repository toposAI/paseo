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
    const windowAddEventListener = vi.fn();
    (globalThis as { window?: unknown }).window = {
      visualViewport,
      scrollX: 0,
      scrollY: 0,
      scrollTo: vi.fn(),
      addEventListener: windowAddEventListener,
    };
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty } },
    };

    applyVisualViewportHeight();

    expect(setProperty).toHaveBeenCalledWith("--paseo-vvh", "640px");
    expect(visualViewport.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(visualViewport.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(windowAddEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));

    visualViewport.height = 560;
    listeners.resize();

    expect(setProperty).toHaveBeenLastCalledWith("--paseo-vvh", "560px");
  });

  it("scrolls the window back to origin when the visualViewport pans", () => {
    const listeners: Record<string, () => void> = {};
    const visualViewport = {
      height: 640,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
    };
    const scrollTo = vi.fn();
    (globalThis as { window?: unknown }).window = {
      visualViewport,
      scrollX: 0,
      scrollY: 120,
      scrollTo,
      addEventListener: vi.fn(),
    };
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty: vi.fn() } },
    };

    applyVisualViewportHeight();
    listeners.scroll();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
