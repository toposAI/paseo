// 139番iOSアプリ(Dictation139)のWKWebView内でのみ、ネイティブが
// `dictation139` というメッセージハンドラを注入する。通常のブラウザには無い。
interface Dictation139Bridge {
  postMessage(message: { action: "openRecording" }): void;
}

export function getDictation139Bridge(): Dictation139Bridge | null {
  if (typeof window === "undefined") return null;
  const webkit = (
    window as { webkit?: { messageHandlers?: { dictation139?: Dictation139Bridge } } }
  ).webkit;
  return webkit?.messageHandlers?.dictation139 ?? null;
}

export function openDictation139Recording(): void {
  getDictation139Bridge()?.postMessage({ action: "openRecording" });
}
