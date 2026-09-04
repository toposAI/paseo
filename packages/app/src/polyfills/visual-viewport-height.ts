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

  const updateHeight = () => {
    document.documentElement.style.setProperty(
      VISUAL_VIEWPORT_HEIGHT_CSS_PROPERTY,
      `${visualViewport.height}px`,
    );
  };

  // iOS Safari pans its internal visualViewport to bring a focused input
  // into view, which offsets `#root` (fixed to the layout viewport's
  // top-left) upward until the page is scrolled back. Undo that pan
  // whenever the visualViewport moves so the app shell never drifts.
  const resetScroll = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  };

  updateHeight();
  visualViewport.addEventListener("resize", updateHeight);
  visualViewport.addEventListener("scroll", resetScroll);
  window.addEventListener("scroll", resetScroll);
}
