import { create } from "zustand";

/**
 * Topos-style composer collapse: while the user reads back through the conversation the
 * composer folds away and a bottom-right chat-bubble button brings it back.
 */
interface ToposComposerCollapseState {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

export const useToposComposerCollapse = create<ToposComposerCollapseState>((set) => ({
  collapsed: false,
  setCollapsed: (collapsed) =>
    set((state) => (state.collapsed === collapsed ? state : { collapsed })),
}));
