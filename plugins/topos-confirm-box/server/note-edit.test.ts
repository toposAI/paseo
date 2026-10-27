import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveVaultNote } from "./note-edit.js";
import { noteVersion, readVaultNote } from "./note-view.js";

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "note-edit-")));
  const vault = path.join(tmp, "Vault");
  const hist = path.join(tmp, "hist");
  fs.mkdirSync(path.join(vault, "構想"), { recursive: true });
  const note = path.join(vault, "構想", "a.md");
  fs.writeFileSync(note, "# 題\n本文\n");
  return { tmp, vault, hist, note };
}

test("保存: 版が一致すれば書き換わり、前の全文が履歴に残る", async () => {
  const { vault, hist, note } = setup();
  const r0 = readVaultNote(vault, note);
  assert.equal(r0.editable, true);
  const r = await saveVaultNote(vault, note, "# 題\n新しい\n", r0.version, hist);
  assert.equal(r.status, "saved");
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n新しい\n");
  assert.equal(r.version, noteVersion("# 題\n新しい\n"));
  const dirs = fs.readdirSync(hist);
  assert.equal(dirs.length, 1);
  const snaps = fs.readdirSync(path.join(hist, dirs[0])).filter((n) => n.endsWith(".md"));
  assert.equal(snaps.length, 1);
  assert.equal(fs.readFileSync(path.join(hist, dirs[0], snaps[0]), "utf8"), "# 題\n本文\n");
});

test("競合: 開いた後に別で変わっていたら上書きせず今の全文を返す", async () => {
  const { vault, hist, note } = setup();
  const base = readVaultNote(vault, note).version;
  fs.writeFileSync(note, "# 題\n他で編集\n");
  const r = await saveVaultNote(vault, note, "# 題\n自分の編集\n", base, hist);
  assert.equal(r.status, "conflict");
  assert.equal(r.current, "# 題\n他で編集\n");
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n他で編集\n");
  assert.equal(fs.existsSync(hist), false);
});

test("変更なし・base 空・NUL・大きすぎは書かない", async () => {
  const { vault, hist, note } = setup();
  const base = readVaultNote(vault, note).version;
  assert.equal((await saveVaultNote(vault, note, "# 題\n本文\n", base, hist)).status, "unchanged");
  assert.equal((await saveVaultNote(vault, note, "x", "", hist)).status, "rejected");
  assert.equal((await saveVaultNote(vault, note, "a\0b", base, hist)).status, "rejected");
  assert.equal(
    (await saveVaultNote(vault, note, "a".repeat(1024 * 1024 + 1), base, hist)).status,
    "rejected",
  );
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n本文\n");
});

test("拒否: Vault外・symlink・非md・隠しフォルダ・バックアップ・新規ファイル", async () => {
  const { tmp, vault, hist, note } = setup();
  const outside = path.join(tmp, "out.md");
  fs.writeFileSync(outside, "外");
  fs.symlinkSync(outside, path.join(vault, "link.md"));
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.writeFileSync(path.join(vault, ".obsidian", "x.md"), "隠");
  fs.writeFileSync(path.join(vault, "a.txt"), "t");
  const backupRoot = path.join(tmp, "Obsidian-Git");
  fs.mkdirSync(backupRoot);
  fs.writeFileSync(path.join(backupRoot, "b.md"), "bk");
  const targets = [
    outside,
    path.join(vault, "link.md"),
    path.join(vault, ".obsidian", "x.md"),
    path.join(vault, "a.txt"),
    path.join(backupRoot, "b.md"),
    path.join(vault, "新規.md"),
    path.join(vault, "構想", "..", "..", "out.md"),
  ];
  for (const t of targets) {
    const r = await saveVaultNote(vault, t, "改ざん", "v", hist);
    assert.equal(r.status, "rejected", t);
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "外");
  assert.equal(fs.readFileSync(path.join(backupRoot, "b.md"), "utf8"), "bk");
  assert.equal(fs.existsSync(path.join(vault, "新規.md")), false);
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n本文\n");
});

