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

  it("follows the visualViewport height while typing and drops the variable when not", () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    const activeElement: { tagName: string } = { tagName: "TEXTAREA" };
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
      innerHeight: 900,
      scrollX: 0,
      scrollY: 0,
      scrollTo: vi.fn(),
      addEventListener: windowAddEventListener,
    };
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty, removeProperty } },
      activeElement,
      addEventListener: vi.fn(),
    };

    applyVisualViewportHeight();

    expect(setProperty).toHaveBeenCalledWith("--paseo-vvh", "640px");
    expect(visualViewport.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(visualViewport.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(windowAddEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));

    visualViewport.height = 560;
    listeners.resize();

    expect(setProperty).toHaveBeenLastCalledWith("--paseo-vvh", "560px");

    activeElement.tagName = "DIV";
    listeners.resize();

    expect(removeProperty).toHaveBeenLastCalledWith("--paseo-vvh");
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
      documentElement: { style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
      activeElement: null,
      addEventListener: vi.fn(),
    };

    applyVisualViewportHeight();
    listeners.scroll();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
