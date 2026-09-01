import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

// No `viewport-fit=cover`: see the comment on the viewport meta tag in
// public/index.html for why (it inflates env(safe-area-inset-*) into a
// visible bottom gap on every screen).
const COMPACT_WEB_VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
const DEFAULT_WEB_VIEWPORT_CONTENT = "width=device-width, initial-scale=1";

export function useCompactWebViewportZoomLock(isCompactLayout: boolean) {
  useEffect(() => {
    if (!isWeb) {
      return;
    }

    const viewportMeta =
      document.querySelector<HTMLMetaElement>('meta[name="viewport"]') ??
      document.createElement("meta");
    const hadViewportMeta = viewportMeta.parentElement !== null;
    const previousContent = viewportMeta.getAttribute("content");

    if (!hadViewportMeta) {
      viewportMeta.name = "viewport";
      document.head.appendChild(viewportMeta);
    }

    viewportMeta.setAttribute(
      "content",
      isCompactLayout ? COMPACT_WEB_VIEWPORT_CONTENT : DEFAULT_WEB_VIEWPORT_CONTENT,
    );

    return () => {
      if (!hadViewportMeta) {
        viewportMeta.remove();
        return;
      }
      if (previousContent !== null) {
        viewportMeta.setAttribute("content", previousContent);
      }
    };
  }, [isCompactLayout]);
}
