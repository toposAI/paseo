// 139番iOSアプリ(Dictation139)のWKWebView内でのみ、ネイティブが
// `dictation139` というメッセージハンドラを注入する。通常のブラウザには無い。
interface Dictation139Bridge {
  postMessage(message: { action: "openRecording" | "toggleRecording" }): void;
}

export type Dictation139State = "idle" | "recording" | "sending" | "error";

export function getDictation139Bridge(): Dictation139Bridge | null {
  if (typeof window === "undefined") return null;
  const webkit = (
    window as { webkit?: { messageHandlers?: { dictation139?: Dictation139Bridge } } }
  ).webkit;
  return webkit?.messageHandlers?.dictation139 ?? null;
}

/** 録音画面を開かず、その場で録音の開始/停止を切り替える。 */
export function toggleDictation139Recording(): void {
  getDictation139Bridge()?.postMessage({ action: "toggleRecording" });
}

type Dictation139Event =
  | { type: "state"; state: Dictation139State; message?: string }
  | { type: "result"; text: string };

export function subscribeDictation139(listener: (event: Dictation139Event) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<Dictation139Event>).detail);
  window.addEventListener("dictation139", handler);
  return () => window.removeEventListener("dictation139", handler);
}

/** 文字起こし結果を入力欄のカーソル位置へ挿入する(Reactの状態を通すためexecCommandを使う)。 */
export function insertIntoComposer(text: string): void {
  const el = document.querySelector<HTMLTextAreaElement>(
    '[data-testid="message-input-root"] textarea',
  );
  if (!el) return;
  el.focus();
  document.execCommand("insertText", false, text);
}
