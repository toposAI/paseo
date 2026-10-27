/**
 * 構想ノートの保存(**既存ファイルの編集だけ**。新規作成・削除・名前変更はしない)。
 *
 * 守ること(2026-10-28 ユーザー決定。Topos の Vault 編集と同じ考え方):
 * - 書き先は live Vault の中の既存 `.md` だけ。パス検査は閲覧と同じ `confineToVault`(Obsidian-Git・Vault 外・
 *   symlink・隠しフォルダは拒否)。
 * - 競合検知: 開いた時点の版(`base`)と今のファイルの版が違えば上書きしない(conflict で今の全文を返す)。
 * - 変更履歴: 書き換える前の全文を Vault の**外**(`Application Support/Paseo/note-history`)へ残す。
 *   残せなければ保存しない(履歴なしの上書きは許さない)。
 * - 検査→読み直し→照合→書き込みは、記録・移動と同じ鍵(Vault・ノート)の中で行う。
 *
 * 限界: 相手が Obsidian 等で、この鍵を取らずに同時に書く場合の排他は成立しない(照合から rename までの
 * 数ミリ秒の窓)。そのぶんは履歴(書き換え前の全文)から戻せる。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBackupPath } from "./notes.js";
import { acquireLock, atomicWrite, vaultLockKey } from "./note-thread.js";
import {
  NOTE_VIEW_MAX_BYTES,
  confineToVault,
  decodeStrict,
  eolStyle,
  noteVersion,
} from "./note-view.js";

export interface SaveNoteResult {
  status: "saved" | "conflict" | "unchanged" | "rejected";
  message: string;
  version: string;
  current: string;
}

/** 1つのノートの履歴として残す世代数。超えたら古い順に消す。 */
export const NOTE_HISTORY_KEEP = 50;

function result(
  status: SaveNoteResult["status"],
  message: string,
  version = "",
  current = "",
): SaveNoteResult {
  return { status, message, version, current };
}

export function resolveHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.TOPOS_CONFIRM_BOX_NOTE_HISTORY_DIR?.trim();
  return set && set.length > 0
    ? path.resolve(set)
    : path.join(os.homedir(), "Library", "Application Support", "Paseo", "note-history");
}

/** 履歴の置き場が Vault の外で、バックアップでもないこと。 */
function historyDirProblem(historyDir: string, vaultRoot: string): string | null {
  if (isBackupPath(historyDir)) return "履歴の置き場がバックアップ側です";
  let real = path.resolve(historyDir);
  // まだ無ければ、在る一番近い親で判定する。
  while (!fs.existsSync(real) && path.dirname(real) !== real) real = path.dirname(real);
  let resolved: string;
  try {
    resolved = fs.realpathSync(real);
  } catch {
    return "履歴の置き場を確認できません";
  }
  const rel = path.relative(vaultRoot, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return "履歴の置き場が Vault の中です";
  }
  return null;
}

/** 書き換える前の全文を履歴へ残す。残した場所を返す。 */
function snapshot(historyDir: string, rel: string, before: string, version: string): string {
  const key = crypto.createHash("sha1").update(rel).digest("hex").slice(0, 16);
  const dir = path.join(historyDir, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "NOTE.txt"), `${rel}\n`, "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${version}.md`);
  fs.writeFileSync(file, before, { encoding: "utf8", flag: "wx" });
  const olds = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort();
  for (const n of olds.slice(0, Math.max(0, olds.length - NOTE_HISTORY_KEEP))) {
    fs.rmSync(path.join(dir, n), { force: true });
  }
  return file;
}

export async function saveVaultNote(
  vaultDir: string,
  file: string,
  text: string,
  base: string,
  historyDir: string = resolveHistoryDir(),
): Promise<SaveNoteResult> {
  const c = confineToVault(vaultDir, file);
  if (!c.ok) return result("rejected", c.message);
  if (base.trim() === "") return result("rejected", "開いた時点の版が分からないため保存できません");
  if (text.includes("\0")) return result("rejected", "保存できない文字が含まれています");
  if (Buffer.byteLength(text, "utf8") > NOTE_VIEW_MAX_BYTES) {
    return result("rejected", "大きさの上限を超えるため保存できません");
  }
  const problem = historyDirProblem(historyDir, c.root);
  if (problem) return result("rejected", `${problem}(履歴を残せないため保存しません)`);
  const releaseVault = await acquireLock(vaultLockKey(c.root));
  try {
    const releaseNote = await acquireLock(`note:${c.real}`);
    try {
      // ロックの中で検査し直す(待っている間に差し替えられていないか)。
      const again = confineToVault(vaultDir, file);
      if (!again.ok || again.real !== c.real) {
        return result("rejected", again.ok ? "ノートの場所が変わりました" : again.message);
      }
      return writeLocked(c.real, c.root, text, base, historyDir);
    } finally {
      releaseNote();
    }
  } finally {
    releaseVault();
  }
}

function writeLocked(
  real: string,
  root: string,
  text: string,
  base: string,
  historyDir: string,
): SaveNoteResult {
  let st: fs.Stats;
  let bytes: Buffer;
  try {
    st = fs.statSync(real);
    if (!st.isFile()) return result("rejected", "ノートではありません");
    if (st.size > NOTE_VIEW_MAX_BYTES) return result("rejected", "長いため編集できません");
    bytes = fs.readFileSync(real);
  } catch (e) {
    return result("rejected", `読めません(${(e as Error).message})`);
  }
  const before = decodeStrict(bytes);
  if (before === null) return result("rejected", "UTF-8として読めない文字があるため保存できません");
  const eol = eolStyle(before);
  if (eol === "mixed") return result("rejected", "改行の形式が混在しているため保存できません");
  const nowVersion = noteVersion(before);
  const currentLf = before.replace(/\r\n/g, "\n");
  if (nowVersion !== base) {
    return result(
      "conflict",
      "別の場所で変更されていました。上書きしていません",
      nowVersion,
      currentLf,
    );
  }
  const next = eol === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
  if (next === before) return result("unchanged", "変更がありません", nowVersion);
  try {
    const rel = path.relative(root, real).split(path.sep).join("/");
    snapshot(historyDir, rel, before, nowVersion);
  } catch (e) {
    return result("rejected", `履歴を残せないため保存しません(${(e as Error).message})`);
  }
  try {
    atomicWrite(real, next);
  } catch (e) {
    return result("rejected", `保存できませんでした(${(e as Error).message})`);
  }
  return result("saved", "保存しました", noteVersion(next));
}
