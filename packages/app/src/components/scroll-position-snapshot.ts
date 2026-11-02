interface ScrollEntry {
  element: HTMLElement;
  scrollTop: number;
  scrollHeight: number;
}

export type ScrollPositionSnapshot = ScrollEntry[];

function isVerticallyScrollable(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight) return false;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

/** Web only: remembers where every vertically scrollable element in the page is scrolled to. */
export function captureScrollPositions(
  root: ParentNode | null | undefined,
): ScrollPositionSnapshot {
  if (!root) return [];
  const entries: ScrollEntry[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (!isVerticallyScrollable(element)) continue;
    entries.push({
      element,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    });
  }
  return entries;
}

/**
 * Puts scrolled elements back to where they were. Focusing the viewer's comment field can make
 * the browser scroll the chat behind it; a list whose content changed meanwhile is left alone.
 */
export function restoreScrollPositions(snapshot: ScrollPositionSnapshot): void {
  for (const entry of snapshot) {
    const { element } = entry;
    if (!element.isConnected) continue;
    if (element.scrollHeight !== entry.scrollHeight) continue;
    if (element.scrollTop !== entry.scrollTop) element.scrollTop = entry.scrollTop;
  }
}
