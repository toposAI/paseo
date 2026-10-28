/**
 * ユーザーが窓口Bへ出した依頼の台帳(窓口Bの右側の画面のデータ元)。設計と語彙は `shared/task-ledger.ts`。
 *
 * 読み取り専用。4つの出所を鍵(`MM/DD HH:MM#N`)で突き合わせる:
 * 1. `window_b_reply/window_b_items.json` … 受付時に裏方が作る項目の台帳(正)。
 *    形式は `antigravity/utils/window_b_request_items.py` の先頭(そのモジュールと同じ env に従う)。
 * 2. `coordinator_inbox.md` の `[窓口B→裏方]` 行 … 依頼の全文と受付の時刻。台帳に項目が無い依頼は
 *    ここから文を分けて「推測」の行として補う(台帳が未マージの間も画面が空にならないように)。
 *    ただし台帳が読めているときは、台帳が受け付けた範囲の外にある依頼だけを補う(受信箱の古い行まで
 *    全件を推測で作り直すと、片付いた依頼が「振り先の記録なし」として永久に並ぶ)。
 * 3. `confirm_box/child_threads.json` … 振った子スレの進捗(自己申告の状態と Paseo の稼働状態)。
 * 4. `confirm_box/priority_ledger.json` … 開発プロジェクト(優先順位台帳)の名前を付ける。
 *
 * どの出所も読めないときは空で続ける(1つ壊れたせいで画面全体を消さない)。読めなかったものは notes に出す。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LedgerChild,
  LedgerKind,
  LedgerProgress,
  LedgerRow,
  TaskLedgerListOutput,
} from "../shared/task-ledger.js";
import { keySortValue } from "../shared/task-ledger.js";

export interface TaskLedgerDirs {
  /** `window_b_reply/window_b_items.json` の親(既定 `~/.local/state/toposai/window_b_reply`)。 */
  itemsDir: string;
  /** `child_threads.json`・`priority_ledger.json` のある確認箱のディレクトリ。 */
  confirmBoxDir: string;
  /** 司令塔の受信箱(`coordinator_inbox.md`)。 */
  inboxPath: string;
}

const DEFAULT_BASE = path.join(os.homedir(), ".local", "state", "toposai");

