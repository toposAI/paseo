import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  frontmatterToNote,
  parseFrontmatter,
  readNoteHead,
  readSidebarNotes,
  resolveNoteRoots,
  resolveThreadId,
  sortNotes,
  threadIdFromBlockList,
} from "./notes.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topos-notes-"));
}

function write(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return file;
}

const note = (fm: string, body = "# 見出し\n\n本文\n") => `---\n${fm}\n---\n${body}`;

test("frontmatterは先頭の---ブロックだけを読む", () => {
  const fm = parseFrontmatter(note("type: concept-note\nstatus: 構想", "---\nstatus: 完了\n"));
  assert.equal(fm?.type, "concept-note");
  assert.equal(fm?.status, "構想");
});

test("frontmatterが無い/閉じていないファイルは読まない", () => {
  assert.equal(parseFrontmatter("# 見出し\n"), null);
  assert.equal(parseFrontmatter("---\ntype: concept-note\n"), null);
});

test("実装ノート: typeとstatusから上段の材料を作る", () => {
  const fm = parseFrontmatter(
    note(
      [
        "type: implementation-note",
        "status: 判断待ち",
        "title: 「二段サイドバー: 上段の絞り込み」",
        "summary: 未決が1件だけ残っている",
        "thread: 2165f646-cd93-4a7f-bbbe-1a4330795456",
        "concept_notes: [構想A, 構想B]",
      ].join("\n"),
    ),
  );
  const n = frontmatterToNote(fm ?? {}, "fallback");
  assert.equal(n?.kind, "implementation");
  assert.equal(n?.status, "判断待ち");
  assert.equal(n?.title, "「二段サイドバー: 上段の絞り込み」");
  assert.equal(n?.conclusion, "未決が1件だけ残っている");
  assert.equal(n?.threadId, "2165f646-cd93-4a7f-bbbe-1a4330795456");
  assert.deepEqual(n?.conceptLinks, ["構想A", "構想B"]);
});

test("statusが語彙外のノート(標準・目次)は対象外", () => {
  for (const status of ["decided", "living", "draft", "???"]) {
    assert.equal(
      frontmatterToNote({ type: "implementation-note", status }, "x"),
      null,
      `status=${status}`,
    );
  }
});

test("typeが無ければ対象外(誤って標準ノートを並べない)", () => {
  assert.equal(frontmatterToNote({ status: "実装中" }, "x"), null);
});

test("旧語彙ユーザー判断待ちは判断待ちとして読む", () => {
  const n = frontmatterToNote({ type: "concept-note", status: "ユーザー判断待ち" }, "x");
  assert.equal(n?.status, "判断待ち");
});

test("threadsのブロック形式からUUIDだけを拾う", () => {
  const text = note(
    [
      "type: implementation-note",
      "status: 実装中",
      "threads:",
      "- c389e3e",
      "- 2165f646-cd93-4a7f-bbbe-1a4330795456",
    ].join("\n"),
  );
  assert.deepEqual(threadIdFromBlockList(text), ["2165f646-cd93-4a7f-bbbe-1a4330795456"]);
});

test("タイトルが無ければファイル名から作る", () => {
  const fm = parseFrontmatter(note("type: concept-note\nstatus: 構想"));
  assert.equal(frontmatterToNote(fm ?? {}, "二段サイドバー")?.title, "二段サイドバー");
});

test("走査: typeで実装/構想を返し、statusでは絞らない(振り分けはクライアントの正)", () => {
  const dir = tmpDir();
  write(dir, "a-impl.md", note("type: implementation-note\nstatus: 実装中\ntitle: 実装A"));
  write(dir, "b-impl.md", note("type: implementation-note\nstatus: 完了\ntitle: 完了した実装"));
  write(dir, "c-concept.md", note("type: concept-note\nstatus: 構想\ntitle: 構想C"));
  write(dir, "d-concept.md", note("type: concept-note\nstatus: 確認待ち\ntitle: 判断待ちの構想"));
  write(dir, "e-standard.md", note("type: project-note\nstatus: decided\ntitle: 標準"));
  write(dir, "f-nofm.md", "# frontmatter無し\n");
  write(dir, ".hidden/g.md", note("type: concept-note\nstatus: 構想\ntitle: 隠し"));
  const r = readSidebarNotes({ roots: [dir] });
  // `完了` の実装ノートも返す。ここで落とすと、クライアントの「完了は畳む」判定に届かず
  // スレ側の古い status(実装中)で上段に戻る(出口レビュー指摘1)。
  // 並びは更新時刻順(同時刻ならパス順)なので、集合として比べる
  assert.deepEqual(
    r.notes.map((n) => `${n.title}:${n.status}`).sort(),
    ["実装A:実装中", "完了した実装:完了", "構想C:構想", "判断待ちの構想:確認待ち"].sort(),
  );
  for (const n of r.notes) assert.equal(path.isAbsolute(n.path), true);
  assert.equal(r.truncated, false);
});

