/**
 * 右ペインの入力欄の補助(Web専用)。プラグインは app 内部の dictation / attachments を import
 * できないため、ブラウザ標準APIで最小限だけ作る。使えない環境ではボタン自体を出さない。
 * - 音声入力: Web Speech API(ja-JP)。非対応(一部の WKWebView 等)なら `micSupported=false`。
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
  const micSupported = speechCtor() !== null;
  const attachSupported = Platform.OS === "web" && typeof document !== "undefined";
  const [listening, setListening] = useState(false);
  const [images, setImages] = useState<PaneImage[]>([]);
  const [toolNotice, setToolNotice] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onDictatedRef = useRef(onDictated);
  onDictatedRef.current = onDictated;

  useEffect(
    () => () => {
      recRef.current?.stop();
      recRef.current = null;
    },
    [],
  );

  const toggleMic = useCallback(() => {
    const Ctor = speechCtor();
    if (!Ctor) return;
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
  }, []);

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
    setImages([]);
    setToolNotice("");
  }, []);

  return {
    micSupported,
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
