import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 確認箱(confirm box)のイベントストア。Python側 antigravity/utils/notify_box.py と
 * ディスク上のデータ契約を共有する(ToposAI-Mini-Project)。
 *
 * - ディレクトリ: TOPOS_CONFIRM_BOX_DIR、無ければ ~/.local/state/toposai/confirm_box
 * - events-YYYYMM.jsonl へ 1行1イベントを O_APPEND の単一writeで追記(ロック不要。
 *   書き手が複数プロセス(Python watchdog群+このデーモン)でも行が混ざらない)。
 * - 壊れた行・未知のイベントは無視する。
 * - heartbeat.json は原子的(tmp→rename)に上書きし、Python側の死活検査が読む。
 * - 2026-10-21: item に priority/subrank/group/summary/background/thread_ref/stopped_count/
 *   options/recommended/key、ack に depth/chosen/chat_question が加わった。**古いitemには
 *   無い**ので `applyItem` が既定値で補完する。並び順は `compareConfirmBoxItems()`。
 */

export type ConfirmBoxUrgency = "urgent" | "normal";
export type ConfirmBoxState = "new" | "read" | "approved";
export type ConfirmBoxAckAction = "read" | "approve";
/** 並び順の軸。`urgency`(緊急・push対象)とは別物で、こちらは「どの空き時間を割り当てるか」。 */
export type ConfirmBoxPriority = "blocking" | "design" | "normal" | "info";
/** 決めた時点でどこまで開いていたか(浅い→深い)。指標は `chat` への到達率だけ。 */
export type ConfirmBoxDepth = "list" | "expanded" | "background" | "chat";

export interface ConfirmBoxThreadRef {
  kind: string;
  id: string;
}

export interface ConfirmBoxOption {
  id: string;
  label: string;
}

export interface ConfirmBoxItem {
  id: string;
  ts: number;
  urgency: ConfirmBoxUrgency;
  source: string;
  subject: string;
  body: string;
  origin: string;
  state: ConfirmBoxState;
  pushedAt: number | null;
  priority: ConfirmBoxPriority;
  /** 同じ priority の中での並び。小さいほど上。負値も許す。 */
  subrank: number;
  /** 同じ背景を共有する判断の束の識別子。null = 束ねない。 */
  group: string | null;
  summary: string;
  background: string;
  threadRef: ConfirmBoxThreadRef | null;
  stoppedCount: number;
  options: ConfirmBoxOption[];
  recommended: string | null;
  key: string | null;
  depth: ConfirmBoxDepth | null;
  chosen: string | null;
  chatQuestion: string | null;
}

/**
 * 箱のチャット欄から元スレへ送った質問1件(events の `{"t":"chat"}` を畳んだもの)。
 * 返答はここには持たない(元スレのタイムラインから都度切り出す。`chat.ts`)。
 */
export interface ConfirmBoxChatEntry {
  itemId: string;
  ts: number;
  question: string;
  /** 返答の対応付けに使う。元スレのタイムラインの user_message にこの値が入る。 */
  clientMessageId: string;
}

export interface ConfirmBoxSummary {
  unread: number;
  urgentUnread: number;
  total: number;
}

export interface ConfirmBoxHeartbeat {
  ts: number;
  pid: number;
  version: string;
  lastScanAt: number;
  lastPushAt: number | null;
  unpushedUrgent: number;
}

export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;
export const SOURCE_MAX = 80;
// 2026-10-21追加分。上限は Python側 notify_box.py と揃える(片方だけ広いと、
// 箱ごとに見える内容が変わる)。
export const SUMMARY_MAX = 400;
export const BACKGROUND_MAX = 8000;
export const OPTION_LABEL_MAX = 120;
export const OPTIONS_MAX = 6;
export const GROUP_MAX = 80;
export const CHAT_QUESTION_MAX = 1000;

