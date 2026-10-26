import assert from "node:assert/strict";
import test from "node:test";
import { mergeUnregisteredThreads } from "./unregistered-threads.js";
import type { ChildThread } from "../shared/child-threads.js";

function row(agentId: string, over: Partial<ChildThread> = {}): ChildThread {
  return {
    agentId,
    title: `登録済み ${agentId}`,
    status: "実装中",
    machineState: "idle",
    request: "依頼",
    summaryItemId: null,
    nocard: false,
    summary: null,
    summaryState: null,
    summaryAcked: false,
    updatedAt: 1,
    parentAgentId: null,
    parentTitle: null,
    pinned: false,
    coordinator: false,
    parentOpenable: false,
    access: "open",
    ...over,
  };
}

test("登録簿に無いスレを後ろに足す(登録簿の行の順は変えない)", () => {
  const rows = [row("a"), row("b")];
  const result = mergeUnregisteredThreads(rows, [
    { id: "c", title: "新しいワークスペースのスレ", status: "idle", updatedAt: 10 },
  ]);
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["a", "b", "c"],
  );
  assert.equal(result.rows[2]?.title, "新しいワークスペースのスレ");
  // idle は「実装中」でなく「待機中」(動いていないスレを動いて見せない。出口レビュー round1 指摘2)
  assert.equal(result.rows[2]?.status, "待機中");
  assert.equal(result.rows[2]?.machineState, "idle");
  assert.equal(result.rows[2]?.pinned, false);
  assert.equal(result.rows[2]?.coordinator, false);
  // 開けるかは呼び出し元が付ける(ここでは未判定)。
  assert.equal(result.rows[2]?.access, null);
  assert.equal(result.skipped.listed, 0);
});

test("登録簿に載っているスレは二重にしない", () => {
  const rows = [row("a")];
  const result = mergeUnregisteredThreads(rows, [{ id: "a", title: "登録済み a", updatedAt: 10 }]);
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["a"],
  );
  assert.equal(result.skipped.listed, 1);
});

test("司令塔は行に足さない(coordinatorIds で除外)", () => {
  const rows = [row("child")];
  const result = mergeUnregisteredThreads(
    rows,
    [{ id: "coord", title: "司令塔", updatedAt: 5 }],
    ["coord"],
  );
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["child"],
  );
  assert.equal(result.skipped.coordinator, 1);
});

test("内部スレ・題名なし・アーカイブ済みは足さない", () => {
  const result = mergeUnregisteredThreads(
    [],
    [
      { id: "internal", title: "内部", internal: true },
      { id: "hidden", title: "隠す", hidden: true },
      { id: "untitled", title: "   " },
      { id: "archived", title: "終えた", archivedAt: 123 },
      { id: "ok", title: "残る" },
    ],
  );
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["ok"],
  );
  assert.equal(result.skipped.internal, 2);
  assert.equal(result.skipped.untitled, 1);
  assert.equal(result.skipped.archived, 1);
});

test("同じスレが一覧に2回出てきても1行だけ", () => {
  const result = mergeUnregisteredThreads(
    [],
    [
      { id: "dup", title: "1回目" },
      { id: "dup", title: "2回目" },
    ],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.title, "1回目");
  assert.equal(result.skipped.duplicate, 1);
});

test("状態文字は機械状態から導く(動いているものだけ実装中)", () => {
  const result = mergeUnregisteredThreads(
    [],
    [
      { id: "run", title: "実行中", status: "running" },
      { id: "init", title: "初期化中", status: "initializing" },
      { id: "idle", title: "待機", status: "idle" },
      { id: "closed", title: "終了", status: "closed" },
      { id: "none", title: "状態なし" },
      // 現在の lifecycle enum には無いが、上流が承認待ちを status に載せたときの受け皿
      { id: "approval", title: "承認待ち", status: "waiting_approval" },
    ],
  );
  const byId = new Map(result.rows.map((t) => [t.agentId, t]));
  assert.equal(byId.get("run")?.status, "実装中");
  assert.equal(byId.get("init")?.status, "実装中");
  // idle/closed/不明を「実装中」にすると、動いていないスレが動いて見える(出口レビュー round1 指摘2)
  assert.equal(byId.get("idle")?.status, "待機中");
  // closed は行に残すが「待機中」(帯は `displayStatus` が closed を「終了」にするので食い違うか
  // を見るテストは thread-status-label.test.ts 側)
  assert.equal(byId.get("closed")?.status, "待機中");
  assert.equal(byId.get("none")?.status, "待機中");
  assert.equal(byId.get("approval")?.status, "ユーザー判断待ち");
  // 機械状態そのものは行に残す(表示の色分けは `statusKindOfMachine` が同じ値を見る)
  assert.equal(byId.get("idle")?.machineState, "idle");
  assert.equal(byId.get("none")?.machineState, null);
});

test("ピン止めは保存値を反映する(メニューで付けたピンが次の取得で外れて見えない)", () => {
  const result = mergeUnregisteredThreads(
    [],
    [
      { id: "pinned", title: "ピン", updatedAt: 1 },
      { id: "plain", title: "普通", updatedAt: 2 },
    ],
    [],
    new Set(["pinned"]),
  );
  const byId = new Map(result.rows.map((t) => [t.agentId, t]));
  assert.equal(byId.get("pinned")?.pinned, true);
  assert.equal(byId.get("plain")?.pinned, false);
});

test("id の無い要素は無視する(壊れた要素で落ちない)", () => {
  const result = mergeUnregisteredThreads([], [{ title: "id 無し" }, { id: 42, title: "数値" }]);
  assert.equal(result.rows.length, 0);
});
