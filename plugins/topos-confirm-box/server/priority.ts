/**
 * 開発の優先順位台帳。確認箱ディレクトリ配下の4ファイルで持つ:
 *
 * - `priority_ledger.json`          … 正本。`{version,updated_ts,projects:[{id,name,note,thread?}]}`。順位=配列の添字
 * - `priority_ledger_history.jsonl` … 変更のたびに変更前の projects を1行追記(戻す用。上書きしない)
 * - `priority_requests.jsonl`       … 自由記述の要求 `{ts,text}`(解釈担当が読む)
 * - `priority_replies.jsonl`        … 返答 `{ts,re,by,text}`(`re` = 要求の ts)。by=ack|worker|fallback
 *
 * UI側が書くのは move(直接並べ替え)と requests/ack だけ。自由記述の**解釈と台帳更新**は
 * データ担当(別プロセス)が requests を読んで行い、台帳と replies に書き戻す。
 */
import fs from "node:fs";
import path from "node:path";
import type { PriorityProject, PriorityReply } from "../shared/contract.js";

export const LEDGER_FILE = "priority_ledger.json";
export const HISTORY_FILE = "priority_ledger_history.jsonl";
export const REQUESTS_FILE = "priority_requests.jsonl";
export const REPLIES_FILE = "priority_replies.jsonl";
const TEXT_MAX = 400;
const REPLIES_SHOWN = 20;

/** 初期値。1位は依頼どおり「確認箱とサイドバー拡充」。2位以降は仮置き(ユーザーが並べ替える前提)。 */
export const DEFAULT_PROJECTS: readonly PriorityProject[] = [
  { id: "confirm-box", name: "確認箱とサイドバー拡充", note: "", thread: null },
  { id: "topos-family-ui", name: "Topos家族版(UI・配布)", note: "", thread: null },
  { id: "f80", name: "F-80(逐語ゲート・出典)", note: "", thread: null },
  { id: "vault-search-topos", name: "Paseo Vault検索のTopos寄せ", note: "", thread: null },
  { id: "ios-139", name: "139番 iOSアプリ(音声・Paseo画面)", note: "", thread: null },
  { id: "ocr-145", name: "145番 医学書OCR再開", note: "", thread: null },
  { id: "topos-web-search", name: "Topos Web検索(BYOK)", note: "", thread: null },
  { id: "memory-daemons", name: "メモリ・常駐デーモン軽量化", note: "", thread: null },
  { id: "thread-automation", name: "司令塔・スレ運用の自動化", note: "", thread: null },
  { id: "ebm-107", name: "107番 EBMアシスタント", note: "", thread: null },
];

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 台帳の projects を正規化する。**件数で切らない**(2026-10-23 ユーザー指示):
 * 以前は先頭10件に切り捨てて返していたため、11位以降が画面に出ず、画面で並べ替えると
 * 台帳からも消えていた。上限は台帳側(データ担当の受け入れ上限)が持つ。
 * 未知のフィールドは捨てるが **`thread` は残す**(並べ替えで書き戻すので、落とすと紐付けが消える)。
 */
export function normalizeProjects(raw: unknown): PriorityProject[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PriorityProject[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push(toProjectRow(rec, id, name));
  }
  return out.length > 0 ? out : null;
}

/** 台帳の1行をUIの形へ。`archived`/`standing` は印が付いているときだけ載せる(古い応答を偽にしない)。 */
function toProjectRow(rec: Record<string, unknown>, id: string, name: string): PriorityProject {
  const archived =
    rec.archived === true
      ? {
          archived: true as const,
          ...(typeof rec.archived_ts === "number" ? { archivedTs: rec.archived_ts } : {}),
          ...(typeof rec.archived_by === "string" ? { archivedBy: rec.archived_by } : {}),
        }
      : {};
  return {
    id,
    name,
    note: typeof rec.note === "string" ? rec.note : "",
    thread: typeof rec.thread === "string" && rec.thread.trim() ? rec.thread.trim() : null,
    ...(rec.new === true ? { isNew: true } : {}),
    ...(rec.auto === true ? { auto: true } : {}),
    ...(rec.standing === true ? { standing: true } : {}),
    ...archived,
  };
}