export const PRIORITIES: readonly ConfirmBoxPriority[] = ["blocking", "design", "normal", "info"];
export const DEFAULT_PRIORITY: ConfirmBoxPriority = "normal";
export const PRIORITY_RANK: Record<ConfirmBoxPriority, number> = {
  blocking: 0,
  design: 1,
  normal: 2,
  info: 3,
};
export const DEPTHS: readonly ConfirmBoxDepth[] = ["list", "expanded", "background", "chat"];

// --- 正規化(投函側のtypoで箱が壊れないように、ここで既定値へ寄せる) ---
// 判定は投函側(Python)が済ませてある前提。ここは機械的に寄せるだけ。

export function normalizePriority(value: unknown): ConfirmBoxPriority {
  return PRIORITIES.includes(value as ConfirmBoxPriority)
    ? (value as ConfirmBoxPriority)
    : DEFAULT_PRIORITY;
}

export function normalizeSubrank(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

export function normalizeGroup(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const group = value.trim().slice(0, GROUP_MAX);
  return group.length > 0 ? group : null;
}

export function normalizeOptions(value: unknown): ConfirmBoxOption[] {
  if (!Array.isArray(value)) return [];
  const out: ConfirmBoxOption[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    // id/label が空の要素と id の重複は落とす(タップ結果を一意に記録できなくなるため)
    const id = typeof o.id === "string" ? o.id.trim().slice(0, 40) : "";
    const label = typeof o.label === "string" ? o.label.trim().slice(0, OPTION_LABEL_MAX) : "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label });
    if (out.length >= OPTIONS_MAX) break;
  }
  return out;
}

/** 推奨する選択肢のid。**`options` に無いidは null に落とす**
 * (存在しない選択肢を推奨にすると「推奨どおり決めたか」の判定が壊れる)。 */
export function normalizeRecommended(value: unknown, options: ConfirmBoxOption[]): string | null {
  const id = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return id && options.some((o) => o.id === id) ? id : null;
}

export function normalizeThreadRef(value: unknown): ConfirmBoxThreadRef | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = typeof v.kind === "string" ? v.kind.trim().slice(0, 40) : "";
  const id = typeof v.id === "string" ? v.id.trim().slice(0, 200) : "";
  return kind && id ? { kind, id } : null;
}

export function normalizeStoppedCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export function normalizeDepth(value: unknown): ConfirmBoxDepth | null {
  return DEPTHS.includes(value as ConfirmBoxDepth) ? (value as ConfirmBoxDepth) : null;
}

/** 並び順の比較関数。**SSOTは Python側 `notify_box.sort_items()`** で、ここはその写し
 * (箱ごとに順序が変わらないようにするため)。priority → subrank → group → ts降順。
 *
 * `group` を挟むのは、同じ背景を共有する判断を一覧で連続させるため(展開した背景を
 * 読み直さずに連続で決められる=時短の実体)。group 無し(null)は空文字として先頭側に
 * まとめる。文字列比較はUTF-16コード単位(Pythonはコードポイント)なので、
 * BMP外の文字を含む group 名では順序がずれうる — group は短いASCII識別子にする。 */
export function compareConfirmBoxItems(a: ConfirmBoxItem, b: ConfirmBoxItem): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.subrank !== b.subrank) return a.subrank - b.subrank;
  const ag = a.group ?? "";
  const bg = b.group ?? "";
  if (ag !== bg) return ag < bg ? -1 : 1;
  return b.ts - a.ts;
}

const EVENTS_FILE = /^events-\d{6}\.jsonl$/;

export function resolveConfirmBoxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOPOS_CONFIRM_BOX_DIR;
  if (override && override.trim().length > 0) {
    return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  }
  return path.join(os.homedir(), ".local", "state", "toposai", "confirm_box");
}

function eventsFileName(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `events-${d.getFullYear()}${mm}.jsonl`;
}

interface FileCursor {
  offset: number;
  remainder: string;
}

