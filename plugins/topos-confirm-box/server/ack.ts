/**
 * 箱の既読/確認を追記する。契約は Paseo 本体ストア `packages/server/src/server/confirm-box/store.ts`
 * の `ack()` / `ackAll()` と同じ:
 *
 * - `{"t":"ack","id","ts","action":"read"|"approve"}`
 * - `{"t":"ackall","ts":<before>,"action":"read","before":<before>}`
 *
 * 追記先は同じ箱ディレクトリの `events-YYYYMM.jsonl`(ローカル時刻の月)。O_APPEND の**単一 write** で
 * 書くので、デーモン本体や Python 側と同時に書いても行が混ざらない(既存の `appendDecision` と同じ流儀)。
 * ファイルを読んで書き戻す形は使わない(他プロセスの追記を消す恐れがある)。
 */
import fs from "node:fs";
import path from "node:path";

export type AckAction = "read" | "approve";

/** 月ごとのファイル名(ローカル時刻)。Python `notify_box._events_path` と同じ規則。 */
export function eventsFileName(now: number): string {
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `events-${d.getFullYear()}${p2(d.getMonth() + 1)}.jsonl`;
}

function appendLine(dir: string, event: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dir, eventsFileName(Date.now())), "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(event)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/** 1件を既読/承認にする。`id` が空なら書かない(呼び出し側の取り違えを黙って通さない)。 */
export function appendAck(
  dir: string,
  id: string,
  action: AckAction,
  now: number = Date.now(),
): void {
  const itemId = id.trim();
  if (!itemId) throw new Error("id が空です");
  appendLine(dir, { t: "ack", id: itemId, ts: now, action });
}

/** `before` 以前の未読をまとめて既読にする。返り値は書いたかどうか。 */
export function appendAckAll(dir: string, now: number = Date.now()): void {
  appendLine(dir, { t: "ackall", ts: now, action: "read", before: now });
}
