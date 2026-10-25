/**
 * カード単位のチャット(確認箱の自由記述欄)。2026-10-22に箱のイベント列へ移行。
 *
 * 以前は `card_chat_requests.jsonl` / `card_chat_replies.jsonl` の2ファイルだったが、
 * **書き手も読み手も居ない**(質問は書けるが返事を書くプロセスが無かった)ため、
 * 箱の正本 `events-YYYYMM.jsonl` に一本化した。PaseoコアのPWAが既に書いている
 * `{"t":"chat",…}` と同じ形なので、**同じ箱に質問と返事が1本の列として残る**。
 *
 * 表示するUIは2つあり、どちらも同じイベント列を読む: このプラグインのカードチャットペインと、
 * コアPWAの確認箱ページ(`packages/server/src/server/confirm-box/page.ts`)。
 * コア側も `applyLine` が `t:"reply"` を折り畳む(e3c435bc9 で対応。それ以前は
 * **PWAから聞くと返事が見えなかった**=旧コメントの残差は解消済み)。
 *
 * - 質問: `{t:"chat", id, key, ts, question, client_message_id}`
 * - 返事: `{t:"reply", id, key, ts, re, by, text}`(`re` = 質問の client_message_id)
 *   `by` = ack(受領) | origin_thread(元スレ) | worker(応答ワーカー) | fallback(詰み)
 *
 * UIが書くのは質問と**即時の受領(ack)**だけ。本回答は `confirm_box_reply_worker.py`
 * (60秒ごと)が元スレへの転送かLLMで書き戻す=**このプラグインUIから聞いた限りは**
 * 受領が同期で必ず1行返る(fail-open)。
 * 未知の `t` は既存の読み手が無視する契約なので、この2行を足しても箱は壊れない。
 */
import fs from "node:fs";
import path from "node:path";

const EVENTS_FILE = /^events-\d{6}\.jsonl$/;
/** 旧形式(読み取りのみ・互換のため残す。新規の書き込みはしない)。 */
export const LEGACY_REQUESTS_FILE = "card_chat_requests.jsonl";
export const LEGACY_REPLIES_FILE = "card_chat_replies.jsonl";

const TEXT_MAX = 600;
const ID_MAX = 200;
const MESSAGES_SHOWN = 40;
// 受領の文言は中立にする。元スレが無い項目(保留中・手動投函)でも同じ文言が出るため、
// 「担当スレに確認します」と言い切ると実態とずれる(2026-10-22レビュー)。
export const ACK_TEXT = "受け取りました。返事を作ります(出たらここに表示されます)";

export interface CardChatMessage {
  ts: number;
  role: "user" | "reply";
  by: string;
  text: string;
}

/** どの項目への質問か。箱の項目は `key` を持たないことがあるので `id` は必須。 */
export interface CardChatTarget {
  id: string;
  key?: string | null;
}

/** 複数行を**1回のwrite**で書く(間に読み手が割り込むと、片方だけ見えて二重ackになる)。 */
function appendLines(dir: string, file: string, objs: readonly unknown[]): void {
  if (objs.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), objs.map((o) => `${JSON.stringify(o)}\n`).join(""), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function eventFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => EVENTS_FILE.test(name))
      .sort();
  } catch {
    return [];
  }
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

function boxRows(dir: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const name of eventFiles(dir)) rows.push(...readRows(dir, name));
  return rows;
}

function chatsFile(): string {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `events-${ym}.jsonl`;
}

function targetKeys(target: CardChatTarget): string[] {
  return [target.id, target.key ?? ""].map((v) => v.trim()).filter((v) => v.length > 0);
}

function field(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  return typeof value === "string" ? value : "";
}

/** その項目の行か(id か key の一致)。 */
function cardMatcher(keys: string[]): (row: Record<string, unknown>) => boolean {
  return (row) => {
    const key = field(row, "key");
    return keys.includes(field(row, "id")) || (key.length > 0 && keys.includes(key));
  };
}

export function sayToCard(
  dir: string,
  target: CardChatTarget,
  text: string,
): { ok: boolean; message: string } {
  const id = (target.id ?? "").trim().slice(0, ID_MAX);
  const key = (target.key ?? "").trim().slice(0, ID_MAX) || null;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
  if (!id) return { ok: false, message: "この項目はチャットできません(id なし)" };
  if (!clean) return { ok: false, message: "空です" };

  const ts = Date.now();
  // 同じ項目に何度でも聞けるので、ms まで入れて一意にする(再起動をまたいでも衝突しない)。
  const clientMessageId = `cbui-${id}-${ts}`.slice(0, ID_MAX * 2);
  // 質問と受領は**同じwrite**で書く。2回に分けると、その隙にワーカーが読んで
  // 受領を二重に書くことがある(2026-10-22レビュー)。
  // fail-open: 本回答が来なくても「受け取った」は必ず1行返る(ユーザーに無反応を作らない)。
  appendLines(dir, chatsFile(), [
    {
      t: "chat",
      id,
      key,
      ts,
      question: clean,
      client_message_id: clientMessageId,
      source: "plugin",
    },
    {
      t: "reply",
      id,
      key,
      ts,
      re: clientMessageId,
      by: "ack",
      text: ACK_TEXT,
    },
  ]);
  return { ok: true, message: "送りました" };
}

/** ペイン発の質問の本文上限(ペインの入力欄の上限に合わせる。改行は残す)。 */
const PANE_TEXT_MAX = 4000;
/** 返信待ちを「sayなし」とみなす秒数。Python `confirm_box_reply.SAY_WAIT_S` と同じ。 */
export const SAY_WAIT_MS = 180_000;

