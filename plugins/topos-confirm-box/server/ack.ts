/**
 * 箱の既読/確認を追記する。契約は Paseo 本体ストア `packages/server/src/server/confirm-box/store.ts`
 * の `ack()` と同じ:
 *
 * - `{"t":"ack","id","ts","action":"read"|"approve"}`
 *
 * `ackall` は**使わない**。「通知」タブの「すべて既読」も1件ずつ `ack` を書く。`ackall` は
 * 箱の全項目(判断待ち=選択肢ありも含む)を既読にしてしまい、(1) 判断していない項目が
 * `depth_stats` の「決まった」に混ざる、(2) 見えていない項目まで既読になるため。
 * Python 側 `child_thread_registry._directly_acked_ids` が ackall を除外しているのと同じ理由。
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

function writeAt(file: string, line: string): void {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

function appendLine(dir: string, event: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAt(path.join(dir, eventsFileName(Date.now())), `${JSON.stringify(event)}\n`);
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
  // 画面への合図(Python `notify_box.signal` と同じファイル・同じ1行)。別端末(PC と iPhone)の
  // バッジ・一覧も5秒以内に取り直す(2026-10-24 round6指摘8)。合図は副次経路なので失敗は握る。
  try {
    writeAt(
      path.join(dir, "box.signal.jsonl"),
      `${JSON.stringify({ t: "signal", ts: now, event: "ack", id: itemId })}\n`,
    );
  } catch {
    // 取れなくても定期取得(30秒)が補う
  }
}