function expandHome(value: string): string {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

/** 台帳の置き場。`window_b_request_items.items_file()` と同じ優先順(WINDOW_B_ITEMS_FILE →
 * WINDOW_B_REPLY_STATE_DIR → TOPOS_STATE_DIR/window_b_reply → 既定)。 */
export function resolveTaskLedgerDirs(env: NodeJS.ProcessEnv = process.env): TaskLedgerDirs {
  const base = env.TOPOS_STATE_DIR?.trim() || DEFAULT_BASE;
  const explicit = env.WINDOW_B_ITEMS_FILE?.trim();
  const stateDir = env.WINDOW_B_REPLY_STATE_DIR?.trim();
  const itemsDir = explicit
    ? path.dirname(path.resolve(expandHome(explicit)))
    : path.join(expandHome(stateDir || base), stateDir ? "" : "window_b_reply");
  const confirmBoxDir = env.TOPOS_CONFIRM_BOX_DIR?.trim() || path.join(base, "confirm_box");
  const inboxPath =
    env.TASK_LEDGER_INBOX?.trim() ||
    "/Users/user/repos/ToposAI-Mini-Project/.claude-memory/coordinator_inbox.md";
  return { itemsDir, confirmBoxDir, inboxPath };
}

/** itemsDir 直下の `window_b_items.json`(`resolveTaskLedgerDirs` が `WINDOW_B_ITEMS_FILE` を反映済み)。
 * どの出所も読めないときは空で続ける方針なので、相対パスは その瞬間の作業フォルダに依存させない。 */
function itemsFile(dirs: TaskLedgerDirs): string {
  return path.join(dirs.itemsDir, "window_b_items.json");
}

// ---------------------------------------------------------------- 鍵

const KEY_RE = /^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?:#(\d+))?$/;
const SHORT_KEY_RE = /^(\d{2}):(\d{2})(?:#(\d+))?$/;

/** 日付なしの鍵(`HH:MM`)を、受信箱の最後の日付つき鍵と同じ日として扱う(受信箱の書き方に同じ)。 */
export function normalizeInboxKeys(keys: readonly string[]): string[] {
  let mmdd = "";
  return keys.map((k) => {
    const full = KEY_RE.exec(k);
    if (full) {
      mmdd = `${full[1]}/${full[2]}`;
      return k;
    }
    return mmdd && SHORT_KEY_RE.test(k) ? `${mmdd} ${k}` : k;
  });
}

// ---------------------------------------------------------------- 受信箱

export interface InboxRequest {
  key: string;
  text: string;
  owner: string;
}

const HEADER_RE =
  /^\[窓口B→裏方\] ((?:\d{2}\/\d{2} )?\d{2}:\d{2}(?:#\d+)?)(?: ユーザー原文(?:\(担当:([^)]*)\))?)?: ?「(.*)$/;

/** 受信箱の `[窓口B→裏方]` 行を、**次の依頼の行まで**本文として読む(行数で切らない)。古い順。 */
export function parseInboxRequests(text: string): InboxRequest[] {
  const lines = text.split(/\r?\n/);
  const out: InboxRequest[] = [];
  let current: { key: string; owner: string; buf: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.buf
      .join("\n")
      .replace(/」\s*$/, "")
      .trim();
    out.push({ key: current.key, text: body, owner: current.owner });
    current = null;
  };
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      current = { key: m[1], owner: (m[2] ?? "").trim(), buf: [m[3]] };
      continue;
    }
    if (current) {
      // 別の差出しの見出しに当たったら依頼は終わり(受信箱の本文には入らない)。箇条書きの記録
      // (`- [司令塔向け自動] …` など)も依頼ではないので、そこで切って素の区切りも通す。
      if (/^\s*(?:[-*+]\s+)?\[[^\]]*→[^\]]*\]/.test(line)) {
        flush();
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) continue;
      current.buf.push(line);
    }
  }
  flush();
  const fullKeys = normalizeInboxKeys(out.map((r) => r.key));
  return out.map((r, i) => ({ key: fullKeys[i], text: r.text, owner: r.owner }));
}

// ---------------------------------------------------------------- 本文の項目分け(推測の行)

const BOILERPLATE_RE = /(ご確認ください|よろしくお願いします|一旦保留です)/;
const QUOTE_LEAD_RE = /^(?:\s*>\s*)+\s*(?:- )?/;
const LEAD_RE =
  /^(?:そして|というか|あとは|それと|えっと|まず|ちなみに|あと|で、|なんで|いや、)[\s、,]*/;
const REQUEST_RE =
  /(してよ|してほしい|してください|して下さい|しないで|すべき|べきでしょ|べきだ|べき|調べて|調べる|調査して|ためして|試して|作って|直して|なおして|変えて|教えて|確認して|確認し|開いて|開ける|外して|外すべき|閉じ|消して|増やして|減らして|追加して|入れて|動く|動くのか|はどうなる)/;
const QUESTION_WORD_RE =
  /(どうなる|どうし|どうやる|なんで|何が|ないの|あるの|するの|んのか|ですか|でしょうか)/;

/** 文に分ける(句点・疑問符・感嘆符と改行)。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。？?！!]+|\n+/)
    .map((s) => s.trim().replace(/^[、,・\s]+|[、,・\s]+$/g, ""))
    .filter((s) => s.length > 0);
}

/** 要約の見た目整え(引用の印とつなぎ言葉を外す)。 */
export function tidySummary(sentence: string): string {
  return sentence.replace(QUOTE_LEAD_RE, "").replace(LEAD_RE, "").trim();
}

function isRequestSentence(s: string): boolean {
  if (BOILERPLATE_RE.test(s)) return false;
  return /[？?]\s*$/.test(s) || QUESTION_WORD_RE.test(s) || REQUEST_RE.test(s);
}

