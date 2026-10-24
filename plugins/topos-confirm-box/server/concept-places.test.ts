import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { conceptPlace, placeName, zoneOfPath } from "../shared/concept-places.js";
import { readSidebarNotes, resolveConceptPlan } from "./notes.js";
import { moveConceptNote } from "./note-thread.js";

const CONCEPT = "type: concept-note\nstatus: 構想\ntitle: 構想A";
const IMPL = "type: implementation-note\nstatus: 実装中\ntitle: 実装B";

function vault(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "topos-vault-")));
}

function writeNote(file: string, fm: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${fm}\n---\n# 見出し\n`, "utf8");
  return file;
}

test("zoneOfPath: 区切り単位で判定する(似た名前の兄弟ディレクトリを拾わない)", () => {
  const place = conceptPlace("/v");
  assert.equal(zoneOfPath(path.join("/v/Paseo/構想/検討中/a.md"), place), "active");
  assert.equal(zoneOfPath(path.join("/v/Paseo/構想/あとで/a.md"), place), "later");
  assert.equal(zoneOfPath(path.join("/v/Paseo/構想/検討中メモ/a.md"), place), null);
  assert.equal(zoneOfPath(path.join("/v/05_Projects/ToposAI/構想ノート/a.md"), place), null);
  assert.equal(zoneOfPath(place.activeDir, place), null);
});

test("resolveConceptPlan: Paseo/構想 が無ければ旧置き場だけ(legacy)", () => {
  const v = vault();
  const plan = resolveConceptPlan(v);
  assert.deepEqual(plan, { active: null, later: null });
  assert.equal(placeName(plan), "legacy");
});

test("resolveConceptPlan: 検討中とあとでを作ると両方を読む(片方だけでも読む)", () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.root, { recursive: true });
  assert.deepEqual(resolveConceptPlan(v), { active: null, later: null });
  fs.mkdirSync(place.laterDir, { recursive: true });
  assert.deepEqual(resolveConceptPlan(v), { active: null, later: place.laterDir });
  fs.mkdirSync(place.activeDir, { recursive: true });
  const plan = resolveConceptPlan(v);
  assert.deepEqual(plan, { active: place.activeDir, later: place.laterDir });
  assert.equal(placeName(plan), "paseo");
});

test("readSidebarNotes: 新置き場の区分を付け、件数を返す(実装ノートはactive)", () => {
  const v = vault();
  const place = conceptPlace(v);
  const active = writeNote(path.join(place.activeDir, "a.md"), CONCEPT);
  const later = writeNote(path.join(place.laterDir, "b.md"), CONCEPT);
  writeNote(path.join(place.root, "直下.md"), CONCEPT); // 区分の外は読まない
  const project = path.join(v, "05_Projects");
  writeNote(path.join(project, "impl.md"), IMPL);
  const r = readSidebarNotes({
    roots: [project],
    vaultDir: v,
    knownAgentIds: new Set(),
  });
  const byPath = new Map(r.notes.map((n) => [n.path, n]));
  assert.equal(byPath.get(active)?.zone, "active");
  assert.equal(byPath.get(later)?.zone, "later");
  assert.equal(byPath.get(path.join(project, "impl.md"))?.zone, "active");
  // 移せるのは置き場の直下の構想ノートだけ(旧置き場のノートに ⋯ を出さない)
  assert.equal(byPath.get(active)?.movable, true);
  assert.equal(byPath.get(later)?.movable, true);
  assert.equal(byPath.get(path.join(project, "impl.md"))?.movable, false);
  assert.equal(byPath.size, 3);
  assert.equal(r.place, "paseo");
  assert.deepEqual(r.zones, { active: 1, later: 1, laterAvailable: true });
});

