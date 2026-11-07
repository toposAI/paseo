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
 *   `by` = ack(受領) | origin_thread(元スレ) | hub_thread(上位スレのsay) | worker(応答ワーカー) | fallback(詰み)
 *
 * 通常の質問(`sayToCard`)でUIが書くのは質問と**即時の受領(ack)**だけ。ペイン発(`askFromPane`)は
 * ackを書かず、上位スレの `say` だけが返事になる(方式a)。本回答は `confirm_box_reply_worker.py`
 * (60秒ごと)が元スレへの転送かLLMで書き戻す=**このプラグインUIから聞いた限りは**
 * 受領が同期で必ず1行返る(fail-open)。
 * 未知の `t` は既存の読み手が無視する契約なので、この2行を足しても箱は壊れない。
 */
import fs from "node:fs";
import path from "node:path";
import { isImageComment } from "../shared/card-pane.js";

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

export function boxRows(dir: string): Record<string, unknown>[] {
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
/** これより古いペイン発の質問は待ち表示・集計から外す。Python `QUESTION_MAX_AGE_S`(7日)と同じ。 */
const PANE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** 返信IDの全長上限。Python側が `re` を200字で切るので、ここで200字以内に収める。 */
const REPLY_ID_MAX = 200;
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
  const replyId = `cbui-${id.slice(0, 120)}-${now}`.slice(0, REPLY_ID_MAX);
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

/** 送信(上位スレへの転送)に失敗したペイン発の質問を取り消す。催促・待ち表示・集計から外れる。 */
export function cancelFromPane(dir: string, target: CardChatTarget, replyId: string): boolean {
  const id = (target.id ?? "").trim().slice(0, ID_MAX);
  const re = replyId.trim().slice(0, REPLY_ID_MAX);
  if (!id || !re.startsWith("cbui-")) return false;
  appendLines(dir, chatsFile(), [
    {
      t: "chat_cancel",
      id,
      key: (target.key ?? "").trim().slice(0, ID_MAX) || null,
      ts: Date.now(),
      re,
    },
  ]);
  return true;
}

export interface PanePending {
  re: string;
  ts: number;
  state: "waiting" | "overdue";
  nudges: number;
}

/** 台帳から「say済み(ack以外の返事)」「取消済み」の返信IDと、返信IDごとの催促回数を集める。 */
function paneLedgerState(rows: Record<string, unknown>[]) {
  const answered = new Set<string>();
  const cancelled = new Set<string>();
  const nudges = new Map<string, number>();
  for (const r of rows) {
    const re = field(r, "re");
    if (r.t === "reply" && field(r, "by") !== "ack") answered.add(re);
    else if (r.t === "chat_cancel") cancelled.add(re);
    else if (r.t === "nudge") nudges.set(re, (nudges.get(re) ?? 0) + 1);
  }
  return { answered, cancelled, nudges };
}

/** ペイン発で、まだsay(ack以外の返事)が無い質問。Python `pane_status` の写し(7日超・取消済みは除く)。 */
export function panePending(
  dir: string,
  target: CardChatTarget,
  now: number = Date.now(),
  preRead?: Record<string, unknown>[],
): PanePending[] {
  const rows = preRead ?? boxRows(dir);
  const mine = cardMatcher(targetKeys(target));
  const { answered, cancelled, nudges } = paneLedgerState(rows);
  const out: PanePending[] = [];
  for (const r of rows) {
    if (r.t !== "chat" || r.source !== "pane" || !mine(r) || typeof r.ts !== "number") continue;
    // 画像への直接コメントは返事を求めない(2026-11-06 ユーザー指示)。催促・返事待ちの対象外。
    if (isImageComment(field(r, "question"))) continue;
    const re = field(r, "client_message_id");
    if (!re || answered.has(re) || cancelled.has(re) || r.ts < now - PANE_MAX_AGE_MS) continue;
    out.push({
      re,
      ts: r.ts,
      state: now - r.ts >= SAY_WAIT_MS ? "overdue" : "waiting",
      nudges: nudges.get(re) ?? 0,
    });
  }
  return out;
}

/**
 * 画面で見た印(`t:"seen"`)。未読の返事を消すためだけに使う(未知の t は他の読み手が無視する)。
 * **既に読んでいる(最後の返事より新しい seen がある)ときは書かない**: 開く・選ぶ・跳ぶたびに
 * 1行増えると台帳が無制限に伸びるため(2026-11-05 出口レビュー指摘1)。
 */
export function markSeen(dir: string, target: CardChatTarget, now: number = Date.now()): boolean {
  const id = (target.id ?? "").trim().slice(0, ID_MAX);
  if (!id) return false;
  const rows = boxRows(dir);
  const mine = cardMatcher(targetKeys(target));
  const { lastReplyAt } = replyStats(rows, mine, now);
  if (lastReplyAt === null || lastSeenAt(rows, mine) >= lastReplyAt) return false;
  appendLines(dir, chatsFile(), [
    { t: "seen", id, key: (target.key ?? "").trim().slice(0, ID_MAX) || null, ts: now },
  ]);
  return true;
}

export interface CardChatMarks {
  /** 送ったが、まだ ack 以外の返事が無い質問がある(＝返事待ち)。 */
  waiting: boolean;
  /** 返事が届いていて、まだ画面で見ていない(＝未読)。 */
  unread: boolean;
  /** 届いた返事の数(受領 ack は数えない)。 */
  replies: number;
  /** いちばん新しい返事の時刻(無ければ null)。 */
  lastReplyAt: number | null;
}

/**
 * 一覧に出す印(返事待ち・未読)を**台帳から**作る。画面のメモリではなく毎回ここから作るので、
 * 再読み込み・絞り込み切替でも消えない(2026-11-05 ユーザー決定)。
 * 7日より古い質問・返事は数えない(Python `QUESTION_MAX_AGE_S` と同じ)。
 */
export function cardChatMarks(
  dir: string,
  target: CardChatTarget,
  now: number = Date.now(),
  preRead?: Record<string, unknown>[],
): CardChatMarks {
  const rows = preRead ?? boxRows(dir);
  const mine = cardMatcher(targetKeys(target));
  const waiting = panePending(dir, target, now, rows).length > 0;
  const { replies, lastReplyAt } = replyStats(rows, mine, now);
  const seenAt = lastSeenAt(rows, mine);
  // 返事待ちが残っている間は「届いた」とは言わない(まだ次の返事を待っている)。
  const unread = !waiting && lastReplyAt !== null && lastReplyAt > seenAt;
  return { waiting, unread, replies, lastReplyAt };
}

/**
 * そのカードが「ユーザーの送信後、まだ返事が来ていない」状態か。サイドバーのバッジの数から外す判定
 * (2026-11-08 ユーザー「カードのチャット欄で送信したら一度バッジを消して、返信来たらまた出して」)。
 * いちばん新しい質問(取消済み・画像への直接コメント・7日超は除く)が、いちばん新しい返事
 * (受領 ack は返事に数えない)より新しければ返事待ち。返事が来れば自然に false へ戻る。
 */
export function isAwaitingReply(
  rows: Record<string, unknown>[],
  mine: (row: Record<string, unknown>) => boolean,
  now: number,
): boolean {
  const cancelled = new Set<string>();
  for (const r of rows) if (r.t === "chat_cancel") cancelled.add(field(r, "re"));
  let lastAsk = 0;
  for (const r of rows) {
    if (r.t !== "chat" || typeof r.ts !== "number" || !mine(r)) continue;
    if (r.ts < now - PANE_MAX_AGE_MS || isImageComment(field(r, "question"))) continue;
    if (cancelled.has(field(r, "client_message_id"))) continue;
    lastAsk = Math.max(lastAsk, r.ts);
  }
  if (lastAsk === 0) return false;
  const { lastReplyAt } = replyStats(rows, mine, now);
  return lastReplyAt === null || lastReplyAt < lastAsk;
}

export interface CardReplyMarks {
  /** 送ったが返事がまだ(バッジの数から外す)。 */
  waiting: boolean;
  /** 返事が届いていて、まだ画面で見ていない(カードに目印を出す)。 */
  unread: boolean;
}

/** 通常カード向けの印。台帳から毎回作る(`cardChatMarks` はペイン発だけを見るので別に持つ)。 */
export function cardReplyMarks(
  dir: string,
  target: CardChatTarget,
  now: number = Date.now(),
  preRead?: Record<string, unknown>[],
): CardReplyMarks {
  const rows = preRead ?? boxRows(dir);
  const mine = cardMatcher(targetKeys(target));
  const waiting = isAwaitingReply(rows, mine, now);
  const { lastReplyAt } = replyStats(rows, mine, now);
  return {
    waiting,
    unread: !waiting && lastReplyAt !== null && lastReplyAt > lastSeenAt(rows, mine),
  };
}

type RowMatcher = (row: Record<string, unknown>) => boolean;

/** この項目から出したペイン質問のID(返事の `re` 照合用)。 */
function askedIds(rows: Record<string, unknown>[], mine: RowMatcher): Set<string> {
  const asked = new Set<string>();
  for (const r of rows) {
    if (r.t !== "chat" || r.source !== "pane" || !mine(r)) continue;
    const re = field(r, "client_message_id");
    if (re) asked.add(re);
  }
  return asked;
}

/** この項目の画面で最後に見た時刻(無ければ 0)。 */
function lastSeenAt(rows: Record<string, unknown>[], mine: RowMatcher): number {
  let seenAt = 0;
  for (const r of rows) {
    if (r.t !== "seen" || typeof r.ts !== "number" || !mine(r)) continue;
    seenAt = Math.max(seenAt, r.ts);
  }
  return seenAt;
}

/** 届いた返事の数と最新時刻。受領(ack)は返事に数えない。7日超は数えない。 */
function replyStats(
  rows: Record<string, unknown>[],
  mine: RowMatcher,
  now: number,
): { replies: number; lastReplyAt: number | null } {
  const asked = askedIds(rows, mine);
  let replies = 0;
  let lastReplyAt: number | null = null;
  for (const r of rows) {
    if (!isCountableReply(r, now)) continue;
    // 返事は「この項目宛」か「この項目から出した質問への返事」だけ数える。
    if (!mine(r) && !asked.has(field(r, "re"))) continue;
    replies += 1;
    const ts = r.ts as number;
    if (lastReplyAt === null || ts > lastReplyAt) lastReplyAt = ts;
  }
  return { replies, lastReplyAt };
}

function isCountableReply(r: Record<string, unknown>, now: number): boolean {
  if (r.t !== "reply" || typeof r.ts !== "number" || field(r, "by") === "ack") return false;
  return r.ts >= now - PANE_MAX_AGE_MS;
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
export function cardExists(
  dir: string,
  target: CardChatTarget,
  preRead?: Record<string, unknown>[],
): boolean {
  const keys = targetKeys(target);
  return (preRead ?? boxRows(dir)).some((r) => (r.t === "item" || !r.t) && cardMatcher(keys)(r));
}

export function readCardChat(
  dir: string,
  target: CardChatTarget,
  opts: { topic?: boolean } = {},
  preRead?: Record<string, unknown>[],
): CardChatMessage[] {
  const keys = targetKeys(target);
  const all = [...boxMessages(preRead ?? boxRows(dir), keys), ...legacyMessages(dir, keys)];
  // 「この話題だけ」では受領(ack)を会話に入れない(返事はsayだけ)。
  const out = opts.topic ? all.filter((m) => m.by !== "ack") : all;
  // 同じ ts なら質問が先、返答が後
  const roleOrder = (m: CardChatMessage) => (m.role === "user" ? 0 : 1);
  out.sort((a, b) => a.ts - b.ts || roleOrder(a) - roleOrder(b));
  return out.slice(-MESSAGES_SHOWN);
}
