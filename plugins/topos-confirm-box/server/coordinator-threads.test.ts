import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  adoptOrphans,
  coordinatorRows,
  dropDeadCoordinators,
  markCoordinators,
  markOpenableParents,
  readCoordinatorIds,
  readGeneralCoordinatorId,
} from "./coordinator-threads.js";
import type { ChildThread } from "../shared/child-threads.js";

function thread(overrides: Partial<ChildThread>): ChildThread {
  return {
    agentId: "a",
    title: "t",
    status: "実装中",
    machineState: null,
    request: "",
    summaryItemId: null,
    nocard: false,
    summary: null,
    summaryState: null,
    summaryAcked: false,
    updatedAt: 0,
    parentAgentId: null,
    parentTitle: null,
    pinned: false,
    coordinator: false,
    parentOpenable: false,
    access: null,
    ...overrides,
  };
}

test("アーカイブ済みの司令塔の行は落とし、closed・生きている・一覧に居ない行は残す", () => {
  const rows = dropDeadCoordinators(
    [
      thread({ agentId: "live", coordinator: true }),
      thread({ agentId: "closed", coordinator: true }),
      thread({ agentId: "archived", coordinator: true }),
      thread({ agentId: "away", coordinator: true }),
      thread({ agentId: "kid" }),
    ],
    [
      { id: "live", status: "idle" },
      { id: "closed", status: "closed" },
      { id: "archived", status: "idle", archivedAt: "2026-10-23T00:00:00Z" },
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.agentId),
    ["live", "closed", "away", "kid"],
  );
});

test("司令塔の一覧は領域ごとに読み、cid の無い/壊れた領域は飛ばす", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-"));
  const id = "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49";
  fs.mkdirSync(path.join(dir, "domains", "general"), { recursive: true });
  fs.writeFileSync(path.join(dir, "domains", "general", "coordinator_id"), `${id}\n`);
  fs.mkdirSync(path.join(dir, "domains", "empty"), { recursive: true });
  fs.mkdirSync(path.join(dir, "domains", "bad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "domains", "bad", "coordinator_id"), "../../etc/passwd");
  assert.deepEqual(readCoordinatorIds(dir), [id]);
});

test("総司令塔(general)のIDだけを返す。無い・不正は null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-"));
  assert.equal(readGeneralCoordinatorId(dir), null);
  fs.mkdirSync(path.join(dir, "domains", "f80"), { recursive: true });
  fs.writeFileSync(path.join(dir, "domains", "f80", "coordinator_id"), "afe8d176-d92c-4cb2-933b");
  assert.equal(readGeneralCoordinatorId(dir), null);
  fs.mkdirSync(path.join(dir, "domains", "general"), { recursive: true });
  fs.writeFileSync(path.join(dir, "domains", "general", "coordinator_id"), "../../etc/passwd");
  assert.equal(readGeneralCoordinatorId(dir), null);
  fs.writeFileSync(path.join(dir, "domains", "general", "coordinator_id"), "1800e2f7-63a5-40b7\n");
  assert.equal(readGeneralCoordinatorId(dir), "1800e2f7-63a5-40b7");
});

test("状態ディレクトリが無くても空で返す(一覧を止めない)", () => {
  assert.deepEqual(readCoordinatorIds(path.join(os.tmpdir(), "no-such-dir-xyz")), []);
});

test("司令塔の行は一覧に居るものだけ・登録簿に既に居るものは除く", () => {
  const rows = coordinatorRows(
    ["c1", "c2", "c3"],
    [
      { id: "c1", title: "総司令塔", status: "idle" },
      { id: "c2", title: "Paseo UI", status: "running" },
    ],
    [thread({ agentId: "c2" })],
  );
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.title, r.machineState, r.coordinator]),
    [["c1", "総司令塔", "idle", true]],
  );
});

test("アーカイブ済みの司令塔は行にしない・closed(再起動で閉じただけ)は行に残す", () => {
  // round2 指摘7: 全ページの一覧が取れないと finalAgents がアーカイブ込みになるため、
  // 古い coordinator_id を指す終わったスレが司令塔として先頭に出ていた。
  const rows = coordinatorRows(
    ["dead", "arch", "live"],
    [
      { id: "dead", title: "終わった司令塔", status: "closed" },
      { id: "arch", title: "アーカイブ済み", status: "idle", archivedAt: "2026-10-01T00:00:00Z" },
      { id: "live", title: "生きている", status: "idle" },
    ],
    [],
  );
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.machineState]),
    [
      ["dead", "closed"],
      ["live", "idle"],
    ],
  );
});

test("登録簿に載っている司令塔にも印を付ける(その他へ落とさない)", () => {
  const rows = markCoordinators(
    [thread({ agentId: "c1" }), thread({ agentId: "kid", parentAgentId: "c1" })],
    ["c1"],
  );
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.coordinator]),
    [
      ["c1", true],
      ["kid", false],
    ],
  );
});

