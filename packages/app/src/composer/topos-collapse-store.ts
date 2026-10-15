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
  setCollapsed: (collapsed: boolean) => void;
  reportScrollDistance: (distanceFromBottom: number, nearBottom: boolean) => void;
}

export const useToposComposerCollapse = create<ToposComposerCollapseState>((set) => ({
  collapsed: false,
  setCollapsed: (collapsed) =>
    set((state) => (state.collapsed === collapsed ? state : { collapsed })),
  reportScrollDistance: (distanceFromBottom, nearBottom) =>
    set((state) => {
      if (nearBottom) return state.collapsed ? { collapsed: false } : state;
      if (!state.collapsed && distanceFromBottom > TOPOS_COLLAPSE_DISTANCE_PX) {
        return { collapsed: true };
      }
      return state;
    }),
}));