/** 台帳を読む。無い/壊れていれば初期値(ディスクには書かない=読むだけで副作用を出さない)。 */
export function readLedger(dir: string): { projects: PriorityProject[]; updatedTs: number } {
  const rec = readJson(path.join(dir, LEDGER_FILE)) as Record<string, unknown> | null;
  const projects = normalizeProjects(rec?.projects);
  if (!projects) return { projects: [...DEFAULT_PROJECTS], updatedTs: 0 };
  return { projects, updatedTs: typeof rec?.updated_ts === "number" ? rec.updated_ts : 0 };
}

/** UIの `isNew`(読み込み時に `new` から写す)を台帳の `new` に戻す。`auto` はそのまま通す。 */
function toLedgerRow(p: PriorityProject): Record<string, unknown> {
  const { isNew, standing, archivedTs, archivedBy, ...rest } = p;
  return {
    ...rest,
    ...(isNew ? { new: true } : {}),
    ...(standing ? { standing: true } : {}),
    ...(archivedTs !== undefined ? { archived_ts: archivedTs } : {}),
    ...(archivedBy !== undefined ? { archived_by: archivedBy } : {}),
  };
}

function writeLedger(dir: string, projects: readonly PriorityProject[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LEDGER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      { version: 1, updated_ts: Date.now(), projects: projects.map(toLedgerRow) },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  fs.renameSync(tmp, file);
}

function appendLine(dir: string, name: string, rec: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, name), JSON.stringify(rec) + "\n", "utf-8");
}

/** 一覧に出す行(アーカイブ済みと常時の方針を除く)・アーカイブ済み(新しい順)・常時の方針(台帳の順)。 */
export function splitArchived(projects: readonly PriorityProject[]): {
  visible: PriorityProject[];
  archived: PriorityProject[];
  standing: PriorityProject[];
} {
  const visible = projects.filter((p) => p.archived !== true && p.standing !== true);
  const standing = projects.filter((p) => p.archived !== true && p.standing === true);
  const archived = projects
    .filter((p) => p.archived === true)
    .sort((a, b) => (b.archivedTs ?? 0) - (a.archivedTs ?? 0));
  return { visible, archived, standing };
}

/**
 * 順位を直接変える。`toRank` は**画面に見えている行**(アーカイブ済みを除く)の何位か。
 * 変更前の並びを履歴へ残してから書く(戻せる)。アーカイブ済みの行は台帳の中で動かさない。
 */
export function moveProject(
  dir: string,
  id: string,
  toRank: number,
): { ok: boolean; message: string } {
  const { projects } = readLedger(dir);
  const { visible } = splitArchived(projects);
  // 一覧に出ていない行(アーカイブ済み・常時の方針)は、動かす対象の外なので元の位置に残す
  const shown = new Set(visible.map((p) => p.id));
  const fromVisible = visible.findIndex((p) => p.id === id);
  if (fromVisible < 0) return { ok: false, message: "その項目は台帳にありません" };
  const toVisible = Math.min(Math.max(toRank, 1), visible.length) - 1;
  if (toVisible === fromVisible) return { ok: true, message: "順位は変わりません" };
  appendLine(dir, HISTORY_FILE, { ts: Date.now(), by: "ui-move", before: projects });
  const order = visible.map((p) => p.id);
  const [movedId] = order.splice(fromVisible, 1);
  order.splice(toVisible, 0, movedId);
  // 見えている行だけを新しい順に並べ直し、アーカイブ済みは元の位置(添字)のまま残す
  const byId = new Map(projects.map((p) => [p.id, p]));
  let k = 0;
  const next = projects.map((p) =>
    shown.has(p.id) ? (byId.get(order[k++]) as PriorityProject) : p,
  );
  const to = next.findIndex((p) => p.id === id);
  const item = next[to];
  // ユーザーが動かした=確認済み。『新規』の印を外す(台帳の `new`)。
  next[to] = { ...item, isNew: undefined };
  writeLedger(dir, next);
  return { ok: true, message: `「${item.name}」を ${toVisible + 1} 位にしました` };
}