/** 依頼の本文から項目を抜き出す。用件らしい文が無ければ文全体を1項目として返す(空なら空)。 */
export function extractRequestItems(text: string): string[] {
  const sentences = splitSentences(text);
  const picked = sentences.filter(isRequestSentence);
  if (picked.length === 0) {
    const joined = sentences.join(" ").trim();
    return joined ? [joined] : [];
  }
  return picked.map((s) => tidySummary(s) || s);
}

// ---------------------------------------------------------------- 子スレとプロジェクト

interface ThreadRow {
  id: string;
  title: string;
  status: string;
  machineState: string;
  archived: boolean;
  /** 最後に更新された時刻(epoch 秒)。自己申告が無い出所(優先順位台帳だけ)では null。 */
  updatedAt: number | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 「まだ無い」と「あるが読めない」を分けて読む(`readJson` は両方 null にするため)。
 * 書きかけ(`os.replace` 前の一時ファイルではなく、稀に起こる部分読み)を拾ったときのために、
 * 構文エラーなら少し待って1回だけ読み直す(2026-10-28 出口レビュー1巡目)。
 */
type JsonRead = { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "broken" };

async function readJsonDetailed(file: string): Promise<JsonRead> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string;
    try {
      text = await fsp.readFile(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return { kind: "broken" };
    }
    try {
      return { kind: "ok", value: JSON.parse(text) };
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return { kind: "broken" };
}

/** `child_threads.json` → id(完全と短縮の両方)で引ける表。 */
export function readThreads(confirmBoxDir: string): Map<string, ThreadRow> | null {
  const raw = readJson(path.join(confirmBoxDir, "child_threads.json"));
  return raw ? threadsFromChildThreads(raw) : readsAllPending(confirmBoxDir);
}

/** 子スレ一覧(自己申告の状態)が読めない／まだ無いときの保険。優先順位台帳の開発プロジェクトに
 * 紐づくスレの ID だけ分かるので、そのスレを「進捗不明」で出す(「子スレ一覧に無い」と誤って出さない)。
 * 状態は分からないので、完了とはしない。
 */
function readsAllPending(confirmBoxDir: string): Map<string, ThreadRow> | null {
  const raw = readJson(path.join(confirmBoxDir, "priority_ledger.json"));
  const list = raw && typeof raw === "object" ? (raw as { projects?: unknown }).projects : null;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, ThreadRow>();
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const row = p as Record<string, unknown>;
    const id = str(row.thread).toLowerCase();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) continue;
    const thread: ThreadRow = {
      id,
      title: str(row.name) || str(row.title),
      // 「完了」とは書かない(呼び出し側の語と衝突させない)。
      status: "進捗不明",
      // 状態が書かれていると progressOf が「作業中」と読むので、印を付けておく。
      machineState: "unknown",
      archived: false,
      updatedAt: null,
    };
    out.set(id, thread);
    out.set(id.slice(0, 8), thread);
  }
  return out.size > 0 ? out : null;
}
/** 確認箱の `child_threads.json` の形(`{ threads: [{ agent_id, title, declared_status, machine_state }] }`)。 */
function threadsFromChildThreads(raw: unknown): Map<string, ThreadRow> | null {
  const list = raw && typeof raw === "object" ? (raw as { threads?: unknown }).threads : null;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, ThreadRow>();
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const row = t as Record<string, unknown>;
    const id = str(row.agent_id).toLowerCase();
    if (!id) continue;
    const thread: ThreadRow = {
      id,
      title: str(row.title),
      // 常駐の窓口は `待機` を台帳の status に書くこともある(実態は自己申告側)。
      status: str(row.declared_status) || str(row.status),
      machineState: str(row.machine_state),
      archived: row.archived === true,
      updatedAt: num(row.updated_at),
    };
    out.set(id, thread);
    out.set(id.slice(0, 8), thread);
  }
  return out;
}

