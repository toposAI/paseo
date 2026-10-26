/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { UserMessageBubbleFrame } from "./user-message-bubble-frame";
import type { UserMessageMenuKind } from "./user-message-chrome";

// The clipboard chain pulls expo-clipboard, whose JSX-in-.js build the browser dep optimizer
// cannot parse. The menu's DOM shape is what matters here, not the copy implementation.
vi.mock("@/utils/rich-clipboard", () => ({ writeMarkdownToRichClipboard: vi.fn() }));
vi.mock("@/utils/rich-clipboard-default-environment", () => ({
  getDefaultMarkdownClipboardEnvironment: () => ({}),
}));

void testI18n;

beforeEach(() => vi.stubGlobal("React", React));

/**
 * iPhone Safari refuses to select text inside a `<button>`, and react-native-web renders a
 * Pressable with an accessibility role as one. The first test documents that mechanism; the
 * second pins the phone-browser choice: the bubble is left plain so long-press reaches iOS'
 * native selection UI.
 */

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const getContent = () => "本文";
const onResend = () => undefined;

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountBubble(menu: UserMessageMenuKind) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <UserMessageBubbleFrame
        menu={menu}
        getContent={getContent}
        timestampLabel="20:00"
        onResend={onResend}
      >
        <Text selectable testID="bubble-text">
          本文
        </Text>
      </UserMessageBubbleFrame>,
    ),
  );
  mounted.push({ root, container });
  const text = container.querySelector<HTMLElement>('[data-testid="bubble-text"]');
  if (!text) throw new Error("bubble text not found");
  return { container, text };
}

describe("UserMessageBubbleFrame", () => {
  it("renders the long-press wrapper as a button, which WebKit cannot select text in", () => {
    const { container, text } = mountBubble("long-press");

    const wrapper = container.querySelector('[data-testid="topos-user-message-press"]');
    expect(wrapper?.tagName).toBe("BUTTON");
    expect(text.closest("button")).not.toBeNull();
  });

  it("keeps the desktop context menu wrapper out of the text's button ancestry", () => {
    const { container, text } = mountBubble("context-menu");

    expect(container.querySelector('[data-testid="topos-user-message-press"]')).toBeNull();
    expect(text.closest("button")).toBeNull();
  });

  it("leaves the bubble plain when the menu is off, so the text stays selectable", () => {
    const { container, text } = mountBubble("none");

    expect(container.querySelector('[data-testid="topos-user-message-press"]')).toBeNull();
    expect(text.closest("button")).toBeNull();
    expect(getComputedStyle(text).userSelect).toBe("text");
  });
});