export class ConfirmBoxStore {
  private readonly items = new Map<string, ConfirmBoxItem>();
  private readonly order: string[] = [];
  private readonly cursors = new Map<string, FileCursor>();
  /** item id → 箱から送った質問(古い順)。 */
  private readonly chats = new Map<string, ConfirmBoxChatEntry[]>();

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** ディスク上の新しい追記分だけを取り込む。戻り値は新規に畳み込んだイベント数。 */
  refresh(): number {
    let names: string[];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((n) => EVENTS_FILE.test(n))
        .sort();
    } catch {
      return 0;
    }
    let applied = 0;
    for (const name of names) {
      applied += this.readFile(name);
    }
    return applied;
  }

  private readFile(name: string): number {
    const filePath = path.join(this.dir, name);
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return 0;
    }
    const cursor = this.cursors.get(name) ?? { offset: 0, remainder: "" };
    if (size < cursor.offset) {
      // ファイルが縮んだ(手動で切詰め等)。最初から読み直す。
      cursor.offset = 0;
      cursor.remainder = "";
    }
    if (size === cursor.offset) {
      this.cursors.set(name, cursor);
      return 0;
    }
    const length = size - cursor.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, cursor.offset);
    } finally {
      fs.closeSync(fd);
    }
    cursor.offset = size;
    const text = cursor.remainder + buffer.toString("utf8");
    const lines = text.split("\n");
    cursor.remainder = lines.pop() ?? ""; // 末尾の未完了行は次回に持ち越す
    this.cursors.set(name, cursor);
    let applied = 0;
    for (const line of lines) {
      if (this.applyLine(line)) applied += 1;
    }
    return applied;
  }

  private applyLine(line: string): boolean {
    if (!line.trim()) return false;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof ev !== "object" || ev === null) return false;
    const e = ev as Record<string, unknown>;
    switch (e.t) {
      case "item":
        return this.applyItem(e);
      case "ack":
        return this.applyAck(e);
      case "ackall":
        return this.applyAckAll(e);
      case "push":
        return this.applyPush(e);
      case "chat":
        return this.applyChat(e);
      default:
        return false;
    }
  }

  private applyItem(e: Record<string, unknown>): boolean {
    if (typeof e.id !== "string" || !e.id || this.items.has(e.id)) return false;
    if (typeof e.ts !== "number") return false;
    const str = (value: unknown, fallback: string) =>
      typeof value === "string" ? value : fallback;
    // 2026-10-21以前のitemには追加キーが無い。**必ず既定値で補完**してから持つ
    // (読み手がキーの有無を気にしなくて済むようにするため。Python側 load_items() と同じ)。
    const options = normalizeOptions(e.options);
    this.items.set(e.id, {
      id: e.id,
      ts: e.ts,
      urgency: e.urgency === "urgent" ? "urgent" : "normal",
      source: str(e.source, "unknown"),
      subject: str(e.subject, ""),
      body: str(e.body, ""),
      origin: str(e.origin, "unknown"),
      state: "new",
      pushedAt: null,
      priority: normalizePriority(e.priority),
      subrank: normalizeSubrank(e.subrank),
      group: normalizeGroup(e.group),
      summary: str(e.summary, "").slice(0, SUMMARY_MAX),
      background: str(e.background, "").slice(0, BACKGROUND_MAX),
      threadRef: normalizeThreadRef(e.thread_ref),
      stoppedCount: normalizeStoppedCount(e.stopped_count),
      options,
      recommended: normalizeRecommended(e.recommended, options),
      key: typeof e.key === "string" && e.key.trim() ? e.key.trim().slice(0, 200) : null,
      depth: null,
      chosen: null,
      chatQuestion: null,
    });
    this.order.push(e.id);
    return true;
  }

  private applyAck(e: Record<string, unknown>): boolean {
    const item = typeof e.id === "string" ? this.items.get(e.id) : undefined;
    if (!item) return false;
    if (e.action === "approve") item.state = "approved";
    else if (item.state === "new") item.state = "read";
    const depth = normalizeDepth(e.depth);
    if (depth !== null) {
      // 同じ項目に複数ackが来たら**深い方**を残す(浅い方で上書きすると
      // 「チャットまで行ったのに一覧で決めた」と記録されて指標が甘くなる)。
      if (item.depth === null || DEPTHS.indexOf(depth) > DEPTHS.indexOf(item.depth)) {
        item.depth = depth;
      }
    }
    const chosen = typeof e.chosen === "string" ? e.chosen.trim().slice(0, 40) : "";
    // 選択肢に無いidは記録しない(タップしていない値が「選んだ選択肢」として残ると、
    // 後段の推奨精度の集計が汚れる)。
    if (chosen && item.options.some((o) => o.id === chosen)) item.chosen = chosen;
    const question = typeof e.chat_question === "string" ? e.chat_question.trim() : "";
    if (question) item.chatQuestion = question.slice(0, CHAT_QUESTION_MAX);
    return true;
  }

  private applyAckAll(e: Record<string, unknown>): boolean {
    const before = typeof e.before === "number" ? e.before : 0;
    for (const item of this.items.values()) {
      if (item.state === "new" && item.ts <= before) item.state = "read";
    }
    return true;
  }

  private applyPush(e: Record<string, unknown>): boolean {
    const item = typeof e.id === "string" ? this.items.get(e.id) : undefined;
    if (!item) return false;
    item.pushedAt = typeof e.ts === "number" ? e.ts : this.now();
    return true;
  }

  /** `{"t":"chat"}` を畳む。item が無い行は捨てる(先に item が要る)。
   * 同じ `client_message_id` は二重に数えない(ファイルが切り詰められて読み直された場合の保険)。 */
  private applyChat(e: Record<string, unknown>): boolean {
    const itemId = typeof e.id === "string" ? e.id : "";
    if (!itemId || !this.items.has(itemId)) return false;
    const question = typeof e.question === "string" ? e.question.trim() : "";
    const clientMessageId = typeof e.client_message_id === "string" ? e.client_message_id : "";
    if (!question || !clientMessageId) return false;
    const list = this.chats.get(itemId) ?? [];
    if (list.some((c) => c.clientMessageId === clientMessageId)) return false;
    list.push({
      itemId,
      ts: typeof e.ts === "number" ? e.ts : this.now(),
      question: question.slice(0, CHAT_QUESTION_MAX),
      clientMessageId,
    });
    this.chats.set(itemId, list);
    return true;
  }

  private append(event: Record<string, unknown>): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(event)}\n`;
    // appendFileSync は O_APPEND で開き1回のwriteで書く(Python側と同じ方式)。
    fs.appendFileSync(path.join(this.dir, eventsFileName(this.now())), line, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /** 書込後に自分のイベントも畳み込むため、追記してすぐrefreshする。 */
  private appendAndApply(event: Record<string, unknown>): void {
    this.append(event);
    this.refresh();
  }

  addItem(input: {
    subject: string;
    body?: string;
    urgency?: string;
    source?: string;
    origin?: string;
  }): ConfirmBoxItem {
    const id = randomBytes(8).toString("hex");
    this.appendAndApply({
      t: "item",
      id,
      ts: this.now(),
      urgency: input.urgency === "urgent" ? "urgent" : "normal",
      source: (input.source ?? "api").slice(0, SOURCE_MAX),
      subject: input.subject.slice(0, SUBJECT_MAX),
      body: (input.body ?? "").slice(0, BODY_MAX),
      origin: input.origin ?? "api",
    });
    return this.items.get(id)!;
  }

  /**
   * 既読/承認を記録する。`extra` は UI が「どこまで開いて決めたか」を載せるための任意項目
   * (2026-10-21追加)。イベントの形は Python側 notify_box.py と共有する契約なので
   * `chat_question` だけ snake_case で書く。
   */
  ack(
    id: string,
    action: ConfirmBoxAckAction,
    extra: { depth?: ConfirmBoxDepth; chosen?: string; chatQuestion?: string } = {},
  ): boolean {
    this.refresh();
    if (!this.items.has(id)) return false;
    const event: Record<string, unknown> = { t: "ack", id, ts: this.now(), action };
    const depth = normalizeDepth(extra.depth);
    if (depth) event.depth = depth;
    if (extra.chosen) event.chosen = extra.chosen;
    if (extra.chatQuestion) event.chat_question = extra.chatQuestion;
    this.appendAndApply(event);
    return true;
  }

  /**
   * チャット欄で聞かれた質問文を残す**唯一の関数**(別スレ 9a100954 との契約)。
   *
   * 呼び出し元(routes.ts)は質問文の形式に触らない。本則の `chat` イベント
   * (`pending_user_decisions.jsonl` への `{"t":"chat","key",…,"question","asked_by"}`)を
   * 実装するスレは、**この関数の中身を差し替える**だけで済むようにしてある
   * (返り値の `clientMessageId` は返答の対応付けに使うので、差し替え側も返すこと)。
   *
   * いまは箱のイベントJSONLへ `{"t":"chat","id","key","ts","question","client_message_id"}`
   * を追記する。`t:"chat"` は未知イベントなので、Python側 `load_items()` も
   * 既存の読み手も無視する(畳み込むのは Paseo 側の `applyChat` だけ)。
   *
   * 記録できなければ null を返す(送信側は「記録できなかった」として扱う)。
   */
  recordChatQuestion(itemId: string, question: string): string | null {
    this.refresh();
    const item = this.items.get(itemId);
    const text = question.trim().slice(0, CHAT_QUESTION_MAX);
    if (!item || !text) return null;
    // 同じ項目に複数回聞けるので連番を付ける(対応付けの一意性はここで担保する)。
    const clientMessageId = `cbx-${itemId}-${(this.chats.get(itemId)?.length ?? 0) + 1}`;
    this.appendAndApply({
      t: "chat",
      id: itemId,
      key: item.key,
      ts: this.now(),
      question: text,
      client_message_id: clientMessageId,
    });
    return clientMessageId;
  }

  /** 箱から送った質問(古い順)。 */
  chatEntries(itemId: string): ConfirmBoxChatEntry[] {
    return [...(this.chats.get(itemId) ?? [])];
  }

  getItem(id: string): ConfirmBoxItem | null {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  ackAll(): number {
    this.refresh();
    const before = this.now();
    const count = this.summary().unread;
    if (count > 0) this.appendAndApply({ t: "ackall", ts: before, action: "read", before });
    return count;
  }

  markPushed(ids: string[]): void {
    for (const id of ids) {
      if (this.items.has(id)) this.append({ t: "push", id, ts: this.now() });
    }
    this.refresh();
  }

  /** 一覧。**priority → subrank → group → ts降順** で返す(2026-10-21〜。以前は投函の新しい順)。
   * 正本は Python側 `notify_box.sort_items()` で、`compareConfirmBoxItems()` がその写し。 */
  list(view: "active" | "all", limit: number): ConfirmBoxItem[] {
    const sorted = this.order.map((id) => this.items.get(id)!).sort(compareConfirmBoxItems);
    const out: ConfirmBoxItem[] = [];
    for (const item of sorted) {
      if (out.length >= limit) break;
      if (view === "all" || item.state === "new") out.push({ ...item });
    }
    return out;
  }

  summary(): ConfirmBoxSummary {
    let unread = 0;
    let urgentUnread = 0;
    for (const item of this.items.values()) {
      if (item.state !== "new") continue;
      unread += 1;
      if (item.urgency === "urgent") urgentUnread += 1;
    }
    return { unread, urgentUnread, total: this.items.size };
  }

  allItems(): ConfirmBoxItem[] {
    return this.order.map((id) => this.items.get(id)!);
  }

  writeHeartbeat(hb: ConfirmBoxHeartbeat): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dir, "heartbeat.json");
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hb), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}
