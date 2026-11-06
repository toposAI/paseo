/**
 * カードの画像1枚を台帳から引く(`topos.confirmbox.image`)。
 * 画像の持ち主は台帳(events-*.jsonl)の「箱」の行だけ(Vault のノート由来のカードは画像を持てない)。
 * 1枚ごとに台帳全体(数十MB)を読み直さないよう、id → 画像の索引をイベントファイルの
 * 大きさ・更新時刻が変わるまで覚えておく。
 */
import fs from "node:fs";
import path from "node:path";
import { listEventFiles, readConfirmBox } from "./box.js";
import type { ConfirmBoxItem } from "../shared/contract.js";

type Images = NonNullable<ConfirmBoxItem["images"]>;
let memo: { dir: string; sig: string; byId: Map<string, Images> } | null = null;

function signature(dir: string): string {
  return listEventFiles(dir)
    .map((name) => {
      try {
        const st = fs.statSync(path.join(dir, name));
        return `${name}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${name}:?`;
      }
    })
    .join("|");
}

export function readItemImage(dir: string, id: string, index: number): Images[number] | null {
  const sig = signature(dir);
  if (!memo || memo.dir !== dir || memo.sig !== sig) {
    const byId = new Map<string, Images>();
    for (const it of readConfirmBox(dir).items) if (it.images?.length) byId.set(it.id, it.images);
    memo = { dir, sig, byId };
  }
  return memo.byId.get(id)?.[index] ?? null;
}
