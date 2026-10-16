const VISUAL_VIEWPORT_HEIGHT_CSS_PROPERTY = "--paseo-vvh";

/**
 * `#root` in public/index.html resolves its height from `html`/`body`'s
 * `height: 100%`, which iOS Safari sizes against the layout viewport (as if
 * browser chrome were collapsed) rather than the currently visible area.
 * That mismatch shows up as extra blank space at the bottom of the app shell
 * on iOS, both in a normal Safari tab and in a home-screen standalone launch
 * (status bar / home indicator insets). `window.visualViewport` tracks the
 * actually-visible height, so mirror it into a CSS variable `#root` can use.
 */
export function applyVisualViewportHeight() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return;
  }

  // Only follow the visual viewport while a text field is focused (keyboard up). With the keyboard
  // closed, iOS can leave visualViewport.height stuck at the keyboard-up value, which left a blank
  // band under the composer until the app was killed; `100dvh` in index.html is immune to that.
  const isTyping = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
  };
  // iOS reports the keyboard (visualViewport resize) only after its animation, so the composer sits
  // behind the keyboard until then and then pops up. On focus, shrink #root straight away by the
  // last keyboard height we saw (or a typical one) and let the real resize correct it.
  const KEYBOARD_HEIGHT_STORAGE_KEY = "paseo-topos-keyboard-height";
  const GUESS_WINDOW_MS = 1200;
  const SHRINK_MIN_PX = 120;
  let guessUntil = 0;
  const readKeyboardGuess = () => {
    try {
      const saved = Number(window.localStorage.getItem(KEYBOARD_HEIGHT_STORAGE_KEY));
      if (saved > SHRINK_MIN_PX && saved < window.innerHeight * 0.7) return saved;
    } catch {
      // storage unavailable: fall back to the typical size
    }
    return Math.round(window.innerHeight * 0.42);
  };
  const updateHeight = () => {
    const root = document.documentElement.style;
    if (!isTyping()) {
      root.removeProperty(VISUAL_VIEWPORT_HEIGHT_CSS_PROPERTY);
      return;
    }
    const shrink = window.innerHeight - visualViewport.height;
    if (shrink > SHRINK_MIN_PX) {
      guessUntil = 0;
      root.setProperty(VISUAL_VIEWPORT_HEIGHT_CSS_PROPERTY, `${visualViewport.height}px`);
      try {
        window.localStorage.setItem(KEYBOARD_HEIGHT_STORAGE_KEY, String(Math.round(shrink)));
      } catch {
        // ignore
      }
    } else if (Date.now() >= guessUntil) {
      // No keyboard reported (hardware keyboard, desktop): follow the viewport as it is.
      root.setProperty(VISUAL_VIEWPORT_HEIGHT_CSS_PROPERTY, `${visualViewport.height}px`);
    }
  };
  document.addEventListener("focusin", () => {
    if (!isTyping() || window.innerHeight - visualViewport.height > SHRINK_MIN_PX) return;
    // Only phones: a coarse pointer means a software keyboard is about to appear.
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;
    guessUntil = Date.now() + GUESS_WINDOW_MS;
    document.documentElement.style.setProperty(
      VISUAL_VIEWPORT_HEIGHT_CSS_PROPERTY,
      `${window.innerHeight - readKeyboardGuess()}px`,
    );
    setTimeout(updateHeight, GUESS_WINDOW_MS + 20);
  });

  // iOS Safari pans its internal visualViewport to bring a focused input
  // into view, which offsets `#root` (fixed to the layout viewport's
  // top-left) upward until the page is scrolled back. Undo that pan
  // whenever the visualViewport moves so the app shell never drifts.
  let lastFocusIn = 0;
  document.addEventListener("focusin", () => {
    lastFocusIn = Date.now();
    // Undo the pan once iOS has finished scrolling the field into view.
    setTimeout(() => resetScroll(), 700);
  });
  const resetScroll = () => {
    // Fighting iOS's own scroll while the keyboard is opening makes it dismiss the keyboard again.
    if (Date.now() - lastFocusIn < 600) {
      return;
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  };

  updateHeight();
  visualViewport.addEventListener("resize", updateHeight);
  visualViewport.addEventListener("scroll", resetScroll);
  window.addEventListener("scroll", resetScroll);

  // iOS sometimes skips the final visualViewport resize after the keyboard closes, leaving the
  // variable at the keyboard-up height (blank band under the composer until the app is killed).
  // Re-sync a few times after focus leaves a field, and when the page becomes visible again.
  const resyncAfterKeyboard = () => {
    for (const delay of [0, 120, 350, 800]) {
      setTimeout(() => {
        updateHeight();
        resetScroll();
      }, delay);
    }
  };
  document.addEventListener("focusout", resyncAfterKeyboard);
  window.addEventListener("resize", updateHeight);
  window.addEventListener("pageshow", resyncAfterKeyboard);
  document.addEventListener("visibilitychange", resyncAfterKeyboard);
}