/** 子スレの進捗。自己申告の状態を先に見て、無ければ Paseo の稼働状態で決める。 */
export function progressOf(thread: ThreadRow): LedgerProgress {
  // 先に「待ち」を見る(「ユーザー判断待ち」「完了待ち」)。完了は先頭一致にする
  // (「未完了」のような、中に完了を含むだけの語を完了と読まないため。2026-10-28 出口レビュー1巡目)。
  if (thread.status.includes("待ち")) return "waiting";
  if (thread.status.trim().startsWith("完了")) return "done";
  if (thread.machineState === "unknown") return "unknown";
  if (thread.machineState === "running") return "working";
  if (thread.machineState === "error") return "stopped";
  if (thread.machineState === "idle" || thread.machineState === "closed") return "stopped";
  return thread.status ? "working" : "unknown";
}

function childOf(id: string, threads: Map<string, ThreadRow> | null): LedgerChild {
  const thread = threads?.get(id.toLowerCase());
  if (!thread) return { id, title: "", progress: "unknown", status: "", missing: true };
  return {
    id,
    title: thread.title,
    progress: progressOf(thread),
    status: thread.status,
    missing: false,
  };
}

interface ProjectRow {
  id: string;
  name: string;
  note: string;
  thread: string | null;
  /** 順位を持たない「常時の方針」の行・片付けた行(優先順位画面の一覧に出ない。付けない)。 */
  standing: boolean;
  archived: boolean;
}

function readProjects(confirmBoxDir: string): ProjectRow[] | null {
  const raw = readJson(path.join(confirmBoxDir, "priority_ledger.json"));
  const list = raw && typeof raw === "object" ? (raw as { projects?: unknown }).projects : null;
  if (!Array.isArray(list)) return null;
  return list
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .map((p) => ({
      id: str(p.id),
      name: str(p.name),
      note: str(p.note),
      thread: str(p.thread) || null,
      standing: p.standing === true,
      archived: p.archived === true,
    }))
    .filter((p) => p.id && p.name);
}

/**
 * 行の開発プロジェクトを決める。順に:
 * 1. 振った子スレが優先順位台帳の `thread` と同じ
 * 2. 要約・項目・依頼全文にプロジェクト名が出てくる(長い名前から1つ)
 * 3. 要約などの文字とプロジェクトの説明(`note`)の似ている度(短い語が紛れないよう
 *    3文字以上の共通の並びを数え、しきい値を超えたら付ける)
 * 4. 付かないときは null(無理に付けない。近いだけの候補は出さない=取り違えた印を付けない)。
 */
export function matchProject(
  row: { texts: readonly string[]; childIds: readonly string[] },
  projects: readonly ProjectRow[],
): { id: string; name: string } | null {
  for (const p of projects) {
    if (p.thread && row.childIds.some((id) => id.toLowerCase() === p.thread!.toLowerCase())) {
      return { id: p.id, name: p.name };
    }
  }
  const haystack = row.texts.join("\n");
  const byName = [...projects]
    .sort((a, b) => b.name.length - a.name.length)
    .find((p) => p.name.length >= 4 && haystack.includes(p.name));
  if (byName) return { id: byName.id, name: byName.name };

  // 説明(note)は「2026-10-27 14:11 ユーザー『…』」のような前置きを含むので、鍵になる語だけを比べる。
  // いつも出てくる「ユーザー」「裏方」「スレ」「次の」などは落とす。2つの表記が両方あるときだけ数え、
  // 似ている度 = 表記のうちが同じ数 / 短い側の長さ。しきい値未満なら付けない(取り違えを避ける)。
  const rowKeys = keptBigrams(row.texts.join(" "));
  let best: { p: ProjectRow; score: number; count: number } | null = null;
  for (const p of projects) {
    const noteKeys = keptBigrams(p.note);
    if (noteKeys.size < 3 || rowKeys.size < 3) continue;
    let count = 0;
    for (const g of noteKeys) if (rowKeys.has(g)) count += 1;
    const score = count / Math.min(noteKeys.size, rowKeys.size);
    if (!best || score > best.score || (score === best.score && count > best.count)) {
      best = { p, score, count };
    }
  }
  return best && best.score >= 0.25 && best.count >= 3
    ? { id: best.p.id, name: best.p.name }
    : null;
}

