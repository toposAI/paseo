import { create } from "zustand";

/**
 * Topos-style composer collapse: while the user reads back through the conversation the
 * composer folds away and a bottom-right chat-bubble button brings it back.
 *
 * Folding the composer grows the scroll viewport, which shrinks the distance from the bottom.
 * A single "near bottom" threshold would then flip straight back and flicker, so the fold uses
 * hysteresis: it needs a clearly-scrolled-up distance to fold, and only the bottom zone unfolds.
 */
export const TOPOS_COLLAPSE_DISTANCE_PX = 400;

interface ToposComposerCollapseState {
  collapsed: boolean;
  /** The user opened the composer by hand while scrolled up; stay open until back at the bottom. */
  pinnedOpen: boolean;
  pinOpen: () => void;
  /** The user minimized the composer by hand; stays folded until reopened with the bubble. */
  userMinimized: boolean;
  minimize: () => void;
  setCollapsed: (collapsed: boolean) => void;
  reportScrollDistance: (distanceFromBottom: number, nearBottom: boolean) => void;
  /** A quoted passage the selection bar wants dropped into the regular composer (phone layout). */
  quoteRequest: { agentId: string; quote: string; nonce: number } | null;
  requestQuote: (agentId: string, quote: string) => void;
  clearQuoteRequest: () => void;
  /** The bubble was tapped: open the composer and raise the keyboard straight away. */
  focusRequest: number;
  requestFocus: () => void;
}

function isTextFieldFocused(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
}

export const useToposComposerCollapse = create<ToposComposerCollapseState>((set) => ({
  collapsed: false,
  pinnedOpen: false,
  pinOpen: () => set({ collapsed: false, pinnedOpen: true, userMinimized: false }),
  userMinimized: false,
  minimize: () => set({ collapsed: true, pinnedOpen: false, userMinimized: true }),
  quoteRequest: null,
  requestQuote: (agentId, quote) =>
    set((state) => ({
      collapsed: false,
      pinnedOpen: true,
      userMinimized: false,
      quoteRequest: { agentId, quote, nonce: (state.quoteRequest?.nonce ?? 0) + 1 },
    })),
  clearQuoteRequest: () => set({ quoteRequest: null }),
  focusRequest: 0,
  requestFocus: () =>
    set((state) => ({
      collapsed: false,
      pinnedOpen: true,
      userMinimized: false,
      focusRequest: state.focusRequest + 1,
    })),
  setCollapsed: (collapsed) =>
    set((state) =>
      state.collapsed === collapsed && (collapsed || !state.pinnedOpen)
        ? state
        : { collapsed, pinnedOpen: false, userMinimized: collapsed ? state.userMinimized : false },
    ),
  reportScrollDistance: (distanceFromBottom, nearBottom) =>
    set((state) => {
      if (state.userMinimized) return state;
      if (nearBottom) {
        return state.collapsed || state.pinnedOpen
          ? { collapsed: false, pinnedOpen: false }
          : state;
      }
      // While typing, the keyboard shrinks the viewport and inflates this distance; folding the
      // composer then would unmount the field and drop the keyboard.
      if (
        !state.collapsed &&
        !state.pinnedOpen &&
        !isTextFieldFocused() &&
        distanceFromBottom > TOPOS_COLLAPSE_DISTANCE_PX
      ) {
        return { collapsed: true };
      }
      return state;
    }),
}));

let warmupInput: HTMLInputElement | null = null;

/**
 * iOS only raises the keyboard for focus() calls made inside the tap itself, but the real composer
 * may be display:none or not yet mounted at that moment. Focus a throwaway input synchronously in
 * the tap to bring the keyboard up; the composer then takes focus and the keyboard stays.
 */
export function openKeyboardWarmup(): void {
  if (typeof document === "undefined" || warmupInput) return;
  const input = document.createElement("input");
  input.setAttribute("aria-hidden", "true");
  input.style.cssText =
    "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;";
  document.body.appendChild(input);
  input.focus();
  warmupInput = input;
  // Safety net: never leave the helper behind if the composer never claims focus.
  setTimeout(closeKeyboardWarmup, 3000);
}

export function closeKeyboardWarmup(): void {
  warmupInput?.remove();
  warmupInput = null;
}