test("CRLF は保存後も CRLF のまま。混在・非UTF-8 は保存しない", async () => {
  const { vault, hist, note } = setup();
  fs.writeFileSync(note, "# 題\r\n本文\r\n");
  const r0 = readVaultNote(vault, note);
  assert.equal(r0.raw, "# 題\n本文\n");
  const r = await saveVaultNote(vault, note, "# 題\n変更\n", r0.version, hist);
  assert.equal(r.status, "saved");
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\r\n変更\r\n");

  fs.writeFileSync(note, "a\r\nb\nc\n");
  const m = readVaultNote(vault, note);
  assert.equal(m.editable, false);
  assert.equal(
    (await saveVaultNote(vault, note, "z", noteVersion("a\r\nb\nc\n"), hist)).status,
    "rejected",
  );

  fs.writeFileSync(note, Buffer.from([0xff, 0xfe, 0x41]));
  assert.equal(readVaultNote(vault, note).editable, false);
  assert.equal((await saveVaultNote(vault, note, "z", "v", hist)).status, "rejected");
});

test("履歴を残せない(Vault内・書けない)なら保存しない", async () => {
  const { tmp, vault, note } = setup();
  const base = readVaultNote(vault, note).version;
  const inside = await saveVaultNote(vault, note, "# 題\nx\n", base, path.join(vault, "hist"));
  assert.equal(inside.status, "rejected");
  const blocker = path.join(tmp, "file-not-dir");
  fs.writeFileSync(blocker, "");
  const bad = await saveVaultNote(vault, note, "# 題\nx\n", base, path.join(blocker, "h"));
  assert.equal(bad.status, "rejected");
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n本文\n");
  const bk = await saveVaultNote(
    vault,
    note,
    "# 題\nx\n",
    base,
    path.join(tmp, "Obsidian-Git", "h"),
  );
  assert.equal(bk.status, "rejected");
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n本文\n");
});

test("履歴は世代数の上限で古いものから消える", async () => {
  const { vault, hist, note } = setup();
  let text = "# 題\n0\n";
  fs.writeFileSync(note, text);
  for (let i = 1; i <= 53; i++) {
    const base = readVaultNote(vault, note).version;
    text = `# 題\n${i}\n`;
    const r = await saveVaultNote(vault, note, text, base, hist);
    assert.equal(r.status, "saved");
  }
  const d = fs.readdirSync(hist)[0];
  assert.equal(fs.readdirSync(path.join(hist, d)).filter((n) => n.endsWith(".md")).length, 50);
});

test("BOM は保存後も残り、履歴は生バイトのまま", async () => {
  const { vault, hist, note } = setup();
  fs.writeFileSync(
    note,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# 題\n本文\n")]),
  );
  const r0 = readVaultNote(vault, note);
  assert.equal(r0.editable, true);
  const r = await saveVaultNote(vault, note, r0.raw.replace("本文", "変更"), r0.version, hist);
  assert.equal(r.status, "saved");
  const after = fs.readFileSync(note);
  assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(r.version, noteVersion(after));
  const d = fs.readdirSync(hist)[0];
  const snap = fs.readdirSync(path.join(hist, d)).find((n) => n.endsWith(".md")) as string;
  assert.deepEqual(
    [...fs.readFileSync(path.join(hist, d, snap)).subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
  );
});

test("単独の CR を含む入力でも混在ファイルにならない", async () => {
  const { vault, hist, note } = setup();
  const base = readVaultNote(vault, note).version;
  const r = await saveVaultNote(vault, note, "a\rb\r\nc\n", base, hist);
  assert.equal(r.status, "saved");
  assert.equal(fs.readFileSync(note, "utf8"), "a\nb\nc\n");
  assert.equal(readVaultNote(vault, note).editable, true);
});

test("履歴の置き場がバックアップへの symlink なら拒否", async () => {
  const { tmp, vault, note } = setup();
  const backup = path.join(tmp, "Obsidian-Git");
  fs.mkdirSync(backup);
  const link = path.join(tmp, "histlink");
  fs.symlinkSync(backup, link);
  const base = readVaultNote(vault, note).version;
  const r = await saveVaultNote(vault, note, "# 題\nx\n", base, link);
  assert.equal(r.status, "rejected");
  assert.equal(fs.readdirSync(backup).length, 0);
  assert.equal(fs.readFileSync(note, "utf8"), "# 題\n本文\n");
});
