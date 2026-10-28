/**
 * 構想ノートの保存(**既存ファイルの編集だけ**。新規作成・削除・名前変更はしない)。
 *
 * 守ること(2026-10-28 ユーザー決定。Topos の Vault 編集と同じ考え方):
 * - 書き先は live Vault の中の既存 `.md` だけ。パス検査は閲覧と同じ `confineToVault`(Obsidian-Git・Vault 外・
 *   隠しフォルダは拒否。Vault 内を指す symlink は実体へ書き、Vault 外・バックアップを指すものは拒否)。
 * - 競合検知: 開いた時点の版(`base`)と今のファイルの版が違えば上書きしない(conflict で今の全文を返す)。
 * - 変更履歴: Topos と同じ履歴(本人 Vault のローカル git。`note-history.ts`)に積む。順は
 *   「書く前の版を1コミット → 書く → 新しい版を1コミット」。積めなければ保存しない/書いた本文を戻す
 *   (履歴なしの上書きは許さない)。履歴が未設定なら編集自体が無効。
 * - 検査→読み直し→照合→書き込みは、記録・移動と同じ鍵(Vault・ノート)の中で行う。
 *
 * 限界: 相手が Obsidian 等で、この鍵を取らずに同時に書く場合の排他は成立しない(照合から rename までの
 * 数ミリ秒の窓)。そのぶんは履歴(書き換え前の版)から戻せる。
 */
import fs from "node:fs";
import path from "node:path";
import { acquireLock, atomicWrite, vaultLockKey } from "./note-thread.js";
import {
  type HistoryCommitter,
  HISTORY_OFF_MESSAGE,
  resolveHistoryCommitter,
} from "./note-history.js";
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

function result(
  status: SaveNoteResult["status"],
  message: string,
  version = "",
  current = "",
): SaveNoteResult {
  return { status, message, version, current };
}

export async function saveVaultNote(
  vaultDir: string,
  file: string,
  text: string,
  base: string,
  history: HistoryCommitter | null = resolveHistoryCommitter(),
): Promise<SaveNoteResult> {
  const c = confineToVault(vaultDir, file);
  if (!c.ok) return result("rejected", c.message);
  if (base.trim() === "") return result("rejected", "開いた時点の版が分からないため保存できません");
  if (text.includes("\0")) return result("rejected", "保存できない文字が含まれています");
  if (Buffer.byteLength(text, "utf8") > NOTE_VIEW_MAX_BYTES) {
    return result("rejected", "大きさの上限を超えるため保存できません");
  }
  if (!history) return result("rejected", `${HISTORY_OFF_MESSAGE}(履歴なしの上書きはしません)`);
  try {
    return await withLocks(c.root, c.real, async () => {
      // ロックの中で検査し直す(待っている間に差し替えられていないか)。
      const again = confineToVault(vaultDir, file);
      if (!again.ok || again.real !== c.real) {
        return result("rejected", again.ok ? "ノートの場所が変わりました" : again.message);
      }
      return await writeLocked(c.real, c.root, text, base, history);
    });
  } catch (e) {
    return result("rejected", `保存の順番待ちに失敗しました(${(e as Error).message})`);
  }
}

/** 記録・移動と同じ順(Vault → ノート)で鍵を取って fn を実行する。 */
async function withLocks<T>(root: string, real: string, fn: () => Promise<T> | T): Promise<T> {
  const releaseVault = await acquireLock(vaultLockKey(root));
  try {
    const releaseNote = await acquireLock(`note:${real}`);
    try {
      return await fn();
    } finally {
      releaseNote();
    }
  } finally {
    releaseVault();
  }
}

async function writeLocked(
  real: string,
  root: string,
  text: string,
  base: string,
  history: HistoryCommitter,
): Promise<SaveNoteResult> {
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
  const nowVersion = noteVersion(bytes);
  const currentLf = before.replace(/\r\n/g, "\n");
  if (nowVersion !== base) {
    return result(
      "conflict",
      "別の場所で変更されていました。上書きしていません",
      nowVersion,
      currentLf,
    );
  }
  // 単独の \r も改行として扱い、混在ファイルを作らない(自分の保存で編集不能にしない)。
  const lf = text.replace(/\r\n?/g, "\n");
  const next = eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
  if (Buffer.byteLength(next, "utf8") > NOTE_VIEW_MAX_BYTES) {
    return result("rejected", "大きさの上限を超えるため保存できません");
  }
  if (next === before) return result("unchanged", "変更がありません", nowVersion);
  const rel = path.relative(root, real).split(path.sep).join("/");
  // 書く前の版を履歴へ残す(控えが積めなければ保存を始めない)。
  const pre = await history.commit(root, rel, "pre");
  if (pre !== "committed" && pre !== "already") {
    return result("rejected", `${preMessage(pre)}(履歴を残せないため保存しません)`);
  }
  try {
    atomicWrite(real, next);
  } catch (e) {
    return result("rejected", `保存できませんでした(${(e as Error).message})`);
  }
  const post = await history.commit(root, rel, "post");
  if (post === "committed" || post === "already") {
    return result("saved", "保存しました", noteVersion(next));
  }
  if (post === "unknown") {
    // 積めたか分からない。戻すと履歴だけ新しい版が残るので、本文はそのままにして失敗として知らせる。
    return result(
      "rejected",
      "履歴に積めたか確認できませんでした。ノートは書き換わっている可能性があります",
    );
  }
  return restoreOriginal(real, before, bytes, next, post);
}

function preMessage(state: string): string {
  if (state === "excluded") return "履歴の対象外(個人情報の領域など)です";
  if (state === "unavailable") return "履歴の git が使えません";
  return "書き換え前の版を履歴に残せませんでした";
}

/** 履歴に積めなかったので、書いた本文を元へ戻す(戻せたか読み直して確かめる)。 */
function restoreOriginal(
  real: string,
  before: string,
  bytes: Buffer,
  next: string,
  post: string,
): SaveNoteResult {
  const why = post === "excluded" ? "履歴の対象外のため" : "履歴に積めなかったため";
  try {
    // 履歴コミット中に外部が書き換えていたら、その内容を消さない(自分の書いた版のままのときだけ戻す)
    if (!fs.readFileSync(real).equals(Buffer.from(next, "utf8"))) {
      return result(
        "rejected",
        `${why}保存しませんでしたが、その間に別の場所で変更されたため元に戻していません。ノートを確認してください`,
      );
    }
    atomicWrite(real, before);
    if (fs.readFileSync(real).equals(bytes)) {
      return result("rejected", `${why}保存しませんでした(元の内容のままです)`);
    }
  } catch {
    // 下の失敗として扱う
  }
  return result(
    "rejected",
    `${why}保存を取り消そうとしましたが、元に戻せませんでした。ノートを確認してください`,
  );
}
