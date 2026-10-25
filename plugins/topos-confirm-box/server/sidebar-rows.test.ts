import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SidebarNote } from "../shared/notes.js";
import { readSidebarNotes } from "./notes.js";
import {
  buildUpperRows,
  coordinatorIdSet,
  countStatusLabels,
  groupPressAction,
  indexImplementationNotes,
  lowerTierNotes,
  openableParentIds,
  rowGroupKeyOf,
  visibleGroupKeyOf,
} from "../shared/sidebar-rows.js";
import { COORDINATOR_GROUP, PINNED_GROUP } from "../shared/sidebar-section-mode.js";
import type { RowThread } from "../shared/sidebar-rows.js";

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
  zone: "active",
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

test("上段: 登録簿に載らないスレの語彙(待機中/承認待ち)は状態文字へ写す", () => {
  const rows = buildUpperRows(
    [
      { agentId: "run", status: "実装中", title: "実行中" },
      { agentId: "wait", status: "承認待ち", title: "承認待ち" },
      { agentId: "idle", status: "待機中", title: "待機" },
    ],
    new Map(),
  );
  // 待機中の行も残す(「出ない」症状の原因そのもの。色だけ動いていないと分かるようにする)
  assert.deepEqual(
    rows.map((r) => [r.thread.agentId, r.statusLabel]),
    [
      ["run", "実装中"],
      ["wait", "判断待ち"],
      ["idle", "待機中"],
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

const DONE_ID = "11111111-1111-4111-8111-111111111111";
const BUSY_ID = "22222222-2222-4222-8222-222222222222";
const BARE_ID = "33333333-3333-4333-8333-333333333333";

test("通し: 実走査→implByThread→buildUpperRowsで、完了ノートのスレは上段から消える", () => {
  // 出口レビュー指摘1の再発防止。サーバー側で done を落とすと、クライアントでは
  // 「ノート無しの実装中スレ」として戻ってしまうため、走査から描画行まで通して確かめる。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topos-two-tier-"));
  fs.writeFileSync(
    path.join(dir, "done.md"),
    `---\ntype: implementation-note\nstatus: 完了\ntitle: 終わった\nthread: ${DONE_ID}\n---\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "busy.md"),
    `---\ntype: implementation-note\nstatus: 判断待ち\ntitle: 未決あり\nthread: ${BUSY_ID}\n---\n`,
    "utf8",
  );
  const { notes, implByThread } = scanAndIndex(dir);
  assert.equal(notes.length, 2);
  const rows = buildUpperRows<RowThread>(
    [thread(DONE_ID, "実装中"), thread(BUSY_ID, "実装中"), thread(BARE_ID, "実装中")],
    implByThread,
  );
  assert.deepEqual(
    rows.map((r) => [r.thread.agentId, r.statusLabel]),
    [
      [BUSY_ID, "判断待ち"],
      [BARE_ID, "実装中"],
    ],
  );
});

// 索引は本番と同じ関数を使う(写しを持つと、片方だけ直したときにテストが通ってしまう)。
function scanAndIndex(dir: string): {
  notes: SidebarNote[];
  implByThread: ReadonlyMap<string, SidebarNote>;
} {
  // 実 Vault の構想の置き場を混ぜない(このテストは渡した dir だけを見る)
  const { notes } = readSidebarNotes({
    roots: [dir],
    vaultDir: dir,
    concept: { active: null, later: null },
  });
  return { notes, implByThread: indexImplementationNotes(notes) };
}

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

test("見出しの押下: 生きた親だけ開く(子司令塔でも一覧に生きていれば開く)", () => {
  const openable = new Set(["child-coordinator"]);
  assert.equal(groupPressAction("child-coordinator", openable, "__coordinators"), "open");
});

test("見出しの押下: 「司令塔」グループ・「その他」・開けない親は開閉", () => {
  const openable = new Set(["child-coordinator"]);
  assert.equal(groupPressAction("__coordinators", openable, "__coordinators"), "toggle");
  assert.equal(groupPressAction("", openable, "__coordinators"), "toggle");
  assert.equal(groupPressAction("archived-parent", openable, "__coordinators"), "toggle");
});

// 出口レビュー round1 指摘1: 親は行として出ない(見出しだけ)。本番の形(子だけが行)で
// 見出しキーと突き合わせられること。
test("見出しの押下: 親の行が無く子の行だけでも、生きている親の見出しで開く", () => {
  const rows = [
    { agentId: "kid-1", parentAgentId: "a59b3f21", parentOpenable: true },
    { agentId: "kid-2", parentAgentId: "a59b3f21", parentOpenable: true },
    { agentId: "orphan", parentAgentId: null, parentOpenable: false },
  ];
  const openable = openableParentIds(rows);
  assert.deepEqual([...openable], ["a59b3f21"]);
  assert.equal(groupPressAction("a59b3f21", openable, "__coordinators"), "open");
  // 子の id を親の id と取り違えない
  assert.equal(groupPressAction("kid-1", openable, "__coordinators"), "toggle");
});

test("見出しの押下: 開けない親の子しか無ければ開閉(開けない画面に落とさない)", () => {
  const rows = [{ agentId: "kid", parentAgentId: "dead-parent", parentOpenable: false }];
  const openable = openableParentIds(rows);
  assert.equal(openable.size, 0);
  assert.equal(groupPressAction("dead-parent", openable, "__coordinators"), "toggle");
});

// 出口レビュー round2 指摘4: 「行 → グループのキー → 見出しの押下」を通しで検査する
// (行の `parentOpenable` が立っていても、グループのキーが「司令塔」なら開閉のみ)。
test("通し: 子司令塔の見出しは開き、司令塔の行が上段から外れた司令塔の見出しは開閉のみ", () => {
  const rows = [
    { agentId: "kid", parentAgentId: "child-coord", parentOpenable: true },
    { agentId: "kid2", parentAgentId: "chief", parentOpenable: true },
  ];
  const openable = openableParentIds(rows);

  // 1) 子司令塔は coordinatorIds に居ない → 見出しのキーは親の id になり、押すと開く
  const key = visibleGroupKeyOf(rows[0], new Set(), COORDINATOR_GROUP);
  assert.equal(key, "child-coord");
  assert.equal(groupPressAction(key, openable, COORDINATOR_GROUP), "open");

  // 2) 総司令は coordinatorIds に居る → 「司令塔」グループへ寄り、見出しは開閉のみ
  const chiefKey = visibleGroupKeyOf(rows[1], new Set(["chief"]), COORDINATOR_GROUP);
  assert.equal(chiefKey, COORDINATOR_GROUP);
  assert.equal(groupPressAction(chiefKey, openable, COORDINATOR_GROUP), "toggle");
});

// 出口レビュー round3 指摘3: 通しテストが手で作った集合ではなく、**画面と同じ作り方**
// (`coordinatorIdSet(全スレ)`)でキーを決める。上段から外れた司令塔(子スレだけ上段に出る形)でも
// 子スレは「司令塔」へ寄り、押しても開閉のみのままになる。
test("通し(画面と同じ集合): 司令塔が上段から外れていても、子スレは「司令塔」へ寄る", () => {
  const row = (
    agentId: string,
    parentAgentId: string | null,
    coordinator: boolean,
    parentOpenable = false,
  ): RowThread & {
    parentAgentId: string | null;
    coordinator: boolean;
    parentOpenable: boolean;
  } => ({
    agentId,
    title: agentId,
    status: "実装中",
    parentAgentId,
    coordinator,
    parentOpenable,
  });
  const allThreads = [
    row("chief", null, true),
    row("kid2", "chief", false, true),
    row("kid", "child-coord", false, true),
  ];
  const coordinatorIds = coordinatorIdSet(allThreads);
  assert.deepEqual([...coordinatorIds], ["chief"]);
  // 上段の行 = 子スレだけ(司令塔の行は上段に無い。ノートの status で絞られるため)。
  const upper = buildUpperRows(
    allThreads.filter((t) => !t.coordinator),
    new Map(),
  ).map((r) => r.thread);
  const openable = openableParentIds(upper);
  const keyOf = (id: string) =>
    visibleGroupKeyOf(upper.find((t) => t.agentId === id)!, coordinatorIds, COORDINATOR_GROUP);
  assert.equal(keyOf("kid2"), COORDINATOR_GROUP);
  assert.equal(groupPressAction(COORDINATOR_GROUP, openable, COORDINATOR_GROUP), "toggle");
  // 子司令塔の子スレは本人の見出しになり、押すと開く
  assert.equal(keyOf("kid"), "child-coord");
  assert.equal(groupPressAction(keyOf("kid"), openable, COORDINATOR_GROUP), "open");
  // 並べ替え側(全スレ)のキーと揃う
  const reorderKey = visibleGroupKeyOf(allThreads[1], coordinatorIds, COORDINATOR_GROUP);
  assert.equal(reorderKey, keyOf("kid2"));
});

// ---- 判断待ちと完了待ちの分離(2026-10-25 ユーザー指示) ----

const doneUnconfirmed = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  status: "完了" as const,
  title: agentId,
  summaryAcked: false,
  ...over,
});

test("完了報告済みで未確認のスレは『完了待ち』の行になり、判断待ちとは別ラベル", () => {
  const impl = new Map([
    ["b", note({ path: "/v/b.md", status: "実装中", title: "ノートB" })],
    ["c", note({ path: "/v/c.md", status: "確認待ち", title: "ノートC" })],
  ]);
  const rows = buildUpperRows(
    [
      doneUnconfirmed("a"), // ノート無し
      doneUnconfirmed("b"), // ノートは古く実装中のまま
      doneUnconfirmed("c"), // ノートは確認待ち
      thread("d", "ユーザー判断待ち"),
    ],
    impl,
  );
  assert.deepEqual(
    rows.map((r) => [r.thread.agentId, r.statusLabel]),
    [
      ["a", "完了待ち"],
      ["b", "完了待ち"],
      ["c", "完了待ち"],
      ["d", "判断待ち"],
    ],
  );
  assert.equal(rows[1].title, "ノートB"); // 題名はノート優先のまま
});

test("完了待ちにならないもの: 確認済み・ノートが判断待ち/完了・司令塔・summaryAcked不明", () => {
  const impl = new Map([
    ["judge", note({ path: "/v/j.md", status: "判断待ち" })],
    ["fin", note({ path: "/v/f.md", status: "完了" })],
  ]);
  const rows = buildUpperRows(
    [
      doneUnconfirmed("acked", { summaryAcked: true }),
      doneUnconfirmed("judge"), // ユーザー判断が残っているノートは判断待ちのまま
      doneUnconfirmed("fin"), // ノートが完了 = 上段から外す(従来どおり)
      doneUnconfirmed("coord", { coordinator: true }),
      { agentId: "unknown", status: "完了" as const, title: "unknown" }, // summaryAcked 未指定
    ],
    impl,
  );
  assert.deepEqual(
    rows.map((r) => [r.thread.agentId, r.statusLabel]),
    [["judge", "判断待ち"]], // 他は従来どおり上段に出ない(完了はノート無しなら外す)
  );
});

test("countStatusLabels は判断待ちと完了待ちを別々に数える", () => {
  const rows = buildUpperRows(
    [
      thread("a", "ユーザー判断待ち"),
      thread("b", "ユーザー判断待ち"),
      doneUnconfirmed("c"),
      thread("d", "実装中"),
    ],
    new Map(),
  );
  assert.deepEqual(countStatusLabels(rows), {
    judgment: 2,
    doneWait: 1,
    running: 1,
    coordinator: 0,
    idle: 0,
  });
});

test("countStatusLabels は実装中・司令塔・待機中も数え、司令塔は実装中に含めない", () => {
  const rows = buildUpperRows(
    [
      thread("a", "実装中"),
      thread("b", "実装中"),
      { agentId: "c", status: "実装中" as const, title: "c", coordinator: true },
      { agentId: "d", status: "待機中" as const, title: "d" },
    ],
    new Map(),
  );
  assert.deepEqual(countStatusLabels(rows), {
    judgment: 0,
    doneWait: 0,
    running: 2,
    coordinator: 1,
    idle: 1,
  });
});

// ---- ピン止めを「司令塔」の外へ出す(2026-10-25 ユーザー指示) ----

const groupOf = (
  t: { agentId: string; parentAgentId: string | null; coordinator?: boolean; pinned?: boolean },
  coordinatorIds: ReadonlySet<string> = new Set(),
) => rowGroupKeyOf(t, coordinatorIds, COORDINATOR_GROUP, PINNED_GROUP);

test("ピン止めした行は所属グループ(司令塔を含む)から外れて「ピン止め」グループへ", () => {
  const chiefKid = { agentId: "kid2", parentAgentId: "chief", pinned: true };
  assert.equal(groupOf(chiefKid, new Set(["chief"])), PINNED_GROUP);
  // 親を持つ行も同じ(見出しの下に残さない)
  assert.equal(groupOf({ agentId: "a1", parentAgentId: "p1", pinned: true }), PINNED_GROUP);
  assert.equal(groupOf({ agentId: "x1", parentAgentId: null, pinned: true }), PINNED_GROUP);
  // ピンでない行は従来どおり(司令塔の子は司令塔へ、子司令塔は本人の見出しへ)
  assert.equal(groupOf({ ...chiefKid, pinned: false }, new Set(["chief"])), COORDINATOR_GROUP);
  assert.equal(groupOf({ agentId: "kid", parentAgentId: "child-coord" }), "child-coord");
  // `pinned` 未指定・false は今までどおり(既定の一覧を変えない)
  assert.equal(groupOf({ agentId: "tail", parentAgentId: null }), "");
});

test("司令塔の行はピンの印が付いていても「司令塔」グループのまま(外に出さない)", () => {
  // 司令塔は元々「司令塔」グループに居るので「外に出す」対象ではない(サーバーは pinned: false 固定)。
  assert.equal(
    groupOf({ agentId: "chief", parentAgentId: null, coordinator: true, pinned: true }),
    COORDINATOR_GROUP,
  );
  // 司令塔判定専用の `visibleGroupKeyOf` は変えない(ピンの振り分けは `rowGroupKeyOf` だけが持つ)
  assert.equal(
    visibleGroupKeyOf(
      { agentId: "kid2", parentAgentId: "chief" },
      new Set(["chief"]),
      COORDINATOR_GROUP,
    ),
    COORDINATOR_GROUP,
  );
});
