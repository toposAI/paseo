const DEBUG_STORAGE_KEY = "paseo-topos-kbdebug";
const MAX_LOG_LINES = 8;

/**
 * On-screen keyboard diagnostics for iPhone. Currently on by default (temporary); `?kbdebug=0` turns it off and `?kbdebug=1` back on.
 */
export function installToposKeyboardDebug(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const viewport = window.visualViewport;
  if (!viewport) return;
  try {
    const flag = new URLSearchParams(window.location.search).get("kbdebug");
    if (flag === "1") window.localStorage.setItem(DEBUG_STORAGE_KEY, "1");
    if (flag === "0") window.localStorage.setItem(DEBUG_STORAGE_KEY, "0");
    // TEMPORARY: on by default while the iPhone home-screen app (no URL bar, so no ?kbdebug=1) is
    // being investigated. Flip back to `!== "1"` once the diagnosis is done.
    if (window.localStorage.getItem(DEBUG_STORAGE_KEY) === "0") return;
  } catch {
    return;
  }

  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;padding:2px 4px;" +
    "font:10px/1.25 ui-monospace,Menlo,monospace;color:#0f0;background:rgba(0,0,0,0.72);" +
    "white-space:pre;max-width:100vw;";
  document.body.appendChild(box);

  const startedAt = Date.now();
  const lines: string[] = [];
  const log = (label: string) => {
    lines.push(`${((Date.now() - startedAt) / 1000).toFixed(2)} ${label}`);
    if (lines.length > MAX_LOG_LINES) lines.shift();
  };
  const render = () => {
    const el = document.activeElement as HTMLElement | null;
    const vvh = document.documentElement.style.getPropertyValue("--paseo-vvh") || "-";
    box.textContent =
      `inner ${window.innerHeight} vv ${viewport.height.toFixed(0)} top ${viewport.offsetTop.toFixed(0)}\n` +
      `scrollY ${window.scrollY.toFixed(0)} vvh ${vvh} tf ${document.getElementById("root")?.style.transform || "-"} act ${el?.tagName ?? "-"}\n` +
      lines.join("\n");
  };
  const on = (target: EventTarget, type: string, label: string, capture = true) => {
    target.addEventListener(
      type,
      () => {
        log(
          `${label} top${viewport.offsetTop.toFixed(0)} h${viewport.height.toFixed(0)} y${window.scrollY.toFixed(0)}`,
        );
        render();
      },
      { capture, passive: true },
    );
  };
  on(document, "touchstart", "touchstart");
  on(document, "touchend", "touchend");
  on(document, "focusin", "focusin");
  on(document, "focusout", "focusout");
  on(viewport, "resize", "vv.resize", false);
  on(viewport, "scroll", "vv.scroll", false);
  on(window, "scroll", "win.scroll", false);
  setInterval(render, 200);
  render();
}
