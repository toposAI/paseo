/**
 * 右ペインの入力欄の補助(Web専用)。プラグインは app 内部の dictation / attachments を import
 * できないため、ブラウザ標準APIと、139番アプリが注入する橋だけで最小限を作る。
 * - 音声入力: ①139番アプリの WKWebView なら本体と同じ `dictation139` ブリッジ(ネイティブ録音)
 *   ②無ければ Web Speech API(ja-JP)。
 *   どちらも無い環境でも**ボタンは消さない**(押すと理由を出す)。2026-11-07 ユーザー指摘2回目
 *   「確認箱のチャット欄もメインのチャット欄と同じ構造にして。マイクないし音声入力できない」
 *   — 以前は `micSupported=false` でボタンごと隠していたため iPhone では最初から出なかった。
 * - 添付: 画像のみ(`agents.ref(id).send(text, { images })` で送れる種類だけ)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

export interface PaneImage {
  data: string; // base64(接頭辞なし)
  mimeType: string;
  name: string;
  id: string;
}

/** 139番アプリ(Dictation139)の WKWebView にだけ注入されるネイティブの橋。通常のブラウザには無い。 */
interface Dictation139Bridge {
  postMessage(message: { action: "toggleRecording" }): void;
}

type Dictation139Event =
  | { type: "state"; state: "idle" | "recording" | "sending" | "error"; message?: string }
  | { type: "result"; text: string };

function dictation139Bridge(): Dictation139Bridge | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const webkit = (
    window as unknown as { webkit?: { messageHandlers?: { dictation139?: Dictation139Bridge } } }
  ).webkit;
  return webkit?.messageHandlers?.dictation139 ?? null;
}

const IMAGES_MAX = 4;
const IMAGE_BYTES_MAX = 5 * 1024 * 1024;
const IMAGES_TOTAL_BYTES_MAX = 12 * 1024 * 1024;

let imageSeq = 0;

interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  addEventListener(
    type: "result",
    cb: (ev: { resultIndex: number; results: ArrayLike<SpeechResultLike> }) => void,
  ): void;
  addEventListener(type: "end" | "error", cb: () => void): void;
  start: () => void;
  stop: () => void;
}

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  if (Platform.OS !== "web") return null;
  const g = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

function readImage(file: File, done: (img: PaneImage) => void): void {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const url = String(reader.result ?? "");
    done({
      data: url.slice(url.indexOf(",") + 1),
      mimeType: file.type,
      name: file.name,
      id: `img${(imageSeq += 1)}-${file.name}-${file.size}-${file.lastModified}`,
    });
  });
  reader.readAsDataURL(file);
}

export function usePaneInputTools(onDictated: (text: string) => void) {
  // マイクは常に出す(消すと「無い」と言われる)。押せない環境では押した時に理由を出す。
  const micSupported = true;
  const micAvailable = dictation139Bridge() !== null || speechCtor() !== null;
  const attachSupported = Platform.OS === "web" && typeof document !== "undefined";
  const [listening, setListening] = useState(false);
  const [images, setImages] = useState<PaneImage[]>([]);
  const [toolNotice, setToolNotice] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // この入力欄のマイクから録音を始めた時だけ、139ブリッジの結果を引き取る。
  // (本体の composer も同じ結果を購読しているため、無条件に拾うと本文が二重に入る)
  const expectingRef = useRef(false);
  const onDictatedRef = useRef(onDictated);
  onDictatedRef.current = onDictated;

  useEffect(
    () => () => {
      recRef.current?.stop();
      recRef.current = null;
    },
    [],
  );

  // 139番アプリ内: 録音の開始/停止と結果はネイティブから CustomEvent で届く(本体の composer と同じ契約)。
  useEffect(() => {
    if (dictation139Bridge() === null || typeof window === "undefined") return;
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<Dictation139Event>).detail;
      if (!detail) return;
      if (detail.type === "state") {
        setListening(detail.state === "recording" || detail.state === "sending");
        if (detail.state === "error") {
          expectingRef.current = false;
          setToolNotice(detail.message ?? "音声入力を開始できませんでした");
        }
        if (detail.state === "idle") expectingRef.current = false;
        return;
      }
      if (detail.type === "result" && expectingRef.current) {
        expectingRef.current = false;
        setListening(false);
        if (detail.text) onDictatedRef.current(detail.text);
      }
    };
    window.addEventListener("dictation139", onEvent);
    return () => window.removeEventListener("dictation139", onEvent);
  }, []);

  const toggleMic = useCallback(() => {
    const bridge = dictation139Bridge();
    if (bridge) {
      // ネイティブの録音を開始/停止する。状態と結果は上の購読で受ける。
      expectingRef.current = !listening;
      setToolNotice("");
      setListening(!listening);
      // WKWebView の messageHandler は window.postMessage と違い targetOrigin を取らない(1引数)。
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      bridge.postMessage({ action: "toggleRecording" });
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) {
      setToolNotice(
        "この環境では音声入力が使えません(139番アプリから開くか、マイク対応ブラウザでお試しください)",
      );
      return;
    }
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = "ja-JP";
    rec.continuous = false;
    rec.interimResults = false;
    rec.addEventListener("result", (ev) => {
      let said = "";
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        if (r?.isFinal) said += r[0].transcript;
      }
      if (said) onDictatedRef.current(said);
    });
    rec.addEventListener("error", () =>
      setToolNotice("音声入力が使えませんでした(マイクの許可を確認してください)"),
    );
    rec.addEventListener("end", () => {
      recRef.current = null;
      setListening(false);
    });
    recRef.current = rec;
    setToolNotice("");
    setListening(true);
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, [listening]);

  const addImage = useCallback((img: PaneImage) => {
    setImages((cur) => {
      if (cur.length >= IMAGES_MAX) return cur;
      // base64 は元の 4/3 倍。合計がこれを超えると RPC/送信が重くなるので足さない。
      const total = cur.reduce((n, i) => n + i.data.length, 0) + img.data.length;
      if (total > (IMAGES_TOTAL_BYTES_MAX * 4) / 3) {
        setToolNotice("添付が大きすぎます(合計12MBまで)");
        return cur;
      }
      return [...cur, img];
    });
  }, []);
  const pickImages = useCallback(() => {
    if (!attachSupported) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > IMAGE_BYTES_MAX) {
          setToolNotice(`${file.name} は大きすぎます(5MBまで)`);
          continue;
        }
        readImage(file, addImage);
      }
    });
    input.click();
  }, [attachSupported, addImage]);

  const removeImage = useCallback((id: string) => {
    setImages((cur) => cur.filter((i) => i.id !== id));
  }, []);
  const clearImages = useCallback(() => setImages([]), []);
  /** 送信に失敗した時に、添付を元へ戻す(新しく足された分があればそれを優先して残す)。 */
  const restoreImages = useCallback(
    (imgs: PaneImage[]) => setImages((cur) => (cur.length > 0 ? cur : imgs)),
    [],
  );
  /** カード/スレを切り替えた時に、添付・音声入力・通知を空に戻す。 */
  const resetTools = useCallback(() => {
    recRef.current?.stop();
    expectingRef.current = false;
    setListening(false);
    setImages([]);
    setToolNotice("");
  }, []);

  return {
    micSupported,
    micAvailable,
    attachSupported,
    listening,
    toggleMic,
    images,
    pickImages,
    removeImage,
    clearImages,
    restoreImages,
    resetTools,
    toolNotice,
  };
}
