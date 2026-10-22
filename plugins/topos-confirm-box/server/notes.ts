/**
 * Vault のノートを読んで、サイドバー二段の材料にする(**読むだけ**。ノートは書き換えない)。
 *
 * - 走査先の既定は live Vault の `05_Projects`(`OBSIDIAN_VAULT_DIR` / `TOPOS_CONFIRM_BOX_VAULT_DIR`
 *   で差し替え)。`Obsidian-Git`(一方向バックアップ)などは**明示的に弾く**。誤って読むと
 *   本体より遅れた古い status を出すことになるため。
 * - frontmatter は先頭の `---` ブロックだけを読む(本文は読まない。走査を速く保つ)。
 * - `type:` が `implementation` なら実装ノート(上段)、`concept` なら構想ノート(下段)。
 *   それ以外(標準ノート等)は読み飛ばす。
 * - 上段 = status が 実装中/判断待ち/確認待ち。判定は**語彙だけ**で、`完了` はここでは出さない
 *   (「ユーザーが完了を確認するまで確認待ち」= ノート側が `確認待ち` と書く決まり)。
 * - 下段 = status が 構想/壁打ち中。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOWER_TIER_STATUSES, UPPER_TIER_STATUSES, normalizeNoteStatus } from "../shared/notes.js";
import type { NoteKind, NoteStatus, SidebarNote } from "../shared/notes.js";

/** 走査するファイル数の上限(壊れた/巨大な Vault でサイドバーを止めない)。 */
export const NOTE_SCAN_LIMIT = 20_000;
/** 1つの frontmatter を読む上限。超えたら読まない(認めない)。 */
const HEAD_BYTES = 16 * 1024;
const CONCLUSION_MAX = 80;
const TITLE_MAX = 120;
const THREAD_ID_MAX = 200;

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "Obsidian_Vault");
const SKIP_DIRS = new Set([".obsidian", ".trash", "node_modules", ".git"]);

/**
 * 走査先を決める。`~` は展開する。**バックアップ(`Obsidian-Git`)配下は受け付けない**
 * (明示設定の誤りで古い status を出さないよう、throw で止める)。
 *
 * 既定は **Vault 直下ではなく `05_Projects` だけ**。Vault 全体は 6万本超で、走査上限に当たると
 * 肝心のプロジェクトノートを切り捨てる(2026-10-23 実測: 全体走査は 4.6 秒で上限到達・ノート 0 件)。
 * ルートは1本にしておく(同じディレクトリを二重に走査しない)。
 */
export function resolveNoteRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const vault =
    firstNonEmpty(env.TOPOS_CONFIRM_BOX_VAULT_DIR, env.OBSIDIAN_VAULT_DIR) || DEFAULT_VAULT;
  const expanded = expandHome(vault);
  if (/(^|[\\/])Obsidian-Git([\\/]|$)/.test(expanded)) {
    throw new Error(`バックアップは読みません(書込禁止の一方向同期先): ${expanded}`);
  }
  const projects = firstNonEmpty(env.TOPOS_CONFIRM_BOX_NOTE_DIR);
  return [projects ? expandHome(projects) : path.join(expanded, "05_Projects")];
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) if (v && v.trim().length > 0) return v.trim();
  return "";
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// ---------------------------------------------------------------- frontmatter

/** frontmatter から読めたノート(`frontmatterToNote` は type/status が揃ったものだけ返す)。 */
export interface NoteFrontmatter {
  /** `type` から決めた種類。 */
  kind: NoteKind;
  status: NoteStatus;
  title: string;
  conclusion: string;
  threadId: string | null;
  conceptLinks: string[];
}

/** frontmatter `type:` の書き方(標準形と短縮形) → ノートの種類。 */
const KIND_BY_TYPE: Readonly<Record<string, NoteKind>> = {
  "implementation-note": "implementation",
  implementation: "implementation",
  "concept-note": "concept",
  concept: "concept",
};

const STATUS_KEYS = ["status", "progress", "state"];
const TITLE_KEYS = ["title"];

