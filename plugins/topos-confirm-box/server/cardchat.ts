/**
 * カード単位のチャット。確認箱ディレクトリ配下の2ファイルで持つ(追記のみ):
 *
 * - `card_chat_requests.jsonl` … 質問 `{ts,key,text}`(返信ワーカーが読む)
 * - `card_chat_replies.jsonl`  … 返答 `{ts,re,key,by,text}`(`re` = 質問の ts)。by=ack|worker|fallback
 *
 * UI側が書くのは質問と即時の受領(ack)だけ。本回答は別プロセスが replies に書き戻す。
 */
import fs from "node:fs";
import path from "node:path";

export const CARD_CHAT_REQUESTS_FILE = "card_chat_requests.jsonl";
export const CARD_CHAT_REPLIES_FILE = "card_chat_replies.jsonl";
const TEXT_MAX = 600;
const KEY_MAX = 200;
const MESSAGES_SHOWN = 40;

export interface CardChatMessage {
  ts: number;
  role: "user" | "reply";
  by: string;
  text: string;
}

function appendLine(dir: string, file: string, obj: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(obj)}\n`, "utf-8");
}

function readRows(dir: string, file: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, file), "utf-8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 壊れた行は読み飛ばす
    }
  }
  return out;
}

export function sayToCard(
  dir: string,
  key: string,
  text: string,
): { ok: boolean; message: string } {
  const k = key.trim().slice(0, KEY_MAX);
  const clean = text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
  if (!k) return { ok: false, message: "この項目にはkeyが無くチャットできません" };
  if (!clean) return { ok: false, message: "空です" };
  const ts = Date.now();
  appendLine(dir, CARD_CHAT_REQUESTS_FILE, { ts, key: k, text: clean });
  appendLine(dir, CARD_CHAT_REPLIES_FILE, {
    ts,
    re: ts,
    key: k,
    by: "ack",
    text: "受け取りました。このカードの論点について返事を作ります(出たらここに表示されます)",
  });
  return { ok: true, message: "送りました" };
}

export function readCardChat(dir: string, key: string): CardChatMessage[] {
  const k = key.trim();
  const out: CardChatMessage[] = [];
  for (const r of readRows(dir, CARD_CHAT_REQUESTS_FILE)) {
    if (r.key === k && typeof r.ts === "number" && typeof r.text === "string") {
      out.push({ ts: r.ts, role: "user", by: "user", text: r.text });
    }
  }
  for (const r of readRows(dir, CARD_CHAT_REPLIES_FILE)) {
    if (r.key === k && typeof r.ts === "number" && typeof r.text === "string") {
      out.push({
        ts: r.ts,
        role: "reply",
        by: typeof r.by === "string" ? r.by : "",
        text: r.text,
      });
    }
  }
  // 同じ ts なら質問が先、返答が後
  const roleOrder = (m: CardChatMessage) => (m.role === "user" ? 0 : 1);
  out.sort((a, b) => a.ts - b.ts || roleOrder(a) - roleOrder(b));
  return out.slice(-MESSAGES_SHOWN);
}
