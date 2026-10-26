export type UserMessageMenuKind = "none" | "long-press" | "context-menu";

export interface UserMessageChromeInput {
  toposChatStyle: boolean;
  hasText: boolean;
  isPending: boolean;
  isWeb: boolean;
  isNative: boolean;
  isCompact: boolean;
  isHovered: boolean;
}

export interface UserMessageChrome {
  menu: UserMessageMenuKind;
  showTrailingRow: boolean;
  /**
   * Whether the rewind control may be rendered. Independent of `showTrailingRow`: a hidden row
   * still renders its children. Rewind rewrites the conversation (and optionally the files) as
   * soon as a mode is picked, with no confirmation step, and the long-press popup never offered
   * it — so a phone browser does not get it back just because the trailing row is visible there.
   */
  allowRewind: boolean;
}

/**
 * Phone browsers get no bubble wrapper at all.
 *
 * react-native-web renders a `Pressable` with an accessibility role as a real `<button>`,
 * and WebKit refuses to select text inside buttons (`user-select: text` has no effect
 * there). The 450 ms long-press popup would also open before iOS' native selection UI and
 * take the selection away. So on a phone browser the bubble stays plain, and the trailing
 * row (time + copy, but not the destructive rewind) stays visible instead of the long-press
 * menu. Landscape phones and tablets in a browser are wider than the compact breakpoint, so
 * they keep the desktop context menu — a plain `<div>` that does not block selection.
 */
export function isPhoneBrowser(input: { isWeb: boolean; isCompact: boolean }): boolean {
  return input.isWeb && input.isCompact;
}

export function resolveUserMessageChrome(input: UserMessageChromeInput): UserMessageChrome {
  const phoneBrowser = isPhoneBrowser(input);
  const showTrailingRow =
    (!input.toposChatStyle || phoneBrowser) &&
    !input.isPending &&
    input.hasText &&
    (input.isCompact || input.isNative || input.isHovered);
  const allowRewind = !(input.toposChatStyle && phoneBrowser);

  if (!input.toposChatStyle || !input.hasText || input.isPending) {
    return { menu: "none", showTrailingRow, allowRewind };
  }
  if (phoneBrowser) {
    return { menu: "none", showTrailingRow, allowRewind };
  }
  return {
    menu: input.isCompact || input.isNative ? "long-press" : "context-menu",
    showTrailingRow,
    allowRewind,
  };
}