/**
 * ペインからの質問を台帳へ書く(方式a)。ackは書かない=返事は上位スレのsayだけ。
 * `target` = 送り先スレ(催促ワーカーの宛先)。返信ID(`replyId`)を返す。
 */
export function askFromPane(
  dir: string,
  target: CardChatTarget,
  text: string,
  agentId: string,
  now: number = Date.now(),
): { ok: boolean; message: string; replyId?: string } {
  const id = (target.id ?? "").trim().slice(0, ID_MAX);
  const key = (target.key ?? "").trim().slice(0, ID_MAX) || null;
  const clean = text.trim().slice(0, PANE_TEXT_MAX);
  if (!id) return { ok: false, message: "この項目はチャットできません(id なし)" };
  if (!clean) return { ok: false, message: "空です" };
  if (!agentId.trim()) return { ok: false, message: "送り先がありません" };
  const replyId = `cbui-${id}-${now}`.slice(0, ID_MAX * 2);
  appendLines(dir, chatsFile(), [
    {
      t: "chat",
      id,
      key,
      ts: now,
      question: clean,
      client_message_id: replyId,
      source: "pane",
      target: agentId.trim(),
    },
  ]);
  return { ok: true, message: "記録しました", replyId };
}

export interface PanePending {
  re: string;
  ts: number;
  state: "waiting" | "overdue";
  nudges: number;
}

/** ペイン発で、まだsay(ack以外の返事)が無い質問。Python `pane_status` の写し。 */
export function panePending(
  dir: string,
  target: CardChatTarget,
  now: number = Date.now(),
): PanePending[] {
  const rows = boxRows(dir);
  const mine = cardMatcher(targetKeys(target));
  const answered = new Set<string>();
  const nudges = new Map<string, number>();
  for (const r of rows) {
    if (r.t === "reply" && field(r, "by") !== "ack") answered.add(field(r, "re"));
    if (r.t === "nudge") nudges.set(field(r, "re"), (nudges.get(field(r, "re")) ?? 0) + 1);
  }
  const out: PanePending[] = [];
  for (const r of rows) {
    if (r.t !== "chat" || r.source !== "pane" || !mine(r) || typeof r.ts !== "number") continue;
    const re = field(r, "client_message_id");
    if (!re || answered.has(re)) continue;
    out.push({
      re,
      ts: r.ts,
      state: now - r.ts >= SAY_WAIT_MS ? "overdue" : "waiting",
      nudges: nudges.get(re) ?? 0,
    });
  }
  return out;
}

/** 箱のイベント列から、その項目の質問と返事。返事は `re`(質問ID)でも照合する。 */
function boxMessages(rows: Record<string, unknown>[], keys: string[]): CardChatMessage[] {
  const mine = cardMatcher(keys);
  const asked = new Set<string>();
  const out: CardChatMessage[] = [];
  for (const r of rows) {
    if (r.t !== "chat" || !mine(r)) continue;
    if (typeof r.ts !== "number" || typeof r.question !== "string") continue;
    out.push({ ts: r.ts, role: "user", by: "user", text: r.question });
    const cid = field(r, "client_message_id");
    if (cid.length > 0) asked.add(cid);
  }
  for (const r of rows) {
    if (r.t !== "reply" || typeof r.ts !== "number" || typeof r.text !== "string") continue;
    if (!mine(r) && !asked.has(field(r, "re"))) continue;
    out.push({ ts: r.ts, role: "reply", by: field(r, "by"), text: r.text });
  }
  return out;
}

/** 旧形式(2026-10-22以前に書かれた行があれば)も表示する。読み取りのみ。 */
function legacyMessages(dir: string, keys: string[]): CardChatMessage[] {
  const mine = cardMatcher(keys);
  const out: CardChatMessage[] = [];
  for (const r of readRows(dir, LEGACY_REQUESTS_FILE)) {
    if (typeof r.ts === "number" && typeof r.text === "string" && mine(r)) {
      out.push({ ts: r.ts, role: "user", by: "user", text: r.text });
    }
  }
  for (const r of readRows(dir, LEGACY_REPLIES_FILE)) {
    if (typeof r.ts === "number" && typeof r.text === "string" && mine(r)) {
      out.push({ ts: r.ts, role: "reply", by: field(r, "by"), text: r.text });
    }
  }
  return out;
}

/**
 * その id/key の項目が箱(item 行)にあるか。URL 手打ち・決定済みで消えた項目の会話を
 * 開いた時に「送っても迷子になる」ことをUIで伝えるために使う(2026-10-22)。
 */
export function cardExists(dir: string, target: CardChatTarget): boolean {
  const keys = targetKeys(target);
  return boxRows(dir).some((r) => (r.t === "item" || !r.t) && cardMatcher(keys)(r));
}

export function readCardChat(
  dir: string,
  target: CardChatTarget,
  opts: { topic?: boolean } = {},
): CardChatMessage[] {
  const keys = targetKeys(target);
  const all = [...boxMessages(boxRows(dir), keys), ...legacyMessages(dir, keys)];
  // 「この話題だけ」では受領(ack)を会話に入れない(返事はsayだけ)。
  const out = opts.topic ? all.filter((m) => m.by !== "ack") : all;
  // 同じ ts なら質問が先、返答が後
  const roleOrder = (m: CardChatMessage) => (m.role === "user" ? 0 : 1);
  out.sort((a, b) => a.ts - b.ts || roleOrder(a) - roleOrder(b));
  return out.slice(-MESSAGES_SHOWN);
}
