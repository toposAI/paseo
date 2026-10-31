import { useEffect } from "react";

/**
 * dnd-kit はドラッグ開始時に document へ capture の click 抑止を付け、終了/キャンセルでしか外さない。
 * mouseup を取り逃す(画面外で離す、フォーカスを失う等)とドラッグが終わらず、以後のクリックが
 * 全部止まって再読み込みまで直らない。そうなったときだけ Escape を送って dnd-kit 自身にキャンセルさせる。
 */
const RELEASE_GRACE_MS = 250;

export function armDragStuckGuard(win: Window, doc: Document): () => void {
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelDrag = () => {
    doc.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Escape",
        key: "Escape",
        bubbles: true,
      }),
    );
  };
  const clearReleaseTimer = () => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };
  const handleBlur = () => cancelDrag();
  const handleMove = (event: MouseEvent) => {
    // ボタンが離れているのに移動が来る = mouseup を取り逃した。
    if (event.buttons === 0) cancelDrag();
  };
  const handleRelease = () => {
    // 正常なら dnd-kit が先に終了させ、この effect ごと解除される。残っていたら取り逃し。
    clearReleaseTimer();
    releaseTimer = setTimeout(cancelDrag, RELEASE_GRACE_MS);
  };

  win.addEventListener("blur", handleBlur);
  win.addEventListener("mousemove", handleMove, true);
  win.addEventListener("mouseup", handleRelease, true);
  win.addEventListener("pointerup", handleRelease, true);
  return () => {
    clearReleaseTimer();
    win.removeEventListener("blur", handleBlur);
    win.removeEventListener("mousemove", handleMove, true);
    win.removeEventListener("mouseup", handleRelease, true);
    win.removeEventListener("pointerup", handleRelease, true);
  };
}

export function useDragStuckGuard(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    return armDragStuckGuard(window, document);
  }, [active]);
}
