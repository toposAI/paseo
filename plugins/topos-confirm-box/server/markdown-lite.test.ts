import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseInline, parseMarkdown } from "../shared/markdown-lite.js";
import {
  confineToVault,
  readVaultNote,
  resetLinkIndex,
  resolveVaultLink,
  splitFrontmatter,
} from "./note-view.js";

test("インライン: wikilink・太字・コード・外部リンク", () => {
  const r = parseInline(
    "見る [[別ノート#節|表示]] と **強い** と `x` と [公式](https://a.b/c) ![[img.png]]",
  );
  assert.deepEqual(
    r.map((x) => x.t),
    ["text", "wikilink", "text", "bold", "text", "code", "text", "link", "text", "text"],
  );
  const w = r[1];
  assert.equal(w.t === "wikilink" && w.label, "表示");
});

test("ブロック: 見出し・リスト・表・コード・引用", () => {
  const b = parseMarkdown(
    "# 題\n\n本文1\n本文2\n\n- a\n  - b\n1. c\n\n> 引用\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\n---\n",
  );
  assert.deepEqual(
    b.map((x) => x.t),
    ["heading", "para", "list", "quote", "table", "code", "hr"],
  );
  const l = b[2];
  assert.equal(l.t === "list" && l.items[1].depth, 1);
  const t = b[4];
  assert.equal(t.t === "table" && t.rows.length, 2);
});

test("frontmatter を本文から分ける", () => {
  const r = splitFrontmatter("---\nstatus: 構想\n---\n\n本文");
  assert.deepEqual(r.head, ["status: 構想"]);
  assert.equal(r.body, "本文");
  assert.equal(splitFrontmatter("本文だけ").body, "本文だけ");
});

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nv-"));
  fs.mkdirSync(path.join(root, "Paseo", "構想", "検討中"), { recursive: true });
  fs.mkdirSync(path.join(root, "Other"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Paseo", "構想", "検討中", "a.md"),
    "---\nstatus: 構想\n---\n# A\n[[b]]",
  );
  fs.writeFileSync(path.join(root, "Paseo", "構想", "検討中", "b.md"), "B");
  fs.writeFileSync(path.join(root, "Other", "b.md"), "B2");
  fs.writeFileSync(path.join(root, "Other", "c.md"), "C");
  return root;
}

test("読み取り: Vault 内は読め、外・非md・バックアップは拒否", () => {
  const v = makeVault();
  const ok = readVaultNote(v, path.join(v, "Paseo", "構想", "検討中", "a.md"));
  assert.equal(ok.ok, true);
  assert.equal(ok.status, "構想");
  assert.equal(ok.rel, "Paseo/構想/検討中/a.md");
  const outside = path.join(os.tmpdir(), "nv-outside.md");
  fs.writeFileSync(outside, "x");
  assert.equal(readVaultNote(v, outside).ok, false);
  assert.equal(
    readVaultNote(v, path.join(v, "..", path.basename(v), "..", "nv-outside.md")).ok,
    false,
  );
  fs.writeFileSync(path.join(v, "x.txt"), "x");
  assert.equal(readVaultNote(v, path.join(v, "x.txt")).ok, false);
  // symlink で外へ出る指定
  fs.symlinkSync(outside, path.join(v, "link.md"));
  assert.equal(confineToVault(v, path.join(v, "link.md")).ok, false);
  const bk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bk-")), "Obsidian-Git");
  fs.mkdirSync(bk);
  fs.writeFileSync(path.join(bk, "n.md"), "x");
  assert.equal(readVaultNote(bk, path.join(bk, "n.md")).ok, false);
});

test("リンク解決: 同じフォルダ優先・見つからなければ失敗", () => {
  const v = makeVault();
  resetLinkIndex();
  const from = path.join(v, "Paseo", "構想", "検討中", "a.md");
  const r = resolveVaultLink(v, from, "b|別名");
  assert.equal(r.ok, true);
  assert.ok(r.path?.endsWith(path.join("検討中", "b.md")));
  assert.equal(resolveVaultLink(v, from, "c#節").ok, true);
  assert.equal(
    resolveVaultLink(v, from, "Other/b").path?.endsWith(path.join("Other", "b.md")),
    true,
  );
  assert.equal(resolveVaultLink(v, from, "ない").ok, false);
  assert.equal(resolveVaultLink(v, from, "../../etc/passwd").ok, false);
});

test("拒否: 隠しフォルダ・外へ向くフォルダのsymlink・URLエンコード名", () => {
  const v = makeVault();
  resetLinkIndex();
  fs.mkdirSync(path.join(v, ".obsidian"));
  fs.writeFileSync(path.join(v, ".obsidian", "h.md"), "x");
  assert.equal(readVaultNote(v, path.join(v, ".obsidian", "h.md")).ok, false);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nv-outdir-"));
  fs.writeFileSync(path.join(outDir, "s.md"), "secret");
  fs.symlinkSync(outDir, path.join(v, "escape"));
  assert.equal(readVaultNote(v, path.join(v, "escape", "s.md")).ok, false);
  const from = path.join(v, "Paseo", "構想", "検討中", "a.md");
  assert.equal(resolveVaultLink(v, from, "%2e%2e/%2e%2e/etc/passwd").ok, false);
  assert.equal(resolveVaultLink(v, from, "escape/s").ok, false);
  assert.equal(resolveVaultLink(v, path.join(outDir, "s.md"), "a").ok, false);
});

test("相対指定のリンクはフォルダ境界で一致させる / .md でない実体を指す symlink は拒否", () => {
  const v = makeVault();
  resetLinkIndex();
  fs.mkdirSync(path.join(v, "AnOther"));
  fs.writeFileSync(path.join(v, "AnOther", "zz.md"), "x");
  const from = path.join(v, "Paseo", "構想", "検討中", "a.md");
  assert.equal(resolveVaultLink(v, from, "Other/zz").ok, false);
  assert.equal(resolveVaultLink(v, from, "AnOther/zz").ok, true);
  fs.writeFileSync(path.join(v, "data.json"), "{}");
  fs.symlinkSync(path.join(v, "data.json"), path.join(v, "alias.md"));
  assert.equal(readVaultNote(v, path.join(v, "alias.md")).ok, false);
});
