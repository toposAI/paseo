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
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const clearFocusTimer = () => {
      if (focusTimer) {
        clearTimeout(focusTimer);
        focusTimer = null;
      }
    };
    const update = () => {
      if (window.innerHeight - viewport.height > KEYBOARD_MIN_SHRINK_PX) {
        clearFocusTimer();
        setOpen(true);
      } else if (!isTyping()) {
        clearFocusTimer();
        setOpen(false);
      }
    };
    // Unmounting the header the instant a field gets focus shifts the layout while iOS is still
    // opening the keyboard, which can make it close again. So a plain focus only counts as
    // "keyboard up" after the keyboard animation has had time to finish.
    const onFocusIn = () => {
      clearFocusTimer();
      focusTimer = setTimeout(() => {
        focusTimer = null;
        setOpen(isTyping());
      }, 700);
    };
    const onFocusOut = () => setTimeout(update, 0);
    update();
    viewport.addEventListener("resize", update);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      clearFocusTimer();
      viewport.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [enabled]);
  return open;
}
