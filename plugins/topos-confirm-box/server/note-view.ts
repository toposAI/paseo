/**
 * 構想ノートの閲覧(**読むだけ**)。Vault の中のノートに限り、本文と `[[リンク]]` の行き先を返す。
 *
 * ガード: 実体(realpath)が live Vault の realpath の中にあること、`.md` であること、
 * バックアップ(`Obsidian-Git`)でないこと、通常ファイルであること、大きさが上限以内であること。
 * 読み出しだけで、Vault には何も書かない。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isBackupPath } from "./notes.js";

/** 読む本文の上限(バイト)。超えたら先頭だけ返して `truncated`。 */
export const NOTE_VIEW_MAX_BYTES = 1024 * 1024;
/** リンク解決のためにたどるファイル数の上限。 */
export const LINK_INDEX_LIMIT = 100_000;
const LINK_INDEX_TTL_MS = 30_000;

export interface NoteReadResult {
  ok: boolean;
  title: string;
  body: string;
  status: string;
  rel: string;
  updatedAt: number;
  truncated: boolean;
  editable: boolean;
  editBlock: string;
  raw: string;
  version: string;
  message: string | null;
}

function fail(message: string): NoteReadResult {
  return {
    ok: false,
    title: "",
    body: "",
    status: "",
    rel: "",
    updatedAt: 0,
    truncated: false,
    editable: false,
    editBlock: "",
    raw: "",
    version: "",
    message,
  };
}

/** 実体が Vault の中の `.md` なら、その realpath を返す。そうでなければ理由。 */
export function confineToVault(
  vaultDir: string,
  file: string,
): { ok: true; real: string; root: string } | { ok: false; message: string } {
  let root: string;
  try {
    root = fs.realpathSync(vaultDir);
  } catch {
    return { ok: false, message: "Vault が見つかりません" };
  }
  if (isBackupPath(file) || isBackupPath(root)) {
    return { ok: false, message: "バックアップ側のノートは読みません" };
  }
  if (!file.toLowerCase().endsWith(".md")) {
    return { ok: false, message: "Markdown のノート(.md)だけ開けます" };
  }
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(file));
  } catch {
    return { ok: false, message: "ノートが見つかりません" };
  }
  if (!real.toLowerCase().endsWith(".md")) {
    return { ok: false, message: "Markdown のノート(.md)だけ開けます" };
  }
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || isBackupPath(real)) {
    return { ok: false, message: "Vault の外のファイルは開けません" };
  }
  // リンク索引と同じく、隠しフォルダ(.obsidian / .git / .trash など)の中は開かない。
  if (rel.split(path.sep).some((seg) => seg.startsWith("."))) {
    return { ok: false, message: "隠しフォルダの中のファイルは開けません" };
  }
  return { ok: true, real, root };
}

/** 保存時の「開いた時点の版」。改行の違いを含めた実際の中身(NFC)のハッシュ。 */
export function noteVersion(text: string): string {
  return crypto
    .createHash("sha256")
    .update(text.normalize("NFC"), "utf8")
    .digest("hex")
    .slice(0, 24);
}

/** 改行の流儀。`crlf` / `lf` / 混在(`mixed`)。保存で元の流儀へ戻すために使う。 */
export function eolStyle(text: string): "lf" | "crlf" | "mixed" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  if (cr > 0 || (crlf > 0 && lf > 0)) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

