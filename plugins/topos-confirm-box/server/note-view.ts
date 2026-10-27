/**
 * 構想ノートの閲覧(**読むだけ**)。Vault の中のノートに限り、本文と `[[リンク]]` の行き先を返す。
 *
 * ガード: 実体(realpath)が live Vault の realpath の中にあること、`.md` であること、
 * バックアップ(`Obsidian-Git`)でないこと、通常ファイルであること、大きさが上限以内であること。
 * 読み出しだけで、Vault には何も書かない。
 */
import fs from "node:fs";
import path from "node:path";
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
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || isBackupPath(real)) {
    return { ok: false, message: "Vault の外のファイルは開けません" };
  }
  return { ok: true, real, root };
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
  try {
    const fd = fs.openSync(c.real, "r");
    try {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return fail(`読めません(${(e as Error).message})`);
  }
  const { head, body } = splitFrontmatter(text);
  const base = path.basename(c.real, ".md");
  return {
    ok: true,
    title: headValue(head, "title") || base,
    body,
    status: headValue(head, "status"),
    rel: path.relative(c.root, c.real).split(path.sep).join("/"),
    updatedAt: Math.round(st.mtimeMs),
    truncated: st.size > NOTE_VIEW_MAX_BYTES,
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
  const stack = [root];
  while (stack.length > 0 && count < LINK_INDEX_LIMIT) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
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
      ? cands.filter((p) => p.toLowerCase().endsWith(`${key}.md`))
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
