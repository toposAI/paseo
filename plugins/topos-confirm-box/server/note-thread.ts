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
import { NoteThreadError, isBackupPath, parseFrontmatter, readNoteHead } from "./notes.js";
import { conceptPlace, isDirectChild, zoneOfPath } from "../shared/concept-places.js";
import type { ConceptZone } from "../shared/concept-places.js";

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
/** 記録できる形かを試算するときの仮ID(実在しない UUID 形)。 */
const PROBE_ID = "00000000-0000-4000-8000-000000000000";
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

/**
 * ノートの先頭だけ読む(frontmatter の判定用)。実体は `notes.ts` の `readNoteHead`
 * (上限 `HEAD_BYTES` もそちらが SSOT)。読めないことを黙って空文字にしないため throw する。
 */
export function readHead(file: string): string {
  const head = readNoteHead(file);
  if (head === null) throw new NoteThreadError(`ノートを読めません: ${file}`);
  return head;
}

/**
 * このノートに `thread:` を書ける形か(**スレを作る前に**確かめる)。
 *
 * `thread:` が空でも、直後がリスト/インデント行なら1行だけ埋めると YAML が壊れるので
 * `applyThreadLine` は `conflict` を返す。そのノートで作成まで進むと、毎回作っては記録に
 * 失敗する(押すたびにスレが1本増える)ため、作成前に止める(出口レビュー round3 指摘1)。
 */
