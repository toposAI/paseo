import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyThreadLine,
  assertWritableConceptNote,
  lockFileFor,
  readThreadKey,
  recordConceptThread,
} from "./note-thread.js";

function vaultLock(v: string): string {
  return lockFileFor(`vault:${fs.realpathSync(v)}`); // 本体と同じ導出
}

const UUID = "2165f646-cd93-4a7f-bbbe-1a4330795456";
const OTHER = "0b8c2f41-1111-4222-8333-944455556666";

function vault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topos-vault-"));
}

function writeNote(dir: string, name: string, fm: string, body = "# 見出し\n\n本文\n"): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${fm}\n---\n${body}`, "utf8");
  return file;
}

const CONCEPT = "type: concept-note\nstatus: 構想\ntitle: 構想A";

test("applyThreadLine: thread: が無ければ閉じ --- の直前に1行足す", () => {
  const text = `---\n${CONCEPT}\n---\n本文\n`;
  const { next, result } = applyThreadLine(text, UUID);
  assert.equal(result, "written");
  assert.equal(next, `---\n${CONCEPT}\nthread: ${UUID}\n---\n本文\n`);
});

test("applyThreadLine: 他のキー・本文・改行コードは一切変えない(差分は1行だけ)", () => {
  const text = `---\r\n${CONCEPT}\r\nsummary: 一行の結論\r\n---\r\n本文が\n複数行\nある\r\n`;
  const { next } = applyThreadLine(text, UUID);
  const before = text.split(/\r?\n/);
  const after = next.split(/\r?\n/);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(
    after.filter((l) => !l.startsWith("thread:")),
    before,
  );
  assert.ok(next.includes("\r\n")); // 改行コードも保つ
});

test("applyThreadLine: 同じIDなら already、別のIDなら conflict(上書きしない)", () => {
  const same = `---\n${CONCEPT}\nthread: ${UUID}\n---\n`;
  assert.deepEqual(applyThreadLine(same, UUID), { next: same, result: "already" });
  const other = `---\n${CONCEPT}\nthread: ${OTHER}\n---\n`;
  assert.deepEqual(applyThreadLine(other, UUID), { next: other, result: "conflict" });
});

test("applyThreadLine: 空の thread: は埋める(前後の行は変えない)", () => {
  const text = `---\n${CONCEPT}\nthread:\nsummary: x\n---\n`;
  const { next, result } = applyThreadLine(text, UUID);
  assert.equal(result, "written");
  assert.equal(next, `---\n${CONCEPT}\nthread: ${UUID}\nsummary: x\n---\n`);
});

test("applyThreadLine: frontmatterが無い・IDの形が不正なら書かない(throw)", () => {
  assert.throws(() => applyThreadLine("# 本文だけ\n", UUID), /frontmatter/);
  assert.throws(() => applyThreadLine(`---\n${CONCEPT}\n---\n`, "abc"), /スレID/);
  assert.throws(() => applyThreadLine(`---\n${CONCEPT}\n---\n`, "id with space-123"), /スレID/);
});

test("readThreadKey: 既存の thread: を引用符付きでも読む", () => {
  assert.equal(readThreadKey(`---\nthread: "${UUID}"\n---\n`), UUID);
  assert.equal(readThreadKey(`---\n${CONCEPT}\n---\n`), "");
});

test("assertWritableConceptNote: バックアップ・Vault外・構想ノート以外は拒否", () => {
  const v = vault();
  const ok = writeNote(v, "05_Projects/a.md", CONCEPT);
  assert.equal(assertWritableConceptNote(ok, v), fs.realpathSync(ok)); // symlink(/var→/private/var)を解決して返す
  assert.throws(
    () => assertWritableConceptNote(path.join(v, "x/Obsidian-Git/05_Projects/a.md"), v),
    /バックアップ/,
  );
  // 実在しないバックアップ配下でも、パス文字列だけで断る
  assert.throws(
    () => assertWritableConceptNote(path.join(v, "Obsidian-Git/none.md"), v),
    /バックアップ/,
  );
  const outside = writeNote(fs.mkdtempSync(path.join(os.tmpdir(), "topos-out-")), "b.md", CONCEPT);
  assert.throws(() => assertWritableConceptNote(outside, v), /Vault の外/);
  const impl = writeNote(v, "05_Projects/i.md", "type: implementation-note\nstatus: 実装中");
  assert.throws(() => assertWritableConceptNote(impl, v), /構想ノートではありません/);
});

test("recordConceptThread: 構想ノートの thread: に書く(本文は丸ごと残る)", async () => {
  const v = vault();
  const body = "# 見出し\n\n" + "長い本文\n".repeat(20_000); // 64KB 超(先頭だけ読む実装の回帰防止)
  const file = writeNote(v, "05_Projects/a.md", CONCEPT, body);
  const r = await recordConceptThread(file, UUID, { vaultDir: v });
  assert.equal(r.result, "written");
  const after = fs.readFileSync(file, "utf8");
  assert.equal(after, `---\n${CONCEPT}\nthread: ${UUID}\n---\n${body}`);
  // 2回目は same=already
  assert.equal((await recordConceptThread(file, UUID, { vaultDir: v })).result, "already");
  // 別IDは conflict でファイルは変わらない
  assert.equal((await recordConceptThread(file, OTHER, { vaultDir: v })).result, "conflict");
  assert.equal(fs.readFileSync(file, "utf8"), after);
});

test("recordConceptThread: 書いた後 lock と一時ファイルを残さない", async () => {
  const v = vault();
  const file = writeNote(v, "05_Projects/a.md", CONCEPT);
  const mode = fs.statSync(file).mode & 0o777;
  await recordConceptThread(file, UUID, { vaultDir: v });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n !== "a.md");
  assert.deepEqual(leftovers, []);
  assert.deepEqual(
    fs.readdirSync(v).filter((n) => n.includes("lock")),
    [],
  );
  assert.equal(fs.statSync(file).mode & 0o777, mode);
  assert.equal(fs.existsSync(vaultLock(v)), false); // Vault 単位のロックも残さない
});

test("recordConceptThread: 構想ノートでなければ書き込まない", async () => {
  const v = vault();
  const file = writeNote(v, "05_Projects/i.md", "type: implementation-note\nstatus: 実装中");
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(() => recordConceptThread(file, UUID, { vaultDir: v }), /構想ノート/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("recordConceptThread: 古い lock は取り直す(落ちた持ち主で永久に待たない)", async () => {
  const v = vault();
  const file = writeNote(v, "05_Projects/a.md", CONCEPT);
  const lock = lockFileFor(`note:${fs.realpathSync(file)}`); // 本体は realpath でロックする
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "99999", "utf8");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const r = await recordConceptThread(file, UUID, { vaultDir: v });
  assert.equal(r.result, "written");
  assert.equal(fs.existsSync(lock), false);
});

test("applyThreadLine: 空の thread: の直後がリスト/インデント行なら conflict(YAML を壊さない)", () => {
  const list = `---\n${CONCEPT}\nthread:\n  - a\n  - b\nsummary: x\n---\n`;
  assert.deepEqual(applyThreadLine(list, UUID), { next: list, result: "conflict" });
  const dash = `---\n${CONCEPT}\nthread:\n- a\nsummary: x\n---\n`;
  assert.equal(applyThreadLine(dash, UUID).result, "conflict");
  // 空行だけ挟んで次のキーが来る場合は埋めてよい
  const blank = `---\n${CONCEPT}\nthread:\n\nsummary: x\n---\n`;
  assert.equal(applyThreadLine(blank, UUID).result, "written");
});

test("assertWritableConceptNote: type: concept の別名も構想ノートとして受け、symlink を辿らない", () => {
  const v = vault();
  const alias = writeNote(v, "05_Projects/c.md", "type: concept\nstatus: 構想");
  assert.equal(assertWritableConceptNote(alias, v), fs.realpathSync(alias));
  const target = writeNote(v, "05_Projects/t.md", CONCEPT);
  const link = path.join(v, "05_Projects", "link.md");
  fs.symlinkSync(target, link);
  assert.throws(() => assertWritableConceptNote(link, v), /symlink/);
});

test("assertWritableConceptNote: バックアップ判定は大文字小文字を区別しない", () => {
  const root = vault();
  const file = writeNote(root, "obsidian-git/05_Projects/a.md", CONCEPT);
  assert.throws(() => assertWritableConceptNote(file, root), /バックアップ/);
});

test("recordConceptThread: Vault ロックを他プロセスが持っていれば書き込まずに待ち切る", async () => {
  const v = vault();
  const file = writeNote(v, "05_Projects/a.md", CONCEPT);
  const lock = vaultLock(v);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "other:process", "utf8"); // 生きた持ち主の lock(新しく作ったので stale ではない)
  await assert.rejects(
    () => recordConceptThread(file, UUID, { vaultDir: v }),
    /ロックが取れません/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), `---\n${CONCEPT}\n---\n# 見出し\n\n本文\n`);
  // 取れなかった側は、他人の lock を消さない
  assert.equal(fs.readFileSync(lock, "utf8"), "other:process");
});

test("recordConceptThread: 同時に呼んでも書くのは1回だけ(片方は already)", async () => {
  const v = vault();
  const file = writeNote(v, "05_Projects/a.md", CONCEPT);
  const results = await Promise.all([
    recordConceptThread(file, UUID, { vaultDir: v }),
    recordConceptThread(file, UUID, { vaultDir: v }),
  ]);
  assert.deepEqual(results.map((r) => r.result).sort(), ["already", "written"]);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.match(/^thread:/gm)?.length, 1);
});
