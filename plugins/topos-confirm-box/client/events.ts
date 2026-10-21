/** 決定・承認の直後にサイドバーのバッジを即時更新するための最小の通知。 */
const listeners = new Set<() => void>();

export function onBoxChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyBoxChanged(): void {
  for (const fn of listeners) fn();
}