/** 比べない2文字(どこにでも出るつなぎの語)。 */
const COMMON_BIGRAMS = new Set([
  "ユー",
  "ーザ",
  "ザー",
  "の",
  "は",
  "を",
  "に",
  "が",
  "で",
  "と",
  "も",
  "や",
  "し",
  "て",
  "い",
  "か",
  "裏方",
  "方",
  "スレ",
  "次の",
  "今回",
  "対応",
  "確認",
  "して",
  "する",
  "です",
  "ます",
  "った",
  "って",
  "こと",
  "もの",
  "よう",
  "ため",
  "ひと",
  "とても",
  "本当",
]);

function keptBigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const g of bigrams(text)) if (!COMMON_BIGRAMS.has(g)) out.add(g);
  return out;
}

function bigrams(text: string): Set<string> {
  // 文の切れ目(句読点・記号)を空白にしてから空白で割る=文をまたぐ2文字を作らない
  // (「…して」と「」」が重なるような偶然の一致を数えない)。助詞・助動詞はそこでも切る
  // (「して」だけを共有する「作り直して」と「やって」のような重なりを数えない)。
  const cleaned = text.replace(/[\s、,。．.・「」『』()（）:：；;！!？?#/]+/g, " ");
  const particles = /(?:して|する|した|してる|してほしい|について|として|ように|こと|もの)/g;
  const out = new Set<string>();
  for (const segment of cleaned.split(" ")) {
    for (const piece of segment.replace(particles, " ").split(" ")) {
      for (let i = 0; i + 2 <= piece.length; i += 1) out.add(piece.slice(i, i + 2));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 組み立て

interface ItemRowRecord {
  key: string;
  item_no: number;
  summary: string;
  source: string;
  target: string;
  kind: string;
  agent_id: string | null;
  owner: string;
  received_at: number | null;
  replied_at: number | null;
  target_set_at: number | null;
  status: string;
}

function toItem(r: Record<string, unknown>): ItemRowRecord {
  return {
    key: str(r.key),
    item_no: Number(r.item_no),
    summary: str(r.summary),
    source: str(r.source) || str(r.summary),
    target: str(r.target),
    kind: str(r.kind),
    agent_id: str(r.agent_id) || null,
    owner: str(r.owner),
    received_at: typeof r.received_at === "number" ? r.received_at : null,
    replied_at: typeof r.replied_at === "number" ? r.replied_at : null,
    target_set_at: typeof r.target_set_at === "number" ? r.target_set_at : null,
    status: str(r.status),
  };
}

function usableItem(r: unknown): r is Record<string, unknown> {
  return (
    Boolean(r) &&
    typeof r === "object" &&
    Boolean(str((r as Record<string, unknown>).key)) &&
    typeof (r as Record<string, unknown>).item_no === "number"
  );
}

function readItems(file: string): ItemRowRecord[] | null {
  const raw = readJson(file);
  const list = raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(list)) return null;
  return list.filter(usableItem).map(toItem);
}

/**
 * 台帳が14日を過ぎて落とした記録の控え(`window_b_items_archive.jsonl`、1行1項目)。
 * これがある鍵は「台帳に記録があった」ものとして、受信箱からの推測で作り直さない
 * (作り直すと完了済みの依頼が「推測・振り先の記録なし」として戻り、永久に溜まる)。
 */
function readArchive(file: string): ItemRowRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: ItemRowRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (usableItem(value)) out.push(toItem(value));
    } catch {
      // 控えの1行が壊れていても他の行は読む。
    }
  }
  return out;
}

const CHILD_ID_RE = /^[0-9a-f]{8,36}$/;

function toKind(value: string, target: string): LedgerKind {
  if (
    (value === "子スレ" || value === "代理決定" || value === "投函" || value === "説明のみ") &&
    target
  ) {
    return value;
  }
  if (!target) return "";
  if (CHILD_ID_RE.test(target.toLowerCase())) return "子スレ";
  return "説明のみ";
}

/** 受信箱の本文から「→ 子スレ <id>」の形で書かれた振り先を拾う(台帳の項目が無い古い依頼の補い)。 */
const INFERRED_CHILD_RE = /→\s*子スレ\s*([0-9a-f]{8,36})/gi;

function inferTarget(text: string): { kind: LedgerKind; targets: string[] } {
  const ids = [...text.matchAll(INFERRED_CHILD_RE)].map((m) => m[1].toLowerCase());
  if (ids.length === 0) return { kind: "", targets: [] };
  return { kind: "子スレ", targets: [...new Set(ids)] };
}

/** 1行を作るときに渡す材料(台帳の項目から作るか、受信箱から推測するかで埋め方が違う)。 */
interface RowInput {
  key: string;
  itemNo: number;
  itemCount: number;
  summary: string;
  source: string;
  receivedAt: number | null;
  kind: LedgerKind;
  target: string;
  childIds: string[];
  settledWithoutChild: boolean;
  done: boolean;
  inferred: boolean;
  targetSetAt: number | null;
  repliedAt: number | null;
  owner: string;
  fullText: string;
}

/** 行の材料を、子スレの進捗と開発プロジェクトを付けて1行にする。 */
function toLedgerRow(
  input: RowInput,
  threads: Map<string, ThreadRow> | null,
  ranked: readonly ProjectRow[],
): LedgerRow {
  const children = input.childIds.map((id) => childOf(id, threads));
  const project =
    ranked.length > 0
      ? matchProject({ texts: [input.summary, input.source], childIds: input.childIds }, ranked)
      : null;
  return {
    id: `${input.key}#${input.itemNo}`,
    key: input.key,
    itemNo: input.itemNo,
    itemCount: input.itemCount,
    summary: input.summary,
    source: input.source,
    fullText: input.fullText,
    receivedAt: input.receivedAt,
    kind: input.kind,
    target: input.target,
    children,
    settledWithoutChild: input.settledWithoutChild,
    inferred: input.inferred,
    done: input.done,
    targetSetAt: input.targetSetAt,
    repliedAt: input.repliedAt,
    owner: input.owner,
    project,
  };
}

/** 項目の台帳(正)の行。受信箱に全文があれば付ける。 */
function rowsFromItems(
  items: readonly ItemRowRecord[],
  inboxByKey: Map<string, InboxRequest>,
  threads: Map<string, ThreadRow> | null,
  ranked: readonly ProjectRow[],
): { rows: LedgerRow[]; keys: Set<string> } {
  const rows: LedgerRow[] = [];
  const keys = new Set<string>();
  const grouped = new Map<string, ItemRowRecord[]>();
  for (const it of items) {
    const list = grouped.get(it.key) ?? [];
    list.push(it);
    grouped.set(it.key, list);
  }
  for (const [key, list] of grouped) {
    keys.add(key);
    const full = inboxByKey.get(key)?.text ?? "";
    for (const it of list) {
      const kind = toKind(it.kind, it.target);
      const settled = kind !== "" && kind !== "子スレ";
      rows.push(
        toLedgerRow(
          {
            key,
            itemNo: it.item_no,
            itemCount: list.length,
            summary: it.summary || tidySummary(it.source) || it.source,
            source: it.source,
            receivedAt: it.received_at,
            kind,
            target: it.target,
            childIds: kind === "子スレ" ? [it.agent_id || it.target] : [],
            settledWithoutChild: settled,
            done: it.status === "完了" || settled,
            inferred: false,
            targetSetAt: it.target_set_at,
            repliedAt: it.replied_at,
            owner: it.owner,
            fullText: full,
          },
          threads,
          ranked,
        ),
      );
    }
  }
  return { rows, keys };
}

/** 台帳に項目が無い依頼を、本文の文から補う(推測の行。完了にはしない)。
 * `sinceKey` を渡すと、その鍵より古い依頼は補わない(台帳が受け付けた範囲の外側だけを補う)。 */
function rowsFromInbox(
  inbox: readonly InboxRequest[],
  keysWithItems: ReadonlySet<string>,
  threads: Map<string, ThreadRow> | null,
  ranked: readonly ProjectRow[],
  sinceKey: string | null,
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const req of inbox) {
    if (keysWithItems.has(req.key)) continue;
    if (sinceKey !== null && keySortValue(req.key) < sinceKey) continue;
    const sentences = extractRequestItems(req.text);
    const sources = sentences.length > 0 ? sentences : [req.text.trim()].filter(Boolean);
    const inferred = inferTarget(req.text);
    for (const [i, source] of sources.entries()) {
      rows.push(
        toLedgerRow(
          {
            key: req.key,
            itemNo: i + 1,
            itemCount: sources.length,
            summary: tidySummary(source) || source,
            source,
            receivedAt: null,
            kind: inferred.kind,
            target: inferred.targets.join(","),
            childIds: inferred.targets,
            settledWithoutChild: false,
            done: false,
            inferred: true,
            targetSetAt: null,
            repliedAt: null,
            owner: req.owner,
            fullText: req.text,
          },
          threads,
          ranked,
        ),
      );
    }
  }
  return rows;
}