/** `key: value` / `key: "value"` / `key: [a, b]` の平易な形だけを読む(リスト形式は対象外)。 */
export function parseFrontmatter(text: string): Record<string, string | string[]> | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const out: Record<string, string | string[]> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (key in out) continue; // 先勝ち(同じキーは最初の1つ)
    out[key] = parseValue(m[2]);
  }
  return out;
}

function parseValue(raw: string): string | string[] {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map(unquote)
      .filter((s) => s.length > 0);
  }
  return unquote(v);
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t[t.length - 1] === q) return t.slice(1, -1);
  }
  return t;
}

function asText(v: string | string[] | undefined, key: string): string {
  if (Array.isArray(v)) return v[0] ?? "";
  const s = v ?? "";
  // `title: [a] b` の形で括弧が壊れた場合でも、キー名自体を値として拾わない
  return s === key ? "" : s;
}

/**
 * frontmatter からノートの材料を決める。status が語彙外/無しなら null(ノートとして扱わない)。
 * スレID は frontmatter `thread_id` / `thread` / `agent_id`、`threads: [..]` の配列
 * (ブロック形式は `threadIdFromBlockList`)。本文は対象外(性能のため先頭だけ読む)。
 */
export function frontmatterToNote(
  fm: Record<string, string | string[]>,
  fallbackTitle: string,
): NoteFrontmatter | null {
  const type = asText(fm.type, "type").toLowerCase();
  const kind = KIND_BY_TYPE[type] ?? null;
  if (!kind) return null;
  let status: NoteStatus | null = null;
  for (const key of STATUS_KEYS) {
    status = normalizeNoteStatus(fm[key]);
    if (status) break;
  }
  if (!status) return null;

  let title = "";
  for (const key of TITLE_KEYS) title = title || asText(fm[key], key);
  title = (title || fallbackTitle).trim().slice(0, TITLE_MAX);

  const conclusion = firstNonEmpty(
    ...["conclusion", "summary", "one_liner"].map((k) => asText(fm[k], k)),
  );

  let threadId = "";
  for (const key of ["thread_id", "thread", "agent_id"]) {
    threadId = threadId || asText(fm[key], key);
  }
  for (const key of ["threads", "related_threads"]) {
    const v = fm[key];
    if (!threadId && Array.isArray(v)) threadId = v.find((s) => /^[0-9a-f-]{8,}$/i.test(s)) ?? "";
  }

  const links = fm.concept_notes;
  return {
    kind,
    status,
    title,
    conclusion: collapse(conclusion).slice(0, CONCLUSION_MAX),
    threadId: /^[A-Za-z0-9-]{8,200}$/.test(threadId) ? threadId.slice(0, THREAD_ID_MAX) : null,
    conceptLinks: (Array.isArray(links) ? links : []).slice(0, 20),
  };
}

/**
 * frontmatter `threads:` が**ブロック形式**でもスレを拾う(判断ノートの多くがこの形):
 *
 * ```
 * threads:
 * - 2165f646-...
 * - c389e3e
 * ```
 *
 * UUID 形だけを先頭から順に返す(無ければ空配列)。
 */
export function threadIdFromBlockList(text: string): string[] {
  const ids: string[] = [];
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return ids;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return ids;
  let inThreads = false;
  for (const line of lines.slice(1, end)) {
    if (/^threads:\s*$/.test(line)) {
      inThreads = true;
      continue;
    }
    if (!inThreads) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item) {
      // リストの外に出たら終わり(次のキー)。インデントされた継続行は読み飛ばす。
      if (/^\S/.test(line)) inThreads = false;
      continue;
    }
    const id = unquote(item[1]);
    // 短縮形(`c389e3e`)はリストの並びを止めない。UUID 形だけを候補にする。
    if (/^[0-9a-f-]{8,}$/i.test(id) && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) {
      ids.push(id.slice(0, THREAD_ID_MAX));
    }
  }
  return ids;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 先頭の frontmatter ブロックだけを読む(本文全体は読まない)。 */
