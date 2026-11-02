/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8 },
    borderRadius: { lg: 8 },
    colors: { foreground: "#111", foregroundMuted: "#aaa", surfaceSidebar: "#111" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));

vi.mock("@/utils/desktop-window", () => ({
  WindowChromeSafeArea: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "safe-area" }, children),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { SwitchToToposRow } from "./switch-to-topos-row";

function setBridge(postMessage: ((m: { action: string }) => void) | null) {
  (window as unknown as { webkit?: unknown }).webkit = postMessage
    ? { messageHandlers: { dictation139: { postMessage } } }
    : undefined;
}

describe("SwitchToToposRow", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setBridge(null);
  });

  it("renders nothing outside the 139 app (no bridge)", async () => {
    setBridge(null);
    await act(async () => root.render(<SwitchToToposRow />));
    expect(container.innerHTML).toBe("");
  });

  it("shows only the T button (no close button) and switches app on press", async () => {
    const postMessage = vi.fn();
    setBridge(postMessage);
    await act(async () => root.render(<SwitchToToposRow />));
    expect(container.querySelector('[data-testid="sidebar-close"]')).toBeNull();
    const button = container.querySelector('[data-testid="sidebar-switch-to-topos"]');
    expect(button?.textContent).toBe("T");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(postMessage).toHaveBeenCalledWith({ action: "switchApp" });
  });
});