export function canRecordThread(head: string): boolean {
  // 既にIDが書かれているノートは「作る前」の対象外(`openConceptThread` がそこへ来ない)。
  // この段階で止めるのは、**書ける形になっていないノート**だけ。
  if (readThreadKey(head)) return true;
  try {
    // 先頭だけ読んでいるので、閉じ `---` が上限の外にあると判断できない。
    // 「読めた範囲に閉じが無い」ときは frontmatter 無しではなく**読めなかった**とみなす。
    const lines = head.split(/\r?\n/);
    const closed = lines.some((l, i) => i > 0 && l.trim() === "---");
    return closed && applyThreadLine(head, PROBE_ID).result !== "conflict";
  } catch {
    return false; // frontmatter が無い等。書けないので作らない
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

/**
 * 記録が `conflict` になったとき、実際に開くべきスレID(ノートが指している方)。無ければ null。
 *
 * 「作ったが記録できなかったスレ(孤児)」を開くと、ユーザーにはノートと無関係なスレが見える。
 * ノートに別のIDが書かれているなら、そちらが正(旧 round2 指摘2 / 旧 round3 指摘2)。
 */
export function conflictRedirect(head: string, threadId: string): string | null {
  const bound = readThreadKey(head);
  return bound.length > 0 && bound !== threadId ? bound : null;
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

/** 前回の `link` の後で止まった移動を完成させる(移動元のリンクを外すだけ)。失敗は隠さず投げる。 */
function finishHalfMove(now: string, target: string): void {
  try {
    fs.unlinkSync(now);
  } catch (error) {
    throw new NoteThreadError(
      `移動できず、同じノートが2か所に残っています(手で片方を消してください): ${now} / ${target}: ${(error as Error).message}`,
    );
  }
}

/** 置き場のディレクトリが実在する通常のディレクトリか(symlink は Vault の外を指しうるので拒む)。 */
function assertPlaceDirs(...dirs: readonly string[]): void {
  for (const dir of dirs) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      throw new NoteThreadError(`構想の置き場がありません(先に移行が必要です): ${dir}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new NoteThreadError(
        `構想の置き場が通常のディレクトリではありません(移しません): ${dir}`,
      );
    }
  }
}

/**
 * 2つのパスが**同じ通常ファイルの実体**か(同じデバイス・同じ inode)。
 * `statSync` は symlink を辿るので使わない: 移動先が移動元を指す symlink のとき「同じ実体」と
 * 誤認して、移動元の実体を消してしまう(構想タブ出口レビュー round3 指摘5)。どちらか読めなければ false。
 */
function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.lstatSync(a);
    const y = fs.lstatSync(b);
    return x.isFile() && y.isFile() && x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * 構想ノートを「検討中」と「あとで」の間で移す(`Paseo/構想/{検討中,あとで}` の中だけ)。
 *
 * ガード(すべて満たさなければ移さない):
 * 1. live Vault の `type: concept-note`(symlink のノート・バックアップ・Vault 外は不可)。
 * 2. **置き場の直下だけ**(サブディレクトリのノートは移さない。移すと木ごと動かすことになる)。
 *    置き場のディレクトリ自身が symlink のときも移さない(外を指していると Vault の外へ出る)。
 * 3. 移動先に同名のファイルがあれば**上書きしない**。`link` + `unlink` で行う
 *    (`rename` は既存を黙って置き換えるため、確認と実行の間に作られたファイルを壊す)。
 *    移動先が移動元と**同じ実体**なら、前回の `link` の後に止まった残りとみなして移す。
 *    戻せないまま終わったら「2か所に残っています」と明示する。
 * 4. 排他は `thread:` の記録と**同じ鍵・同じ順序**(`vault:<Vault の realpath>` → `note:<realpath>`)。
 *    以前は `vault:<Vault>/Paseo/構想` という別の鍵で、記録と噛み合っていなかった。
 *
 * **単一ライター規律の例外(記録済み)**: この移動は TypeScript から書く。`server/note-thread.ts` の
 * `recordConceptThread` と同じく、ノートの `thread:` を書く経路がまだこちら側にあり、Python 側の
 * `impl_note_writer.py` に移動サブコマンドが無いため。**移行先**は同スクリプトの移動サブコマンドで、
 * 実装されたらこの関数をその CLI 呼び出しへ差し替える(呼び出し側は変えない)。
 */
export async function moveConceptNote(
  file: string,
  to: ConceptZone,
  opts: { vaultDir: string },
): Promise<{ result: "moved" | "already"; notePath: string }> {
  const resolved = assertWritableConceptNote(file, opts.vaultDir);
  const vault = fs.realpathSync(path.resolve(opts.vaultDir));
  const place = conceptPlace(vault);
  // 置き場のディレクトリが symlink でないこと(realpath した Vault の下でも、置き場だけ外を指せる)。
  assertPlaceDirs(place.root, place.activeDir, place.laterDir);
  const from = zoneOfPath(resolved, place);
  // 置き場の**直下**だけ(サブディレクトリにあるノートは、その木をまとめて動かす話になるので移さない)。
  const dirOf = (zone: ConceptZone) => (zone === "later" ? place.laterDir : place.activeDir);
  if (from === null || !isDirectChild(resolved, dirOf(from))) {
    throw new NoteThreadError(`構想の置き場の直下ではありません(移しません): ${resolved}`);
  }
  if (from === to) return { result: "already", notePath: resolved };
  const targetDir = dirOf(to);
  const target = path.join(targetDir, path.basename(resolved));
  // 記録(`recordConceptThread`)と同じ鍵・同じ順序で取る(同じ Vault を触る操作を直列化する)。
  const releaseVault = await acquireLock(vaultLockKey(vault));
  try {
    const releaseNote = await acquireLock(`note:${resolved}`);
    try {
      // ロックの中で読み直す(検査と移動の間にノートが別物に変わりうる)。
      assertConceptNote(resolved);
      const now = fs.realpathSync(resolved);
      if (zoneOfPath(now, place) !== from || !isDirectChild(now, dirOf(from))) {
        throw new NoteThreadError(`ノートの置き場が変わりました(移しません): ${resolved}`);
      }
      // `link` は移動先が在れば EEXIST で失敗する(確認と実行の間に作られても壊さない)。
      try {
        fs.linkSync(now, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // 前回の移動が link の直後・unlink の直前で止まった場合、移動先は**同じ実体**への
        // 2本目のリンク。それを「別のノート」と取り違えると移せないまま残るので、実体で見分ける。
        if (sameFile(now, target)) {
          finishHalfMove(now, target);
          return { result: "moved", notePath: target };
        }
        throw new NoteThreadError(`移動先に同じ名前のノートがあります: ${target}`);
      }
      try {
        fs.unlinkSync(now);
      } catch (error) {
        // 元を消せなかったら、作ったリンクを戻す(2か所に同じノートを残さない)。
        try {
          fs.unlinkSync(target);
        } catch {
          // 戻せなかった: 同じノートが2か所に残っていることを隠さずに言う(元のエラーより重い)。
          throw new NoteThreadError(
            `移動できず、同じノートが2か所に残っています(手で片方を消してください): ${now} / ${target}: ${(error as Error).message}`,
          );
        }
        throw error;
      }
      return { result: "moved", notePath: target };
    } finally {
      releaseNote();
    }
  } finally {
    releaseVault();
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
