// @vitest-environment jsdom
import "@/test/window-local-storage";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The vitest JSX transform here is classic; source files rely on a global React.
Object.assign(globalThis, { React });

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: (select: (s: { toposChatStyle: boolean }) => unknown) =>
    select({ toposChatStyle: true }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => ({}) }));
vi.mock("@/composer/actions", () => ({ dispatchComposerAgentMessage: vi.fn() }));
vi.mock("@/composer/topos-collapse-store", () => ({
  openKeyboardWarmup: vi.fn(),
  useToposComposerCollapse: { getState: () => ({ requestQuote: vi.fn() }) },
}));
vi.mock("@/composer/submission/writer", () => ({ createMessageSubmissionWriter: vi.fn() }));
vi.mock("@/composer/attachments/submit", () => ({
  resolveComposerAttachmentSubmitFormat: vi.fn(),
}));
vi.mock("@/utils/encode-images", () => ({ encodeImages: vi.fn() }));

import { ToposSelectionActions } from "./selection-actions.web";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function selectText(id: string) {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById(id)!);
  range.getBoundingClientRect = () =>
    ({ top: 300, bottom: 320, left: 100, right: 200, width: 100, height: 20 }) as DOMRect;
  Object.assign(Range.prototype, { getClientRects: () => [] });
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return new Promise((resolve) => setTimeout(resolve, 400));
}

describe("ToposSelectionActions", () => {
  it("shows the selection bar under document.body, not inside the stacked chat pane", async () => {
    const { container } = render(
      <div>
        <div data-testid="agent-chat-scroll">
          <p id="text">選択するための本文です</p>
        </div>
        <ToposSelectionActions serverId="s" agentId="a" />
      </div>,
    );
    await selectText("text");

    const bar = document.querySelector('[data-testid="topos-selection-bar"]');
    expect(bar).not.toBeNull();
    expect(container.contains(bar)).toBe(false);
    expect(bar!.parentElement).toBe(document.body);
  });

  it("opens the comment card under document.body too", async () => {
    const { container, getByTestId } = render(
      <div>
        <div data-testid="agent-chat-scroll">
          <p id="text">選択するための本文です</p>
        </div>
        <ToposSelectionActions serverId="s" agentId="a" />
      </div>,
    );
    await selectText("text");
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    await act(async () => {
      fireEvent.click(getByTestId("topos-selection-comment-button"));
    });
    const card = document.querySelector('[data-testid="topos-selection-comment"]');
    expect(card).not.toBeNull();
    expect(container.contains(card)).toBe(false);
    expect(card!.parentElement).toBe(document.body);
  });

  it("only the pane that owns the selection shows a bar when other panes stay mounted", async () => {
    render(
      <>
        <div data-testid="pane-a">
          <div data-testid="agent-chat-scroll">
            <p id="a">一つ目のペイン</p>
          </div>
          <ToposSelectionActions serverId="s" agentId="a" />
        </div>
        <div data-testid="pane-b" hidden>
          <div data-testid="agent-chat-scroll">
            <p id="b">二つ目のペイン</p>
          </div>
          <ToposSelectionActions serverId="s" agentId="b" />
        </div>
      </>,
    );
    await selectText("a");
    expect(document.querySelectorAll('[data-testid="topos-selection-bar"]')).toHaveLength(1);
  });
});
