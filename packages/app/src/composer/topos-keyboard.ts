import { useEffect, useState } from "react";

const KEYBOARD_MIN_SHRINK_PX = 120;

/**
 * True while the software keyboard is up on a phone browser (visualViewport shrinks, the layout
 * viewport does not on iOS Safari). Used to give the chat the whole screen while typing.
 */
export function useToposKeyboardOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!enabled || !viewport) {
      setOpen(false);
      return undefined;
    }
    // The viewport shrink is not reported on every iOS build (home-screen apps, WebViews), so a
    // focused text field counts as "keyboard up" too.
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === "TEXTAREA" ||
          (el.tagName === "INPUT" && el.getAttribute("aria-hidden") !== "true") ||
          el.isContentEditable)
      );
    };
    const update = () => {
      if (window.innerHeight - viewport.height > KEYBOARD_MIN_SHRINK_PX) {
        setOpen(true);
      } else if (!isTyping()) {
        setOpen(false);
      }
    };
    // Hide the header with the focus itself, together with the early #root shrink in
    // polyfills/visual-viewport-height.ts, so the layout settles once instead of jumping later.
    const onFocusIn = () => setTimeout(() => setOpen(isTyping()), 0);
    const onFocusOut = () => setTimeout(update, 0);
    update();
    viewport.addEventListener("resize", update);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      viewport.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [enabled]);
  return open;
}
