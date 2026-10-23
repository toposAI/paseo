/**
 * 構想ノートの `thread:` 1行だけを書く(**隔離された書き込み部**)。
 *
 * 2026-10-23 ユーザー決定(案B): サイドバーが深掘りスレを作ったとき、そのスレIDを
 * ノートの frontmatter へ記録する。Vault の書き手は基本1人(`impl_note_writer.py`)なので、
 * ここはその例外の**最小面**に閉じる。ガード(すべて満たさなければ書かない):
 *
 * 1. **live Vault の `type: concept-note` だけ**(`Obsidian-Git` バックアップへは書かない)。
 *    Vault の外・構想ノートでないノート・symlink のノートは書かない。
 * 2. **1行だけ**: frontmatter に `thread:` が無ければ1行足す。有れば**その1行だけ**を
 *    差し替える。既存の `thread:` に**別のID**が入っていたら上書きせず `conflict`。
 *    `threads:` などの他のキー・本文・改行コードは変えない。
 * 3. **排他 + 原子的書込**: ノート単位と Vault 単位の lock を取り、**読み直してから**
 *    一時ファイルへ書いて rename する(同時編集を上書きしない。読み手に半端な内容を見せない)。
 *
 * **flock について**: このマシン(macOS)には `flock` コマンドも `fs-ext` も無いため、
 * 同じ目的(同時編集の直列化)を O_EXCL の lock ファイルで満たす。stale(10秒超)は
 * rename で原子的に引き取る。lock は **Vault の外**(`$TMPDIR/topos-note-thread-locks`)に置く
 * (Vault 内に置くと、バックアップ側の `git add -A` に拾われる)。
 *
 * **移行先**: `impl_note_writer.py` は既に `record_concept_thread()` / `concept-thread`
 * サブコマンドを持っており、判定(`apply_thread_line`)はこのファイルと揃えてある
 * (空の `thread:` の直後がリスト/インデント行なら conflict、など)。移行するときは
 * `recordConceptThread` の中身をその CLI 呼び出しへ差し替え、呼び出し側は変えない。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoteThreadError, isBackupPath, parseFrontmatter } from "./notes.js";

/** 記録の結果(`shared/notes.ts` の `openConceptThreadRpc` の `record` と同じ語彙)。 */
export type RecordResult = "written" | "already" | "conflict";

