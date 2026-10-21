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

/**
 * `claim`は同じ1回のイベントに対して**最初の1呼び出しだけtrue**を返す。
 * composerは複数(分割ペイン・開いたままのタブ)同時にマウントされ、各マイクボタンが
 * 同じ`result`を購読する。全員が挿入すると、同じ文が購読数ぶん入力欄へ重複挿入される
 * (2026-10-21の実害)。結果の挿入は`claim`を取れた1か所だけが行うこと。
 */
export type Dictation139Claim = () => boolean;

export function subscribeDictation139(
  listener: (event: Dictation139Event, claim: Dictation139Claim) => void,
): () => void {
  const handler = (event: Event) => {
    let claimed = claimedEvents.get(event);
    if (!claimed) {
      claimed = { done: false };
      claimedEvents.set(event, claimed);
    }
    const state = claimed;
    listener((event as CustomEvent<Dictation139Event>).detail, () => {
      if (state.done) return false;
      state.done = true;
      return true;
    });
  };
  window.addEventListener("dictation139", handler);
  return () => window.removeEventListener("dictation139", handler);
}

const claimedEvents = new WeakMap<Event, { done: boolean }>();

/**
 * composerの入力欄(可視・編集可のもの)を1つ選ぶ。
 * `querySelector`で先頭一致を掴むと、高さ計測用の隠しtextareaを拾いうるため
 * 「見えていて編集可能」なものだけを対象にする。
 */
function findComposerTextarea(): HTMLTextAreaElement | null {
  const candidates = document.querySelectorAll<HTMLTextAreaElement>(
    '[data-testid="message-input-root"] textarea',
  );
  for (const el of candidates) {
    if (el.disabled || el.readOnly) continue;
    if (el.getClientRects().length === 0) continue;
    return el;
  }
  return null;
}

/**
 * 文字起こし結果を入力欄のカーソル位置へ挿入する(DOM直操作のフォールバック)。
 *
 * **通常はこれを使わない。** composer側の`replaceUserInput`(Reactの状態を通す正規経路)が
 * 使える場合はそちらを優先すること。この実装は
 * `document.execCommand("insertText")` が「その時点でフォーカスされている編集可能要素」に
 * しか効かないことに依存しており、iOS WKWebViewではユーザー操作由来でない`focus()`が
 * 無視されるため、**マイクボタン押下でキーボードが閉じていると無言で何も起きない**
 * (2026-10-21の「録音は始まるが文字が入らない」の主因と推定)。
 *
 * 呼び出し側が失敗を可視化できるよう、**挿入できたかどうかを返す**。
 */
export function insertIntoComposer(text: string): boolean {
  const el = findComposerTextarea();
  if (!el) return false;
  const before = el.value;
  el.focus();
  document.execCommand("insertText", false, text);
  if (el.value !== before) return true;

  // execCommandが効かなかった場合の最後の手段: 値を直接差し替えて`input`を発火する
  // (Reactはinputイベントを拾ってonChangeTextを呼ぶ)。それも駄目ならfalseを返す。
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  const start = el.selectionStart ?? before.length;
  const end = el.selectionEnd ?? start;
  setter.call(el, before.slice(0, start) + text + before.slice(end));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value !== before;
}
