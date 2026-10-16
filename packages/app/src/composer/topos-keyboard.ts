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
    const update = () =>
      setOpen(window.innerHeight - viewport.height > KEYBOARD_MIN_SHRINK_PX || isTyping());
    const onFocusChange = () => setTimeout(update, 0);
    update();
    viewport.addEventListener("resize", update);
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    return () => {
      viewport.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
    };
  }, [enabled]);
  return open;
}
