/**
 * 添付ファイルの選択(Web専用)。プラグインは app 内部の添付部品を import できないため、
 * 確認箱のチャット(usePaneInputTools)と同じく、ブラウザ標準の `<input type="file">` を使う。
 * 上限(1件の大きさ・件数)は Topos の config(attach_limits)。使えない環境では `supported=false`。
 */
import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";
import { checkAttachAdd, formatBytes, type PickedFile } from "../../shared/shared-projects-api.js";

export interface PickedItem extends PickedFile {
  key: string;
  /** 画像のときのプレビュー用データURL(画像以外は空)。 */
  preview: string;
}

interface Limits {
  maxBytes: number;
  maxCount: number;
}

let seq = 0;

function readFile(file: File): Promise<PickedItem> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const url = String(reader.result ?? "");
      const isImage = file.type.startsWith("image/");
      resolve({
        key: `f${(seq += 1)}-${file.name}-${file.size}`,
        filename: file.name,
        mime_type: file.type || "application/octet-stream",
        data_base64: url.slice(url.indexOf(",") + 1),
        size: file.size,
        preview: isImage ? url : "",
      });
    });
    reader.addEventListener("error", () => reject(new Error(`${file.name} を読めません`)));
    reader.readAsDataURL(file);
  });
}

/** 選んだファイルを、上限を守れるものだけ足す。守れないものは理由を返す(最後の1件分)。 */
async function addFiles(
  files: readonly File[],
  current: readonly PickedItem[],
  limits: Limits,
): Promise<{ items: PickedItem[]; notice: string }> {
  const next = [...current];
  let notice = "";
  for (const file of files) {
    const problem = checkAttachAdd(next, file.size, limits);
    if (problem) {
      notice = `${file.name}: ${problem}(上限 ${limits.maxBytes > 0 ? formatBytes(limits.maxBytes) : "-"})`;
      continue;
    }
    try {
      next.push(await readFile(file));
    } catch (e) {
      notice = e instanceof Error ? e.message : "読み込めませんでした";
    }
  }
  return { items: next, notice };
}

export function usePickFiles(limits: Limits) {
  const supported = Platform.OS === "web" && typeof document !== "undefined";
  const [items, setItems] = useState<PickedItem[]>([]);
  const [notice, setNotice] = useState("");
  const itemsRef = useRef<PickedItem[]>([]);
  const { maxBytes, maxCount } = limits;

  const apply = useCallback((next: PickedItem[], msg: string) => {
    itemsRef.current = next;
    setItems(next);
    setNotice(msg);
  }, []);

  const onChosen = useCallback(
    async (files: File[]) => {
      const r = await addFiles(files, itemsRef.current, { maxBytes, maxCount });
      apply(r.items, r.notice);
    },
    [maxBytes, maxCount, apply],
  );

  const pick = useCallback(
    (accept: string) => {
      if (!supported) return;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.multiple = true;
      input.addEventListener("change", () => void onChosen(Array.from(input.files ?? [])));
      input.click();
    },
    [supported, onChosen],
  );

  const pickImages = useCallback(() => pick("image/*"), [pick]);
  const pickAny = useCallback(() => pick("*/*"), [pick]);
  const remove = useCallback(
    (key: string) =>
      apply(
        itemsRef.current.filter((i) => i.key !== key),
        "",
      ),
    [apply],
  );
  const clear = useCallback(() => apply([], ""), [apply]);

  return { supported, items, notice, pickImages, pickAny, remove, clear };
}