/** UTF-8 として読めなければ null(置換文字で保存してしまわないため)。 */
export function decodeStrict(buf: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** frontmatter を本文から分ける。閉じが無ければ全体を本文として返す。 */
export function splitFrontmatter(text: string): { head: string[]; body: string } {
  const src = text.replace(/^﻿/, "");
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { head: [], body: src };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return { head: [], body: src };
  return {
    head: lines.slice(1, close),
    body: lines
      .slice(close + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

function headValue(head: readonly string[], key: string): string {
  for (const line of head) {
    const m = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

export function readVaultNote(vaultDir: string, file: string): NoteReadResult {
  const c = confineToVault(vaultDir, file);
  if (!c.ok) return fail(c.message);
  let st: fs.Stats;
  try {
    st = fs.statSync(c.real);
  } catch {
    return fail("ノートが見つかりません");
  }
  if (!st.isFile()) return fail("ノートではありません");
  const size = Math.min(st.size, NOTE_VIEW_MAX_BYTES);
  let text: string;
  let fullBytes: Buffer = Buffer.alloc(0);
  try {
    const fd = fs.openSync(c.real, "r");
    try {
      // 検査(realpath)から開くまでの間に差し替えられていないこと(同じ実体か)を確かめる。
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev) {
        return fail("読み込み中にノートが入れ替わりました");
      }
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      fullBytes = buf.subarray(0, n);
      text = fullBytes.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return fail(`読めません(${(e as Error).message})`);
  }
  const { head, body } = splitFrontmatter(text);
  const base = path.basename(c.real, ".md");
  const truncated = st.size > NOTE_VIEW_MAX_BYTES;
  const strict = truncated ? null : decodeStrict(fullBytes);
  const eol = strict === null ? "mixed" : eolStyle(strict);
  let editBlock = "";
  if (truncated) editBlock = "長いため編集できません";
  else if (strict === null) editBlock = "UTF-8として読めない文字があるため編集できません";
  else if (eol === "mixed") editBlock = "改行の形式が混在しているため編集できません";
  return {
    ok: true,
    title: headValue(head, "title") || base,
    body,
    status: headValue(head, "status"),
    rel: path.relative(c.root, c.real).split(path.sep).join("/"),
    updatedAt: Math.round(st.mtimeMs),
    truncated,
    editable: editBlock === "",
    editBlock,
    raw: editBlock === "" && strict !== null ? strict.replace(/\r\n/g, "\n") : "",
    version: editBlock === "" && strict !== null ? noteVersion(strict) : "",
    message: null,
  };
}

// ---------------------------------------------------------------- [[リンク]] の解決

interface LinkIndex {
  at: number;
  root: string;
  /** 小文字の名前(拡張子なし) → 実体パスの一覧。 */
  byName: Map<string, string[]>;
  /** Vault 相対パス(小文字・.md なし) → 実体パス。 */
  byRel: Map<string, string>;
}

let cachedIndex: LinkIndex | null = null;

function buildIndex(root: string): LinkIndex {
  const byName = new Map<string, string[]>();
  const byRel = new Map<string, string>();
  let count = 0;
  let visited = 0;
  const stack = [root];
  while (stack.length > 0 && count < LINK_INDEX_LIMIT && visited < LINK_INDEX_LIMIT * 4) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    visited += entries.length;
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isBackupPath(full)) stack.push(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        count++;
        const stem = e.name.slice(0, -3).normalize("NFC").toLowerCase();
        const list = byName.get(stem);
        if (list) list.push(full);
        else byName.set(stem, [full]);
        byRel.set(
          path
            .relative(root, full)
            .slice(0, -3)
            .split(path.sep)
            .join("/")
            .normalize("NFC")
            .toLowerCase(),
          full,
        );
      }
    }
  }
  return { at: Date.now(), root, byName, byRel };
}

function linkIndex(root: string, now = Date.now()): LinkIndex {
  if (cachedIndex && cachedIndex.root === root && now - cachedIndex.at < LINK_INDEX_TTL_MS) {
    return cachedIndex;
  }
  cachedIndex = buildIndex(root);
  return cachedIndex;
}

/** テスト用: 索引の覚えを捨てる。 */
export function resetLinkIndex(): void {
  cachedIndex = null;
}

/** `名前|表示名`・`名前#見出し`・`名前.md` から検索用の名前だけを取り出す。 */
export function linkTargetName(raw: string): string {
  let t = raw.split("|")[0].split("#")[0].trim().replace(/\\/g, "/");
  t = t.replace(/^\/+/, "");
  if (t.toLowerCase().endsWith(".md")) t = t.slice(0, -3);
  return t.normalize("NFC");
}

export function resolveVaultLink(
  vaultDir: string,
  from: string,
  target: string,
): { ok: boolean; path: string | null; message: string | null } {
  const c = confineToVault(vaultDir, from);
  if (!c.ok) return { ok: false, path: null, message: c.message };
  const name = linkTargetName(target);
  if (name === "") return { ok: false, path: null, message: "リンク先が空です" };
  const idx = linkIndex(c.root);
  const key = name.toLowerCase();
  // Vault 相対パスの指定(`フォルダ/名前`)を先に見る。
  const viaRel = name.includes("/") ? idx.byRel.get(key) : undefined;
  let found = viaRel ?? null;
  if (!found) {
    const base = key.split("/").pop() as string;
    const cands = idx.byName.get(base) ?? [];
    const pool = name.includes("/")
      ? cands.filter((p) => p.normalize("NFC").toLowerCase().endsWith(`/${key}.md`))
      : cands;
    const fromDir = path.dirname(c.real);
    // 同じフォルダ → 浅い順 → 短い順(Topos のビューアと同じ考え方)。
    found =
      [...pool].sort((a, b) => {
        const sa = path.dirname(a) === fromDir ? 0 : 1;
        const sb = path.dirname(b) === fromDir ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const da = a.split(path.sep).length;
        const db = b.split(path.sep).length;
        return da !== db ? da - db : a.length - b.length;
      })[0] ?? null;
  }
  if (!found) return { ok: false, path: null, message: `「${name}」というノートは見つかりません` };
  const again = confineToVault(vaultDir, found);
  if (!again.ok) return { ok: false, path: null, message: again.message };
  return { ok: true, path: again.real, message: null };
}
