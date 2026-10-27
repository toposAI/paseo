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
    out.push({
      id,
      name,
      note: typeof rec.note === "string" ? rec.note : "",
      thread: typeof rec.thread === "string" && rec.thread.trim() ? rec.thread.trim() : null,
      ...(rec.new === true ? { isNew: true } : {}),
      ...(rec.auto === true ? { auto: true } : {}),
      ...(rec.archived === true
        ? {
            archived: true,
            ...(typeof rec.archived_ts === "number" ? { archivedTs: rec.archived_ts } : {}),
            ...(typeof rec.archived_by === "string" ? { archivedBy: rec.archived_by } : {}),
          }
        : {}),
    });
  }
  return out.length > 0 ? out : null;
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
  const { isNew, archivedTs, archivedBy, ...rest } = p;
  return {
    ...rest,
    ...(isNew ? { new: true } : {}),
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

/** 一覧に出す行(アーカイブ済みを除く)と、アーカイブ済みの行(新しい順)。 */
export function splitArchived(projects: readonly PriorityProject[]): {
  visible: PriorityProject[];
  archived: PriorityProject[];
} {
  const visible = projects.filter((p) => p.archived !== true);
  const archived = projects
    .filter((p) => p.archived === true)
    .sort((a, b) => (b.archivedTs ?? 0) - (a.archivedTs ?? 0));
  return { visible, archived };
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
  const next = projects.map((p) => (p.archived === true ? p : (byId.get(order[k++]) as PriorityProject)));
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
    next[idx] = { ...cur, isNew: undefined, archived: true, archivedTs: Date.now(), archivedBy: "ui" };
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