export function readNoteHead(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- 走査

/**
 * サイドバー二段の材料を集める。上段(status で判定)→ 下段 の順にまとめて返す。
 * 1本のノートが壊れていても、他のノートは出す。
 */
export function readSidebarNotes(
  opts: {
    roots?: string[];
    limit?: number;
    now?: () => number;
    knownAgentIds?: ReadonlySet<string>;
  } = {},
): { notes: SidebarNote[]; roots: string[]; scanned: number; truncated: boolean } {
  const roots = opts.roots ?? resolveNoteRoots();
  const limit = opts.limit ?? NOTE_SCAN_LIMIT;
  const now = (opts.now ?? Date.now)();
  const seen = new Set<string>();
  const upper: SidebarNote[] = [];
  const lower: SidebarNote[] = [];
  let scanned = 0;
  let truncated = false;

  // 走査中に上限へ当たったら truncated を立て、呼び出し側のループを止める。
  const visit = (file: string): boolean => {
    if (scanned >= limit) {
      truncated = true;
      return true;
    }
    scanned += 1;
    const note = scanFile(file, now, { knownAgentIds: opts.knownAgentIds });
    if (!note || seen.has(note.path)) return false;
    seen.add(note.path);
    if (note.kind === "implementation" && UPPER_TIER_STATUSES.includes(note.status))
      upper.push(note);
    else if (note.kind === "concept" && LOWER_TIER_STATUSES.includes(note.status)) lower.push(note);
    return false;
  };

  outer: for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 無い/読めないディレクトリは飛ばす
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && isScannableDir(e.name)) stack.push(full);
        if (e.isDirectory()) continue;
        if (!isNoteFile(e)) continue;
        if (visit(full)) break outer;
      }
    }
  }
  return { notes: [...sortNotes(upper), ...sortNotes(lower)], roots, scanned, truncated };
}

/** 潜ってよいディレクトリか(隠しディレクトリ・既知の除外は除く)。 */
function isScannableDir(name: string): boolean {
  return !SKIP_DIRS.has(name) && !name.startsWith(".");
}

function isNoteFile(e: fs.Dirent): boolean {
  return e.isFile() && e.name.toLowerCase().endsWith(".md");
}

/**
 * ノートに書かれたスレID候補から、**実際に存在するスレ**を1つ選ぶ(タップで壁打ちする先)。
 *
 * - 既存スレの一覧(`child_threads.json` の agent id)があるときは、それに含まれる候補だけ。
 *   一致が複数なら先頭(=ノートに先に書かれたもの)。
 * - 一覧が無い(起動直後など)ときは、UUID 形の先頭を使う(短縮形 `c389e3e` は解決できない)。
 * - どれも使えなければ null(行は開けず、未解決と分かる表示になる)。
 */
export function resolveThreadId(
  candidates: readonly string[],
  knownAgentIds?: ReadonlySet<string>,
): string | null {
  if (knownAgentIds && knownAgentIds.size > 0) {
    const hit = candidates.find((id) => knownAgentIds.has(id));
    if (hit) return hit;
  }
  return candidates.find((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) ?? null;
}

interface ScanFileContext {
  /** 既存スレの一覧(無ければ候補の UUID をそのまま使う)。 */
  knownAgentIds?: ReadonlySet<string>;
}

function scanFile(file: string, now: number, opts?: ScanFileContext): SidebarNote | null {
  const head = readNoteHead(file);
  if (!head) return null;
  const fm = parseFrontmatter(head);
  if (!fm) return null;
  const fallback = path
    .basename(file, ".md")
    .replace(/^[ij]-\d{8}-/, "")
    .replace(/-/g, " ");
  const parsed = frontmatterToNote(fm, fallback);
  if (!parsed) return null;
  const meta = {
    ...parsed,
    threadIds: parsed.threadId ? [parsed.threadId] : threadIdFromBlockList(head),
  };
  let updatedAt = now;
  try {
    updatedAt = fs.statSync(file).mtimeMs;
  } catch {
    // 読めた時点の時刻でよい
  }
  const { threadIds, ...rest } = meta;
  return {
    path: file,
    updatedAt,
    ...rest,
    threadId: resolveThreadId(threadIds, opts?.knownAgentIds),
    threadCandidates: threadIds,
  };
}

/** 新しい順。同時刻はパスで安定化する。 */
export function sortNotes(notes: readonly SidebarNote[]): SidebarNote[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
}
