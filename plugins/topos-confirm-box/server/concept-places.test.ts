import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { conceptPlace, isDirectChild, placeName, zoneOfPath } from "../shared/concept-places.js";
import { dirnameOf, normalizeOf, relativeOf } from "../shared/concept-paths.js";
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

test("concept-paths: 純関数が node:path と同じ結果になる(共有バンドルに Node を入れないため)", () => {
  const P = path.posix;
  // 連続 `/` の扱いは意図的に path と違う(置き場のパスは正規形で組むので、正規化して畳む)。
  const cases = ["/v/a/b/c.md", "/v/a/", "/a.md", "a/b", "b"];
  for (const file of cases) {
    assert.equal(dirnameOf(file), P.dirname(file), `dirname(${file})`);
    assert.equal(normalizeOf(file), P.normalize(file), `normalize(${file})`);
  }
  const rels: [string, string][] = [
    ["/v/Paseo/構想/検討中", "/v/Paseo/構想/検討中/a.md"],
    ["/v/Paseo/構想/検討中", "/v/Paseo/構想/あとで/a.md"],
    ["/v/Paseo/構想/検討中/a.md", "/v/Paseo/構想/検討中/a.md"],
    ["/v/構想/検討中", "/v/構想/検討中メモ/a.md"],
    ["/v/構想/検討中/", "/v/構想/検討中/sub/a.md"],
  ];
  for (const [base, to] of rels) {
    assert.equal(relativeOf(base, to), P.relative(base, to), `relative(${base}, ${to})`);
  }
});

test("isDirectChild: NFD のファイルパスでも置き場の直下と判定する", () => {
  const place = conceptPlace("/v");
  const nfd = path.join(place.activeDir.normalize("NFD"), "a.md");
  assert.equal(isDirectChild(nfd, place.activeDir), true);
  assert.equal(isDirectChild(path.join(place.activeDir, "sub", "a.md"), place.activeDir), false);
  assert.equal(isDirectChild(path.join(place.activeDir, "a.md"), place.laterDir), false);
});

test("置き場が symlink: ノートは読むが、移動の ⋯ は出さない(黙って消さない・押して必ず失敗させない)", () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.root, { recursive: true });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "topos-real-"));
  fs.symlinkSync(real, place.activeDir);
  fs.mkdirSync(place.laterDir, { recursive: true });
  const note = writeNote(path.join(real, "a.md"), CONCEPT);
  // 読む側は symlink を辿る(ノートが一覧から消えない)
  assert.deepEqual(resolveConceptPlan(v), { active: place.activeDir, later: place.laterDir });
  const r = readSidebarNotes({ roots: [], vaultDir: v });
  const row = r.notes.find((n) => n.path === path.join(place.activeDir, "a.md"));
  assert.equal(row?.zone, "active");
  assert.equal(row?.movable, false); // 移せない(移動側のガードと一致)
  assert.equal(fs.existsSync(note), true);
});

test("moveConceptNote: 前回の link の後で止まった残り(同名・同じ実体)は移せて、2か所に残らない", async () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.activeDir, { recursive: true });
  fs.mkdirSync(place.laterDir, { recursive: true });
  const a = writeNote(path.join(place.activeDir, "a.md"), CONCEPT);
  // link だけ済んで unlink 前に落ちた状態を作る(同じ実体への2本目のリンク)
  const half = path.join(place.laterDir, "a.md");
  fs.linkSync(a, half);
  const r = await moveConceptNote(a, "later", { vaultDir: v });
  assert.equal(r.result, "moved");
  assert.equal(r.notePath, half);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(half), true);
});

test("moveConceptNote: 移動先が移動元を指す symlink なら、実体を消さずに移さない", async () => {
  const v = vault();
  const place = conceptPlace(v);
  fs.mkdirSync(place.activeDir, { recursive: true });
  fs.mkdirSync(place.laterDir, { recursive: true });
  const a = writeNote(path.join(place.activeDir, "a.md"), CONCEPT);
  const before = fs.readFileSync(a, "utf8");
  const link = path.join(place.laterDir, "a.md");
  fs.symlinkSync(a, link); // あとで/a.md → 検討中/a.md
  await assert.rejects(moveConceptNote(a, "later", { vaultDir: v }), /同じ名前/);
  // 実体は残り、symlink もそのまま(壊さない)
  assert.equal(fs.readFileSync(a, "utf8"), before);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});
