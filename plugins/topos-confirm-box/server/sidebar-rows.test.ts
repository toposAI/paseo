import assert from "node:assert/strict";
import { test } from "node:test";
import type { SidebarNote } from "../shared/notes.js";
import { buildUpperRows, lowerTierNotes } from "../shared/sidebar-rows.js";

const thread = (
  agentId: string,
  status: "実装中" | "ユーザー判断待ち" | "完了",
  title = agentId,
) => ({
  agentId,
  status,
  title,
});

const note = (over: Partial<SidebarNote>): SidebarNote => ({
  path: "/v/A.md",
  kind: "implementation",
  status: "実装中",
  title: "ノートA",
  conclusion: "",
  threadId: null,
  threadCandidates: [],
  conceptLinks: [],
  updatedAt: 1,
  ...over,
});

test("上段: ノートのstatusが実装中/判断待ち/確認待ちの行だけ、題名はノート優先", () => {
  const impl = new Map([
    ["a", note({ path: "/v/a.md", status: "実装中", title: "ノート題名A" })],
    ["b", note({ path: "/v/b.md", status: "確認待ち", title: "" })],
    ["c", note({ path: "/v/c.md", status: "判断待ち", title: "ノート題名C" })],
    ["d", note({ path: "/v/d.md", status: "完了", title: "終わった" })],
  ]);
  const rows = buildUpperRows(
    [thread("a", "完了"), thread("b", "完了"), thread("c", "完了"), thread("d", "実装中")],
    impl,
  );
  assert.deepEqual(
    rows.map((r) => [r.thread.agentId, r.title, r.statusLabel]),
    [
      ["a", "ノート題名A", "実装中"],
      ["b", "b", "確認待ち"], // ノートの題名が空ならスレの題名
      ["c", "ノート題名C", "判断待ち"],
    ],
  );
  assert.ok(rows.every((r) => r.note !== null));
});

test("上段: ノートの無いスレは移行期間として従来どおり出す(完了だけ外す)", () => {
  const rows = buildUpperRows(
    [thread("x", "実装中"), thread("y", "ユーザー判断待ち"), thread("z", "完了")],
    new Map(),
  );
  // スレ側の旧語彙「ユーザー判断待ち」はノート語彙の「判断待ち」で出す
  assert.deepEqual(
    rows.map((r) => [r.thread.agentId, r.statusLabel, r.note]),
    [
      ["x", "実装中", null],
      ["y", "判断待ち", null],
    ],
  );
});

test("上段: 並びは入力順を保つ(ドラッグ並びを壊さない)", () => {
  const rows = buildUpperRows(
    [thread("3", "実装中"), thread("1", "実装中"), thread("2", "実装中")],
    new Map(),
  );
  assert.deepEqual(
    rows.map((r) => r.thread.agentId),
    ["3", "1", "2"],
  );
});

test("下段: 構想/壁打ち中の構想ノートだけ", () => {
  const notes = [
    note({ path: "/v/1.md", kind: "concept", status: "構想" }),
    note({ path: "/v/2.md", kind: "concept", status: "壁打ち中" }),
    note({ path: "/v/3.md", kind: "concept", status: "実装中" }),
    note({ path: "/v/4.md", kind: "implementation", status: "構想" }),
  ];
  assert.deepEqual(
    lowerTierNotes(notes).map((n) => n.path),
    ["/v/1.md", "/v/2.md"],
  );
});
