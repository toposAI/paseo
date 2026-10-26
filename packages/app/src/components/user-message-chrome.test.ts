import { describe, expect, it } from "vitest";
import {
  isPhoneBrowser,
  resolveUserMessageChrome,
  type UserMessageChromeInput,
  type UserMessageMenuKind,
} from "./user-message-chrome";

const base: UserMessageChromeInput = {
  toposChatStyle: true,
  hasText: true,
  isPending: false,
  isWeb: true,
  isNative: false,
  isCompact: false,
  isHovered: false,
};

/** Every combination of the seven booleans, one bit each. */
function everyCombination(): UserMessageChromeInput[] {
  const inputs: UserMessageChromeInput[] = [];
  for (let mask = 0; mask < 1 << 7; mask += 1) {
    inputs.push({
      toposChatStyle: (mask & (1 << 0)) !== 0,
      hasText: (mask & (1 << 1)) !== 0,
      isPending: (mask & (1 << 2)) !== 0,
      isWeb: (mask & (1 << 3)) !== 0,
      isNative: (mask & (1 << 4)) !== 0,
      isCompact: (mask & (1 << 5)) !== 0,
      isHovered: (mask & (1 << 6)) !== 0,
    });
  }
  return inputs;
}

/** The inline rules this resolver replaced, kept as the drift reference. */
function beforeChange(input: UserMessageChromeInput) {
  let menu: UserMessageMenuKind = "none";
  if (input.toposChatStyle && input.hasText && !input.isPending) {
    menu = input.isCompact || input.isNative ? "long-press" : "context-menu";
  }
  return {
    menu,
    showTrailingRow:
      !input.toposChatStyle &&
      !input.isPending &&
      input.hasText &&
      (input.isCompact || input.isNative || input.isHovered),
    allowRewind: true,
  };
}

describe("resolveUserMessageChrome", () => {
  it("keeps a phone browser bubble unwrapped and shows the trailing row instead", () => {
    expect(resolveUserMessageChrome({ ...base, isCompact: true })).toEqual({
      menu: "none",
      showTrailingRow: true,
      allowRewind: false,
    });
  });

  it("keeps the long-press popup (and rewind) on a native phone", () => {
    expect(
      resolveUserMessageChrome({ ...base, isWeb: false, isNative: true, isCompact: true }),
    ).toEqual({ menu: "long-press", showTrailingRow: false, allowRewind: true });
  });

  it("keeps the right-click menu on desktop web", () => {
    expect(resolveUserMessageChrome(base)).toEqual({
      menu: "context-menu",
      showTrailingRow: false,
      allowRewind: true,
    });
  });

  it("leaves non-Topos messages alone", () => {
    expect(resolveUserMessageChrome({ ...base, toposChatStyle: false, isHovered: true })).toEqual({
      menu: "none",
      showTrailingRow: true,
      allowRewind: true,
    });
    expect(resolveUserMessageChrome({ ...base, toposChatStyle: false, isCompact: true })).toEqual({
      menu: "none",
      showTrailingRow: true,
      allowRewind: true,
    });
  });

  it("hides the menu and the trailing row while a message is pending", () => {
    expect(resolveUserMessageChrome({ ...base, isCompact: true, isPending: true })).toEqual({
      menu: "none",
      showTrailingRow: false,
      allowRewind: false,
    });
  });

  it("hides the trailing row for messages without text", () => {
    expect(resolveUserMessageChrome({ ...base, hasText: false, isCompact: true })).toEqual({
      menu: "none",
      showTrailingRow: false,
      allowRewind: false,
    });
  });

  it("matches the pre-change rules everywhere except the phone browser", () => {
    for (const input of everyCombination()) {
      const chrome = resolveUserMessageChrome(input);
      if (input.toposChatStyle && isPhoneBrowser(input)) {
        // The intended deviation: no wrapper, no rewind, row only when the bubble has text.
        expect(chrome, JSON.stringify(input)).toEqual({
          menu: "none",
          allowRewind: false,
          showTrailingRow: input.hasText && !input.isPending,
        });
        continue;
      }
      expect(chrome, JSON.stringify(input)).toEqual(beforeChange(input));
    }
  });
});