const THREAD_LINE_RE = /^thread:\s*(.*)$/;
/** スレIDは英数とハイフンだけ(ノートの他の候補と同じ規則)。 */
const THREAD_ID_RE = /^[A-Za-z0-9-]{8,200}$/;
/** lock を待つ上限。 */
const LOCK_WAIT_MS = 4_000;
const LOCK_RETRY_MS = 40;
/** これより古い lock は落ちた持ち主のものとみなして取り直す。 */
const LOCK_STALE_MS = 10_000;
const HEAD_BYTES = 64 * 1024;
/** lock の置き場(Vault の外)。 */
const LOCK_DIR = path.join(os.tmpdir(), "topos-note-thread-locks");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** frontmatter ブロックの範囲(開き `---` と閉じ `---` の行番号)。無ければ null。 */
function frontmatterRange(lines: readonly string[]): { open: number; close: number } | null {
  if (lines[0]?.trim() !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return close < 0 ? null : { open: 0, close };
}

/** 引用符を外した値(`thread: "x"` を読める形にする)。 */
function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * ノートの本文へ `thread: <id>` を反映した文字列を返す(**書かずに計算する**)。
 * 既存の `thread:` が同じIDなら `already`、別のIDなら `conflict`(上書きしない)。
 * 挿入位置は frontmatter の末尾(`---` の直前)。
 */
export function applyThreadLine(
  text: string,
  threadId: string,
): { next: string; result: RecordResult } {
  if (!THREAD_ID_RE.test(threadId)) throw new NoteThreadError(`スレIDの形が不正です: ${threadId}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const range = frontmatterRange(lines);
  if (!range) throw new NoteThreadError("frontmatter がありません(書かない)");
  const line = `thread: ${threadId}`;
  for (let i = range.open + 1; i < range.close; i += 1) {
    const m = THREAD_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const current = cleanValue(m[1]);
    if (current === threadId) return { next: text, result: "already" };
    // 空の `thread:` は埋めてよい。別のID(リスト形式を含む)は上書きしない。
    if (current.length > 0) return { next: text, result: "conflict" };
    // 値が空でも、直後がリスト/インデント行なら中身がある。1行だけ埋めると残りが
    // 宙に浮いて YAML が壊れるので、書かずに conflict にする(移行先の Python と同じ判定)。
    let j = i + 1;
    while (j < range.close && (/^\s/.test(lines[j]) || lines[j].startsWith("- "))) j += 1;
    if (j > i + 1) return { next: text, result: "conflict" };
    const next = [...lines];
    next[i] = line;
    return { next: next.join(eol), result: "written" };
  }
  const next = [...lines.slice(0, range.close), line, ...lines.slice(range.close)];
  return { next: next.join(eol), result: "written" };
}

/** ノートの先頭だけ読む(frontmatter の判定用)。 */
export function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch (error) {
    throw new NoteThreadError(`ノートを読めません: ${(error as Error).message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** ノートが構想ノートか(`type:` で判定)。読めない/構想ノートでなければ throw。 */
export function assertConceptNote(file: string): void {
  const type = String(parseFrontmatter(readHead(file))?.type ?? "").toLowerCase();
  if (type !== "concept-note" && type !== "concept") {
    throw new NoteThreadError(`構想ノートではありません(type: ${type || "なし"}): ${file}`);
  }
}

/**
 * 書いてよいノートか(ガード1)を、**スレを作る前に**確かめる。返すのは解決済み(realpath)のパス。
 * ここを通った後も `recordConceptThread` がロックを取ってから同じ検査をやり直す
 * (検査と書込の間でノートが別物に変わりうるため)。
 */
export function assertWritableConceptNote(file: string, vaultDir: string): string {
  // 文字列の時点で弾く(realpath は存在しないパスで失敗するので、順序を先にする)。
  if (isBackupPath(path.resolve(file))) {
    throw new NoteThreadError(`バックアップには書きません: ${file}`);
  }
  let resolved: string;
  let vault: string;
  try {
    // symlink を辿る(Vault 内のディレクトリが外を指している経路を塞ぐ)。
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new NoteThreadError(`symlink のノートには書きません: ${file}`);
    }
    resolved = fs.realpathSync(file);
    vault = fs.realpathSync(path.resolve(vaultDir));
  } catch (original) {
    if (original instanceof NoteThreadError) throw original;
    throw new NoteThreadError(`ノートを解決できません: ${(original as Error).message}`);
  }
  if (isBackupPath(resolved)) throw new NoteThreadError(`バックアップには書きません: ${resolved}`);
  const rel = path.relative(vault, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new NoteThreadError(`Vault の外のノートには書きません: ${resolved}`);
  }
  assertConceptNote(resolved);
  return resolved;
}

/**
 * 記録に使う Vault 全体ロックの鍵(このプラグインのプロセス間でだけ効く)。
 *
 * **移行先の Python(`fcntl.flock`)とは噛み合わない**: flock は「ファイルに掛かっているか」で
 * 排他するが、こちらは「ファイルが存在するか」で排他する。Python は `vault.lock` を
 * 一度作ったら消さない(`open("a+")` して flock するだけ)ので、存在を条件にすると
 * **常に取れない**。逆にこちらが作った lock を Python は待たない。
 * したがって相手が Python / Obsidian のときの排他は**成立しない**(受信箱で開示する。
 * 移行して書き込みを Python 側へ寄せた時点で、この非対称は消える)。
 */
export function vaultLockKey(vaultDir: string): string {
  return `vault:${vaultDir}`;
}

/** ノートが既に持っている `thread:` の値(無ければ空文字)。上書き可否の材料。 */
export function readThreadKey(text: string): string {
  const lines = text.split(/\r?\n/);
  const range = frontmatterRange(lines);
  if (!range) return "";
  for (const line of lines.slice(range.open + 1, range.close)) {
    const m = THREAD_LINE_RE.exec(line);
    if (m) return cleanValue(m[1]);
  }
  return "";
}

/** 鍵に対応する lock ファイル(すべて Vault の外・`$TMPDIR` 配下のハッシュ名)。検査から使える。 */
export function lockFileFor(key: string): string {
  const digest = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  return path.join(LOCK_DIR, `${digest}.lock`);
}

/**
 * 落ちた持ち主の lock を引き取る。手順は「rename で持ち去る → 持ち去ったファイルの
 * mtime を確かめる → 新しければ(別の者が直前に取り直していたら)元へ戻す」。
 * stat→rm だけだと、直前に作り直された lock を消して2者が同時に持つ(round2 指摘4)。
 */
function takeOverIfStale(file: string): boolean {
  let grave: string;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs <= LOCK_STALE_MS) return false;
    grave = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.stale`;
    fs.renameSync(file, grave);
  } catch {
    return false; // 消えた/取られた: 呼び出し側が取り直す
  }
  try {
    if (Date.now() - fs.statSync(grave).mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(grave, { force: true });
      return true;
    }
    // 直前に誰かが取り直した新しい lock だった。持ち主へ返す(返せなければ諦める)。
    fs.renameSync(grave, file);
    return false;
  } catch {
    return false;
  }
}

/** 自分が取った lock だけを消す(引き取られた後に他人の lock を消さない)。 */
function releaseLock(file: string, token: string): void {
  try {
    if (fs.readFileSync(file, "utf8") !== token) return;
    fs.rmSync(file, { force: true });
  } catch {
    // 既に無い: 何もしない
  }
}

/** O_EXCL でロックファイルを取る。stale は取り直す。 */
async function acquireLock(key: string): Promise<() => void> {
  const file = lockFileFor(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    throw new NoteThreadError(`ロックの置き場を作れません: ${(error as Error).message}`);
  }
  const token = `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(file, token, { encoding: "utf8", flag: "wx" });
      return () => releaseLock(file, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new NoteThreadError(`ロックを作れません: ${(error as Error).message}`);
      }
      if (takeOverIfStale(file)) continue;
      if (Date.now() > deadline) throw new NoteThreadError(`ロックが取れません: ${file}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/** 一時ファイルへ書いて rename する(読み手に中途半端な内容を見せない)。 */
function atomicWrite(file: string, body: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const mode = fs.statSync(file).mode & 0o777;
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 後始末の失敗で元のエラーを隠さない
    }
    throw error;
  }
}

/**
 * 構想ノートの `thread:` にスレIDを記録する(上記ガード付き)。
 * `vaultDir` は live Vault の根(Vault 外の拒否と、Vault 単位ロックに使う)。
 * `already` / `conflict` は例外にせず返す(呼び出し側が結果を出し分ける)。
 */
export async function recordConceptThread(
  file: string,
  threadId: string,
  opts: { vaultDir: string },
): Promise<{ result: RecordResult; notePath: string }> {
  const resolved = assertWritableConceptNote(file, opts.vaultDir);
  const releaseVault = await acquireLock(
    vaultLockKey(fs.realpathSync(path.resolve(opts.vaultDir))),
  );
  try {
    const releaseNote = await acquireLock(`note:${resolved}`);
    try {
      assertConceptNote(resolved); // ロックを取ってから種類を確かめ直す
      // 書く直前に**全体**を読み直す(先頭だけ読むと本文を切り落とす)。
      const text = fs.readFileSync(resolved, "utf8");
      const { next, result } = applyThreadLine(text, threadId);
      if (result === "written") atomicWrite(resolved, next);
      return { result, notePath: resolved };
    } finally {
      releaseNote();
    }
  } finally {
    releaseVault();
  }
}