test("走査: 走査先が無ければ黙って0件にせずthrowする(設定ミスを空表示と区別)", () => {
  assert.throws(
    () => readSidebarNotes({ roots: [path.join(tmpDir(), "missing")] }),
    /走査先がありません/,
  );
});

test("走査上限に当たったらtruncatedを立てる", () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i += 1) {
    write(dir, `n${i}.md`, note(`type: concept-note\nstatus: 構想\ntitle: C${i}`));
  }
  const r = readSidebarNotes({ roots: [dir], limit: 2 });
  assert.equal(r.truncated, true);
  assert.ok(r.notes.length <= 2);
});

test("走査先の既定はlive Vaultの05_Projects、バックアップは拒否", () => {
  const roots = resolveNoteRoots({ OBSIDIAN_VAULT_DIR: "/v/Vault" } as NodeJS.ProcessEnv);
  // Vault 全体は 6万本超で走査上限に当たるため、既定は 05_Projects だけを1本のルートにする
  assert.deepEqual(roots, ["/v/Vault/05_Projects"]);
  assert.throws(
    () =>
      resolveNoteRoots({
        OBSIDIAN_VAULT_DIR: "/Users/u/Documents/Obsidian-Git",
      } as NodeJS.ProcessEnv),
    /バックアップ/,
  );
});

test("sortNotesは新しい順・同時刻はパス順", () => {
  const [a, b] = sortNotes([
    {
      path: "/x/b.md",
      kind: "concept",
      status: "構想",
      title: "b",
      conclusion: "",
      threadId: null,
      threadCandidates: [],
      conceptLinks: [],
      updatedAt: 5,
    },
    {
      path: "/x/a.md",
      kind: "concept",
      status: "構想",
      title: "a",
      conclusion: "",
      threadId: null,
      threadCandidates: [],
      conceptLinks: [],
      updatedAt: 5,
    },
  ]);
  assert.equal(a.path, "/x/a.md");
  assert.equal(b.path, "/x/b.md");
});

test("resolveThreadId: 既存スレに一致する候補を優先し、無ければUUID・どれも無ければnull", () => {
  const known = new Set(["aaa-1", "2165f646-cd93-4a7f-bbbe-1a4330795456"]);
  assert.equal(
    resolveThreadId(["c389e3e", "2165f646-cd93-4a7f-bbbe-1a4330795456"], known),
    "2165f646-cd93-4a7f-bbbe-1a4330795456",
  );
  assert.equal(resolveThreadId(["c389e3e"], known), null);
  assert.equal(
    resolveThreadId(["c389e3e", "2165f646-cd93-4a7f-bbbe-1a4330795456"]),
    "2165f646-cd93-4a7f-bbbe-1a4330795456",
  );
  assert.equal(resolveThreadId(["c389e3e"]), null);
});

test("走査: threadIdは既存スレに解決し、候補は全部残す", () => {
  const dir = tmpDir();
  write(
    dir,
    "t.md",
    note(
      [
        "type: implementation-note",
        "status: 実装中",
        "threads:",
        "- c389e3e",
        "- 2165f646-cd93-4a7f-bbbe-1a4330795456",
      ].join("\n"),
    ),
  );
  const r = readSidebarNotes({
    roots: [dir],
    knownAgentIds: new Set(["2165f646-cd93-4a7f-bbbe-1a4330795456"]),
  });
  assert.equal(r.notes[0].threadId, "2165f646-cd93-4a7f-bbbe-1a4330795456");
  assert.deepEqual(r.notes[0].threadCandidates, ["2165f646-cd93-4a7f-bbbe-1a4330795456"]);
});

test("readNoteHeadは大きい本文でも先頭だけ読む", () => {
  const dir = tmpDir();
  const file = write(dir, "big.md", note("type: concept-note\nstatus: 構想", "x".repeat(100_000)));
  const head = readNoteHead(file);
  assert.ok(head && head.length < 20_000);
  assert.match(head ?? "", /status: 構想/);
});