/** 行をアーカイブする/戻す。台帳から消さず印だけ。履歴へ変更前を残す。 */
export function archiveProject(
  dir: string,
  id: string,
  archived: boolean,
): { ok: boolean; message: string } {
  const { projects } = readLedger(dir);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, message: "その項目は台帳にありません" };
  const cur = projects[idx];
  if ((cur.archived === true) === archived) {
    return { ok: true, message: archived ? "すでにアーカイブ済みです" : "すでに一覧にあります" };
  }
  appendLine(dir, HISTORY_FILE, {
    ts: Date.now(),
    by: archived ? "ui-archive" : "ui-unarchive",
    before: projects,
  });
  const next = [...projects];
  if (archived) {
    next[idx] = {
      ...cur,
      isNew: undefined,
      archived: true,
      archivedTs: Date.now(),
      archivedBy: "ui",
    };
  } else {
    // 戻した行は一覧の末尾に置く(元の順位は他の行が動いて意味を失っているため)
    const { archived: _a, archivedTs: _t, archivedBy: _b, ...rest } = cur;
    next.splice(idx, 1);
    next.push(rest);
  }
  writeLedger(dir, next);
  return {
    ok: true,
    message: archived ? `「${cur.name}」をアーカイブしました` : `「${cur.name}」を一覧に戻しました`,
  };
}

/** 自由記述を受ける。要求を追記し、受領の返答を**同期で必ず1行**書く(fail-open)。 */
export function sayToLedger(dir: string, text: string): { ok: boolean; message: string } {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
  if (!clean) return { ok: false, message: "空です" };
  const ts = Date.now();
  appendLine(dir, REQUESTS_FILE, { ts, text: clean });
  appendLine(dir, REPLIES_FILE, {
    ts,
    re: ts,
    by: "ack",
    text: "受け取りました。解釈して順位に反映します(反映されたらここに返事が出ます)",
  });
  return { ok: true, message: "送りました" };
}

/**
 * 優先順位の一覧から外して「常時の方針」欄で管理する行(`standing: true`)。
 * 2026-10-28 ユーザー指示:『トークン節約は今は待機してまた評価になってるはず、それは優先順位一覧には出さずに別で管理すべきでは？』。
 * 台帳に印を足すだけ(名前を変えないので、Python側の `notify_box.sort_items` の project 照合はそのまま効く)。
 * 判定は印だけを見る(名前から推測しない。推測すると印を外しても一覧に戻らない)。
 */

/** 台帳の行に `standing` 印を付ける/外す。付けるときは順位の並びから外す(一覧の順位=見えている行の順)。 */
export function markStanding(
  dir: string,
  id: string,
  standing: boolean,
): { ok: boolean; message: string } {
  const { projects } = readLedger(dir);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, message: "その項目は台帳にありません" };
  const cur = projects[idx];
  if ((cur.standing === true) === standing) {
    return { ok: true, message: standing ? "すでに方針欄にあります" : "すでに一覧にあります" };
  }
  appendLine(dir, HISTORY_FILE, {
    ts: Date.now(),
    by: standing ? "ui-standing" : "ui-unstanding",
    before: projects,
  });
  const { standing: _s, ...rest } = cur;
  const row = standing ? { ...rest, standing: true } : rest;
  const next = [...projects];
  next[idx] = row;
  if (standing) {
    // 一覧から外す=並びの末尾へ回す(戻すと末尾に並ぶ。元の順位は他の行が動いて意味を失っているため)
    next.splice(idx, 1);
    next.push(row);
  }
  writeLedger(dir, next);
  return {
    ok: true,
    message: standing
      ? `「${cur.name}」を常時の方針へ移しました`
      : `「${cur.name}」を一覧の末尾に戻しました`,
  };
}

/** 行の中身を開くときの材料。子スレは呼び出し側が読んだ一覧を渡す(サーバーで二重に読まない)。 */
export interface DetailThread {
  agentId: string;
  title: string;
  status: string;
  machineState: string | null;
}

const DETAIL_RELATED_MAX = 10;
const DETAIL_QUESTIONS_MAX = 10;
/** 動いている行を先に出す(「まだ動いているのか」が開いてすぐ分かる)。 */
function liveFirst(a: DetailThread, b: DetailThread): number {
  const live = (t: DetailThread) => (t.status === "完了" ? 1 : 0);
  return live(a) - live(b) || a.title.localeCompare(b.title, "ja");
}

/**
 * 「まだ動いているもの」の件数。担当スレ(`thread`)と、題名が同じ子スレを数える。
 * 行をアーカイブすると**一覧から外れるだけ**で、子スレは止めない。止める操作と混同させないため、
 * 画面はこの件数が1以上のときだけ「動いているものがN件あります」と一度確認する。
 */
export function countRunning(project: PriorityProject, threads: readonly DetailThread[]): number {
  return threads.filter(
    (t) =>
      (t.agentId === project.thread || sameName(t.title, project.name)) &&
      t.status !== "完了" &&
      t.status !== "待機" &&
      t.machineState !== "closed",
  ).length;
}