test("readSidebarNotes: 旧置き場の構想ノートは検討中として数える", () => {
  const v = vault();
  const project = path.join(v, "05_Projects");
  writeNote(path.join(project, "構想ノート", "c.md"), CONCEPT);
  const r = readSidebarNotes({ roots: [project], vaultDir: v, knownAgentIds: new Set() });
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].zone, "active");
  assert.equal(r.notes[0].movable, false);
  assert.equal(r.place, "legacy");
  assert.deepEqual(r.zones, { active: 1, later: 0, laterAvailable: false });
});

test("moveConceptNote: 検討中→あとで→検討中(中身はそのまま)", async () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.activeDir, { recursive: true });
  fs.mkdirSync(place.laterDir, { recursive: true });
  const a = writeNote(path.join(place.activeDir, "a.md"), CONCEPT);
  const before = fs.readFileSync(a, "utf8");
  const r = await moveConceptNote(a, "later", { vaultDir: v });
  assert.equal(r.result, "moved");
  assert.equal(r.notePath, path.join(place.laterDir, "a.md"));
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.readFileSync(r.notePath, "utf8"), before);
  // 同じ区分へは何もしない
  const again = await moveConceptNote(r.notePath, "later", { vaultDir: v });
  assert.equal(again.result, "already");
  const back = await moveConceptNote(r.notePath, "active", { vaultDir: v });
  assert.equal(back.notePath, a);
  assert.equal(fs.readFileSync(a, "utf8"), before);
});

test("moveConceptNote: 置き場の外・実装ノート・置き場が無い・同名ありは移さない", async () => {
  const v = vault();
  const place = conceptPlace(v);
  const outside = writeNote(path.join(v, "05_Projects", "c.md"), CONCEPT);
  // 置き場が無い(根も無い)
  await assert.rejects(moveConceptNote(outside, "later", { vaultDir: v }), /置き場がありません/);
  fs.mkdirSync(place.activeDir, { recursive: true });
  // あとでだけ無い(移行の途中)
  await assert.rejects(moveConceptNote(outside, "later", { vaultDir: v }), /置き場がありません/);
  fs.mkdirSync(place.laterDir, { recursive: true });
  await assert.rejects(moveConceptNote(outside, "later", { vaultDir: v }), /置き場の直下/);
  const impl = writeNote(path.join(place.activeDir, "impl.md"), IMPL);
  await assert.rejects(moveConceptNote(impl, "later", { vaultDir: v }), /構想ノートではありません/);
  const a = writeNote(path.join(place.activeDir, "a.md"), CONCEPT);
  writeNote(path.join(place.laterDir, "a.md"), CONCEPT); // 移動先に同名
  await assert.rejects(moveConceptNote(a, "later", { vaultDir: v }), /同じ名前/);
  assert.equal(fs.existsSync(a), true); // 元はそのまま
});

test("moveConceptNote: あとでのサブディレクトリのノートは移さない(木ごと動かさない)", async () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.activeDir, { recursive: true });
  fs.mkdirSync(place.laterDir, { recursive: true });
  const deep = writeNote(path.join(place.laterDir, "sub", "x.md"), CONCEPT);
  await assert.rejects(moveConceptNote(deep, "active", { vaultDir: v }), /置き場の直下/);
});

test("moveConceptNote: 置き場のディレクトリが symlink なら移さない(Vault の外へ出さない)", async () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.activeDir, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "topos-outside-"));
  fs.symlinkSync(outside, place.laterDir); // あとで → Vault の外
  const a = writeNote(path.join(place.activeDir, "a.md"), CONCEPT);
  await assert.rejects(moveConceptNote(a, "later", { vaultDir: v }), /通常のディレクトリで/);
  assert.equal(fs.existsSync(path.join(outside, "a.md")), false);
  assert.equal(fs.existsSync(a), true);
});

test("zoneOfPath: ファイル名の正規化(NFD)が違っても同じ区分と判定する", () => {
  const place = conceptPlace("/v");
  // macOS では「検討中」が NFD(結合文字)で返ることがある。
  const nfd = path.join("/v/Paseo/構想/検討中".normalize("NFD"), "a.md");
  assert.equal(zoneOfPath(nfd, place), "active");
});