export async function buildTaskLedger(
  dirs: TaskLedgerDirs = resolveTaskLedgerDirs(),
): Promise<TaskLedgerListOutput> {
  const notes: string[] = [];

  let items: ItemRowRecord[] | null = null;
  try {
    items = readItems(itemsFile(dirs));
  } catch {
    items = null;
  }
  if (items === null) {
    // Python 側は一時ファイルから os.replace で書き替えるので、途中の形を読むのは稀。それでも
    // 「まだありません」(ENOENT)と「あるが読めない」を分けて出す(後者は notes で知らせる)。
    const broken = (await readJsonDetailed(itemsFile(dirs))).kind === "broken";
    notes.push(
      broken
        ? "項目の台帳(window_b_items.json)を読めません。受信箱から推測して表示しています。"
        : "項目の台帳(window_b_items.json)がまだありません。受信箱から推測して表示しています。",
    );
  }
  // 14日を過ぎて台帳から落とした控え(鍵だけ足して、推測で作り直さない)。
  const archived = readArchive(path.join(dirs.itemsDir, "window_b_items_archive.jsonl"));

  let inboxText = "";
  let inboxOk = false;
  try {
    inboxText = fs.readFileSync(dirs.inboxPath, "utf-8");
    inboxOk = true;
  } catch {
    notes.push("受信箱(coordinator_inbox.md)を読めません。");
  }
  const inbox = inboxOk ? parseInboxRequests(inboxText) : [];
  const inboxByKey = new Map(inbox.map((r) => [r.key, r]));

  const threads = readThreads(dirs.confirmBoxDir);
  if (threads === null)
    notes.push("子スレの状態(child_threads.json)を読めません。進捗は「不明」になります。");
  const projects = readProjects(dirs.confirmBoxDir);
  if (projects === null) notes.push("優先順位台帳を読めません。開発プロジェクトは付きません。");
  // 優先順位画面の一覧に出る行だけを照合に使う(「常時の方針」・片付けた行には付けない)。
  const ranked = projects?.filter((p) => !p.standing && !p.archived) ?? [];

  const fromItems = rowsFromItems(items ?? [], inboxByKey, threads, ranked);
  // 台帳が読めているとき、推測で補うのは「台帳が受け付けた最も古い鍵」より新しい依頼だけにする
  // (古い依頼まで補うと、片付いた依頼が「振り先の記録なし」で永久に並ぶ。2026-10-28 出口レビュー)。
  const itemsKeys = [...fromItems.keys, ...archived.map((a) => a.key)];
  const sinceKey =
    items !== null && items.length > 0
      ? itemsKeys.map(keySortValue).reduce((a, b) => (a < b ? a : b))
      : null;
  const fromInbox = rowsFromInbox(
    inbox,
    new Set([...fromItems.keys, ...archived.map((a) => a.key)]),
    threads,
    ranked,
    sinceKey,
  );

  return {
    rows: [...fromItems.rows, ...fromInbox],
    notes,
    sources: {
      items: items !== null && items.length > 0,
      itemsArchive: archived.length > 0,
      inbox: inboxOk,
      childThreads: threads !== null,
      priority: projects !== null,
    },
  };
}