/**
 * 題名の突き合わせ用。括弧書き(「(2本目)」「[ab12cd34]」)は題名の違いと見なさず、
 * それ以外の記号・空白・大小の違いも同じものと見なす。
 */
export function sameName(a: string, b: string): boolean {
  // 括弧は外すが**中身は残す**(「F-80(逐語ゲート)」と「F-80(まとめノート)」を同じにしない)
  const norm = (s: string) =>
    s
      .replace(/[()（）[\]【】]/g, "")
      .replace(/[\s・:：,、.。\-—–_/]/g, "")
      .toLowerCase();
  // 同じ題名の2本目に付く末尾の括弧書き(「… (2本目)」「… [ab12cd34]」)だけは違いと見なさない
  const stripTail = (s: string) => s.replace(/\s*[［(（[【][^)）\]】]*[)）\]】]\s*$/, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || norm(stripTail(a)) === y || x === norm(stripTail(b));
}

/**
 * 行の中身(説明・関連する子スレ・未決の判断)。台帳の `thread` が指すスレに加えて、
 * **題名が同じ**子スレを拾う(同じプロジェクトを何本かに分けて走らせている実態を出す)。
 */
export function buildPriorityDetail(
  project: PriorityProject,
  threads: readonly DetailThread[],
  pending: readonly { id: string; subject: string; ts: number }[],
): {
  note: string;
  thread: DetailThread | null;
  related: DetailThread[];
  pendingQuestions: { id: string; subject: string; ts: number }[];
} {
  const byId = project.thread ? (threads.find((t) => t.agentId === project.thread) ?? null) : null;
  const others = threads
    .filter((t) => t.agentId !== project.thread && sameName(t.title, project.name))
    .sort(liveFirst)
    .slice(0, DETAIL_RELATED_MAX);
  return {
    note: project.note ?? "",
    thread: byId ? { ...byId } : null,
    related: others,
    pendingQuestions: pending.slice(0, DETAIL_QUESTIONS_MAX),
  };
}

/** 一覧の外にある行(アーカイブ済み・常時の方針)も中身を開けるように、台帳の全行から探す。 */
export function findProject(dir: string, id: string): PriorityProject | null {
  return readLedger(dir).projects.find((p) => p.id === id) ?? null;
}

/**
 * 未決の確認箱の項目を、`project` で台帳の項目名に突き合わせる。
 * 箱を表示用に畳んだ項目(`ConfirmBoxItem`)は `project` を持たないので、**イベントの生の行**から
 * `t:"item"` の `project` を拾う(同じ id の2件目以降は捨てる=箱の先着優先と同じ)。
 * 既に判断された(`approve`/`decide`)項目は未決に数えない。
 */
export function readOpenQuestions(
  dir: string,
  name: string,
): { id: string; subject: string; ts: number }[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^events-\d{6}\.jsonl$/.test(f))
      .sort()
      .slice(-2);
  } catch {
    return [];
  }
  const items = new Map<string, { id: string; subject: string; ts: number; project: string }>();
  const settled = new Set<string>();
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof e.id === "string" ? e.id : "";
      if (e.t === "item" && id && !items.has(id) && typeof e.ts === "number") {
        items.set(id, {
          id,
          subject: typeof e.subject === "string" ? e.subject.slice(0, 200) : "",
          ts: e.ts,
          project: typeof e.project === "string" ? e.project : "",
        });
      } else if (id && (e.t === "decide" || (e.t === "ack" && e.action === "approve"))) {
        settled.add(id);
      }
    }
  }
  return [...items.values()]
    .filter((i) => !settled.has(i.id) && sameName(i.project, name))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, DETAIL_QUESTIONS_MAX)
    .map(({ id, subject, ts }) => ({ id, subject, ts }));
}

export function readReplies(dir: string): PriorityReply[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, REPLIES_FILE), "utf-8");
  } catch {
    return [];
  }
  const out: PriorityReply[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r.ts === "number" && typeof r.text === "string") {
        out.push({
          ts: r.ts,
          re: typeof r.re === "number" ? r.re : r.ts,
          by: typeof r.by === "string" ? r.by : "",
          text: r.text,
        });
      }
    } catch {
      // 壊れた行は無視(契約)
    }
  }
  return out.slice(-REPLIES_SHOWN);
}
