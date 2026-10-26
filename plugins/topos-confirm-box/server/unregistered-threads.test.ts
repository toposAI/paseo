import assert from "node:assert/strict";
import test from "node:test";
import { mergeUnregisteredThreads, timestampOf } from "./unregistered-threads.js";
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

// ---- 2026-10-27 通し検証BのOpus指摘(1・5) ----

test("指摘1: 親として見出しになっているスレは、未登録の行として足さない(二重表示の防止)", () => {
  const rows = [row("kid", { parentAgentId: "cc", parentTitle: "子司令塔" })];
  const result = mergeUnregisteredThreads(rows, [
    { id: "cc", title: "子司令塔", status: "running" },
  ]);
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["kid"],
  );
  assert.equal(result.skipped.parent, 1);
  assert.equal(result.skipped.listed, 0);
});

test("指摘5: 契約どおり文字列の updatedAt を受けて更新順に並べる(数値も受ける)", () => {
  const result = mergeUnregisteredThreads(
    [],
    [
      { id: "old", title: "古い", status: "idle", updatedAt: "2026-10-25T01:00:00.000Z" },
      { id: "new", title: "新しい", status: "idle", updatedAt: "2026-10-26T01:00:00.000Z" },
      { id: "mid", title: "中", status: "idle", updatedAt: "2026-10-25T13:00:00.000Z" },
    ],
  );
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["new", "mid", "old"],
  );
  assert.equal(result.rows[0]?.updatedAt, Date.parse("2026-10-26T01:00:00.000Z"));
});

test("指摘5: 壊れた文字列の updatedAt は0に落とし、落ちない", () => {
  const result = mergeUnregisteredThreads(
    [],
    [{ id: "bad", title: "壊れ", updatedAt: "not-a-date" }],
  );
  assert.equal(result.rows[0]?.updatedAt, 0);
});

test("指摘4: 登録簿で畳み済み(archived)のスレは、一覧に残っていても未登録の行として足さない", () => {
  // agent のアーカイブが失敗し、Paseo 側にだけ残っているもの。登録簿 archivable() が見失っている
  // その1本を `retryListedArchivedIds` で拾って渡す。
  const result = mergeUnregisteredThreads(
    [],
    [{ id: "left", title: "畳み済みだが残っている", status: "closed" }],
    [],
    new Set(),
    new Set(["left"]),
  );
  assert.deepEqual(result.rows, []);
  assert.equal(result.skipped.archivedRegistry, 1);
});

// ---- 2026-10-27 出口レビュー round1 R1-10 ----

test("R1-10: 秒単位の数値も ms に揃えて並べる(秒と ms が混ざっても逆転しない)", () => {
  const result = mergeUnregisteredThreads(
    [],
    [
      { id: "ms", title: "ms", updatedAt: Date.parse("2026-10-26T01:00:00.000Z") },
      { id: "sec", title: "秒", updatedAt: Date.parse("2026-10-26T02:00:00.000Z") / 1000 },
      { id: "old", title: "古い", updatedAt: 1 },
    ],
  );
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["sec", "ms", "old"],
  );
  assert.equal(result.rows[0]?.updatedAt, Date.parse("2026-10-26T02:00:00.000Z"));
});

test("R1-10: 0・負の数値は0(一覧の先頭へ来させない)", () => {
  assert.equal(timestampOf(0), 0);
  assert.equal(timestampOf(-5), 0);
});

// ---- 2026-10-27 出口レビュー round2 R2-5 ----

test("R2-5: ピン止めした親は行として1回だけ出て、未登録として足し直されない", () => {
  // サーバー(child-threads.ts)はピン止めした親を行として返す。子も上段に居る状態。
  const rows = [
    row("pk", { pinned: true }),
    row("kid", { parentAgentId: "pk", parentTitle: "登録済み pk" }),
  ];
  const result = mergeUnregisteredThreads(
    rows,
    [
      { id: "pk", title: "登録済み pk", status: "idle", updatedAt: 10 },
      { id: "kid", title: "登録済み kid", status: "idle", updatedAt: 9 },
    ],
    [],
    new Set(["pk"]),
  );
  assert.deepEqual(
    result.rows.map((t) => t.agentId),
    ["pk", "kid"],
  );
  assert.equal(result.skipped.listed, 2);
  assert.equal(result.skipped.parent, 0);
});
