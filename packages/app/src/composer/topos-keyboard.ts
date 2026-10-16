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
    const update = () => setOpen(window.innerHeight - viewport.height > KEYBOARD_MIN_SHRINK_PX);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, [enabled]);
  return open;
}