test("親なしの子スレは、司令塔が1本だけならその下に寄せる", () => {
  const rows = adoptOrphans([
    thread({ agentId: "c1", coordinator: true }),
    thread({ agentId: "kid", parentAgentId: null }),
    thread({ agentId: "kid2", parentAgentId: "c1" }),
  ]);
  assert.equal(rows[1].parentAgentId, "c1");
  assert.equal(rows[1].parentTitle, "t");
  assert.equal(rows[2].parentAgentId, "c1");
});

test("司令塔が複数/ゼロなら親なしの子スレを推測で付け替えない", () => {
  const two = adoptOrphans([
    thread({ agentId: "c1", coordinator: true }),
    thread({ agentId: "c2", coordinator: true }),
    thread({ agentId: "kid" }),
  ]);
  assert.equal(two[2].parentAgentId, null);
  const none = adoptOrphans([thread({ agentId: "kid" })]);
  assert.equal(none[0].parentAgentId, null);
});

test("子を持つ生きた親は開ける親にする(司令塔の印は付けない。行は増やさない)", () => {
  const rows = markOpenableParents(
    [
      thread({ agentId: "kid1", parentAgentId: "child-coord", parentTitle: "古い題名" }),
      thread({ agentId: "kid2", parentAgentId: "child-coord", parentTitle: "古い題名" }),
      thread({ agentId: "other", parentAgentId: null }),
    ],
    [{ id: "child-coord", title: "子司令塔", status: "idle" }],
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.parentOpenable, r.parentTitle, r.coordinator]),
    [
      ["kid1", true, "子司令塔", false],
      ["kid2", true, "子司令塔", false],
      ["other", false, null, false],
    ],
  );
});

test("アーカイブ済み/閉じた/一覧に居ない親は開閉だけ(印を立てない)", () => {
  const rows = markOpenableParents(
    [
      thread({ agentId: "a", parentAgentId: "archived", parentTitle: "閉じた親" }),
      thread({ agentId: "b", parentAgentId: "closed", parentTitle: "終わった親" }),
      thread({ agentId: "c", parentAgentId: "gone", parentTitle: "一覧に居ない親" }),
    ],
    [
      { id: "archived", status: "idle", archivedAt: "2026-10-23T00:00:00Z" },
      { id: "closed", status: "closed" },
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.parentOpenable),
    [false, false, false],
  );
  // 登録時の題名はそのまま(印が立たない行の見出しを消さない)
  assert.equal(rows[1].parentTitle, "終わった親");
});

test("デーモン登録の司令塔の行は従来どおり(開ける親の印は付けない)", () => {
  const rows = markOpenableParents(
    [thread({ agentId: "c1", coordinator: true }), thread({ agentId: "kid", parentAgentId: "c1" })],
    [{ id: "c1", title: "総司令塔", status: "idle" }],
  );
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.coordinator, r.parentOpenable]),
    [
      ["c1", true, false],
      ["kid", false, true],
    ],
  );
});

test("印が workspace-archived の親は開ける親にしない(印が直接来た場合の単体の挙動)", () => {
  // 本番の呼び出しは生存ワークスペースの id しか渡さないので、この印は実際には付かない
  // (thread-liveness.test.ts の「本番の形」テストが既知の残差として固定している)。
  const rows = markOpenableParents(
    [thread({ agentId: "kid", parentAgentId: "closed-ws", parentTitle: "閉じたWSの親" })],
    [{ id: "closed-ws", title: "閉じたWSの親", status: "idle" }],
    new Map([["closed-ws", "workspace-archived" as const]]),
  );
  assert.equal(rows[0].parentOpenable, false);
});

// ---- 2026-10-27 通し検証B 出口レビュー round1 R1-1 ----

test("R1-1: 子司令塔の見出しは自分の機械状態で出す(閉じたら終了・親の状態を写さない)", () => {
  const rows = markOpenableParents(
    [
      thread({ agentId: "cc", groupingParent: true, machineState: "running" }),
      thread({ agentId: "kid", parentAgentId: "cc", machineState: "running" }),
    ],
    [
      { id: "cc", title: "子司令塔", status: "closed" },
      { id: "kid", title: "子", status: "idle" },
    ],
  );
  const cc = rows.find((t) => t.agentId === "cc");
  assert.equal(cc?.machineState, "closed");
  // 状態(status)は登録簿の語彙のまま書き換えない(偽の「判断待ち」をチップに乗せない)
  assert.equal(cc?.status, "実装中");
});

test("R1-1: 親(司令塔)が閉じても、子の行の機械状態・状態は変えない(子ごとに別のスレ)", () => {
  const rows = markOpenableParents(
    [thread({ agentId: "kid", parentAgentId: "boss", machineState: "idle" })],
    [{ id: "boss", title: "司令塔", status: "closed" }],
  );
  assert.equal(rows[0]?.machineState, "idle");
  assert.equal(rows[0]?.status, "実装中");
});

test("R1-1: 完了の行は完了のまま(見出しの印で「判断待ち」に化けない)", () => {
  const rows = markOpenableParents(
    [thread({ agentId: "done", status: "完了", machineState: "closed" })],
    [{ id: "done", title: "完了した", status: "closed" }],
  );
  assert.equal(rows[0]?.status, "完了");
});
