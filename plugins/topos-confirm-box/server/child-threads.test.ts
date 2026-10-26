import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyChildThreadOrder,
  normalizeChildThreadOrder,
  normalizeChildThreads,
  readChildThreadOrder,
  readChildThreadPins,
  readChildThreads,
  readKnownChildThreadIds,
  writeChildThreadOrder,
  writeChildThreadPin,
} from "./child-threads.js";
import { isCardDone } from "../shared/child-threads.js";
import type { ChildThread } from "../shared/child-threads.js";
import { buildUpperRows, coordinatorIdSet, visibleGroupKeyOf } from "../shared/sidebar-rows.js";
import { COORDINATOR_GROUP } from "../shared/sidebar-section-mode.js";

const row = (o: Record<string, unknown>) => ({
  agent_id: "a",
  title: "t",
  status: "実装中",
  updated_at: 1,
  ...o,
});

test("壊れた入力は空配列", () => {
  assert.deepEqual(normalizeChildThreads(null), []);
  assert.deepEqual(normalizeChildThreads({ threads: "x" }), []);
  assert.deepEqual(normalizeChildThreads({ threads: [null, { title: "id無し" }] }), []);
});

test("未知のstatusは実装中、題名が無ければidの先頭", () => {
  const [t] = normalizeChildThreads({
    threads: [row({ agent_id: "abcdefghij", title: "", status: "???" })],
  });
  assert.equal(t.status, "実装中");
  assert.equal(t.title, "abcdefgh");
});

test("判断待ち→実装中→完了の順、アーカイブ済みは除く", () => {
  const list = normalizeChildThreads({
    threads: [
      row({ agent_id: "done", status: "完了" }),
      row({ agent_id: "work", status: "実装中", updated_at: 5 }),
      row({ agent_id: "wait", status: "ユーザー判断待ち" }),
      row({ agent_id: "old", status: "完了", archived: true }),
    ],
  });
  assert.deepEqual(
    list.map((t) => t.agentId),
    ["wait", "work", "done"],
  );
});

test("完了まとめは箱の項目から引く(summary_item_id 一致)", () => {
  const [t] = normalizeChildThreads({ threads: [row({ status: "完了", summary_item_id: "i1" })] }, [
    { id: "i1", background: "## 結論\nX", state: "read" },
  ]);
  assert.equal(t.summary, "## 結論\nX");
  assert.equal(t.summaryState, "read");
});

test("カードを作らない運用の目印(nocard:)は箱を引かず、完了の実カードとして扱わない", () => {
  // 目印は箱に実在しない id。summaryItemId に載せると、押しても効かない確認として出てしまう。
  const [t] = normalizeChildThreads(
    { threads: [row({ agent_id: "nc", status: "完了", summary_item_id: "nocard:abc" })] },
    [{ id: "nocard:abc", background: "箱に在るはずのない本文", state: "read" }],
  );
  assert.equal(t.summaryItemId, null);
  assert.equal(t.summary, null);
  assert.equal(t.summaryState, null);
  assert.equal(t.nocard, true);
  assert.equal(t.summaryAcked, false);
  assert.equal(isCardDone(t), false);
});

test("実カードの行は nocard=false のまま(表示・件数は従来どおり)", () => {
  const [t] = normalizeChildThreads({ threads: [row({ status: "完了", summary_item_id: "i1" })] }, [
    { id: "i1", background: "X", state: "read" },
  ]);
  assert.equal(t.nocard, false);
  assert.equal(t.summaryItemId, "i1");
  assert.equal(isCardDone(t), true);
});

test("目印の id が ack 済みに入っていても確認済みにしない・nocard 未指定はカードあり扱い", () => {
  // 目印は箱の項目ではないので、ack イベントに同じ文字列があっても「確認済み」にしない。
  const [t] = normalizeChildThreads(
    { threads: [row({ status: "完了", summary_item_id: "nocard:abc" })] },
    [],
    new Set(["nocard:abc"]),
  );
  assert.equal(t.summaryAcked, false);
  // 古い形(契約に nocard が無い)は「カードがある」として従来どおり扱う(後方互換)。
  assert.equal(isCardDone({ status: "完了" }), true);
  assert.equal(isCardDone({ status: "完了", nocard: true }), false);
  assert.equal(isCardDone({ status: "実装中" }), false);
});

test("常駐の窓口の status『待機』は行の『待機中』になり、完了として数えない", () => {
  // 登録簿(Python)は常駐の窓口を『待機』で書く。行の語彙へ寄せないと enum で落ちるか
  // 既定の『実装中』に化けて、動いていない窓口が動いて見える(2026-10-26)。
  const [t] = normalizeChildThreads({
    threads: [row({ agent_id: "waitwin", status: "待機", title: "判断窓口A'" })],
  });
  assert.equal(t.status, "待機中");
  assert.equal(isCardDone(t), false);
});

test("ファイルが無ければ空配列、あれば読む", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  assert.deepEqual(readChildThreads(dir), []);
  fs.writeFileSync(path.join(dir, "child_threads.json"), JSON.stringify({ threads: [row({})] }));
  assert.equal(readChildThreads(dir).length, 1);
});

test("保存順の正規化: 文字列だけ・trim・空/重複を除く", () => {
  assert.deepEqual(normalizeChildThreadOrder(["b", " a ", "", "b", 3, null]), ["b", "a"]);
  assert.deepEqual(normalizeChildThreadOrder(["a".repeat(300)]), ["a".repeat(200)]);
});

test("保存順を適用: 保存済みが先、保存に無いIDは既定順のまま後ろ", () => {
  const threads = ["wait", "work", "done"].map(
    (agent_id) => normalizeChildThreads({ threads: [row({ agent_id })] })[0],
  );
  assert.deepEqual(
    applyChildThreadOrder(threads, ["done", "wait"]).map((t) => t.agentId),
    ["done", "wait", "work"],
  );
  assert.deepEqual(
    applyChildThreadOrder(threads, []).map((t) => t.agentId),
    ["wait", "work", "done"],
  );
});

test("順序ファイルの往復(既存の child_threads.json は触らない)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-order-"));
  const registry = path.join(dir, "child_threads.json");
  const registryBody = JSON.stringify({ threads: [row({ agent_id: "a" })] });
  fs.writeFileSync(registry, registryBody);

  assert.deepEqual(readChildThreadOrder(dir), []);
  assert.deepEqual(writeChildThreadOrder(dir, ["c", "a", "c"]), ["c", "a"]);
  assert.deepEqual(readChildThreadOrder(dir), ["c", "a"]);
  assert.equal(fs.readFileSync(registry, "utf8"), registryBody);
});

test("壊れた順序ファイルは既定順(無視して落ちない)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-order-bad-"));
  fs.writeFileSync(path.join(dir, "child_threads_order.json"), "{not json");
  assert.deepEqual(readChildThreadOrder(dir), []);
  fs.writeFileSync(path.join(dir, "child_threads_order.json"), JSON.stringify({ order: "x" }));
  assert.deepEqual(readChildThreadOrder(dir), []);
});

test("一覧は順序ファイルに従う", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-order-list-"));
  fs.writeFileSync(
    path.join(dir, "child_threads.json"),
    JSON.stringify({
      threads: [
        row({ agent_id: "done", status: "完了", updated_at: 3 }),
        row({ agent_id: "wait", status: "ユーザー判断待ち", updated_at: 1 }),
        row({ agent_id: "work", status: "実装中", updated_at: 2 }),
      ],
    }),
  );
  assert.deepEqual(
    readChildThreads(dir).map((t) => t.agentId),
    ["wait", "work", "done"],
  );
  writeChildThreadOrder(dir, ["done", "wait", "work"]);
  assert.deepEqual(
    readChildThreads(dir).map((t) => t.agentId),
    ["done", "wait", "work"],
  );
});

test("親(子司令塔)ごとにまとめ、司令塔自身の行は出さず、親なしは最後", () => {
  const list = normalizeChildThreads({
    threads: [
      row({ agent_id: "boss", status: "実装中", updated_at: 9 }),
      row({
        agent_id: "a1",
        status: "完了",
        updated_at: 5,
        parent_agent_id: "boss",
        parent_title: "B",
      }),
      row({ agent_id: "x1", status: "実装中", updated_at: 1 }),
      row({
        agent_id: "c1",
        status: "ユーザー判断待ち",
        updated_at: 2,
        parent_agent_id: "other",
        parent_title: "C",
      }),
      row({
        agent_id: "a2",
        status: "実装中",
        updated_at: 8,
        parent_agent_id: "boss",
        parent_title: "B",
      }),
    ],
  });
  assert.deepEqual(
    list.map((t) => t.agentId),
    // 親(`boss`)は見出しとして残す(2026-10-27 通し検証B 指摘1)。行としては子の後ろ
    ["c1", "a2", "a1", "x1", "boss"],
  );
  assert.equal(list[0].parentTitle, "C");
});

test("確認済みは個別 ack のときだけ(すべて既読=ackall では真にならない)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.writeFileSync(
    path.join(dir, "child_threads.json"),
    JSON.stringify({
      threads: [
        row({ agent_id: "a1", status: "完了", summary_item_id: "bx-a1" }),
        row({ agent_id: "a2", status: "完了", summary_item_id: "bx-a2" }),
      ],
    }),
  );
  const items = [
    { id: "bx-a1", background: "s1", state: "approved" as const },
    { id: "bx-a2", background: "s2", state: "read" as const },
  ];
  // a1 は個別 ack、a2 は ackall だけ。ackall は今の書き手では書かないが、古い行が残っていても数えない。
  fs.writeFileSync(
    path.join(dir, "events-202610.jsonl"),
    [
      JSON.stringify({ t: "ack", id: "bx-a1", ts: 1, action: "approve" }),
      JSON.stringify({ t: "ackall", ts: 2, action: "read", before: 2 }),
    ].join("\n"),
  );
  const byId = new Map(readChildThreads(dir, items).map((t) => [t.agentId, t]));
  assert.equal(byId.get("a1")?.summaryAcked, true);
  assert.equal(byId.get("a2")?.summaryAcked, false);
  // 表示用の state は箱の値のまま(既読という事実は消さない)
  assert.equal(byId.get("a2")?.summaryState, "read");
});

test("完了まとめの個別 ack は箱の決定印(承認済み扱い)では立たない — 記録用に区別する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.writeFileSync(
    path.join(dir, "child_threads.json"),
    JSON.stringify({ threads: [row({ agent_id: "a1", status: "完了", summary_item_id: "bx" })] }),
  );
  // 別機能(自由記述の決定行)で key が決定済みになった項目は箱側で approved になるが、
  // 完了まとめの ack は個別の ack だけで立てる(2026-10-26: 表示の条件ではなく記録用)。
  const [t] = readChildThreads(dir, [{ id: "bx", background: "s", state: "approved" as const }]);
  assert.equal(t.summaryAcked, false);
});

test("events ファイルが無ければ誰も確認済みにならない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.writeFileSync(
    path.join(dir, "child_threads.json"),
    JSON.stringify({ threads: [row({ agent_id: "a1", status: "完了", summary_item_id: "bx" })] }),
  );
  const [t] = readChildThreads(dir, [{ id: "bx", background: "s", state: "new" as const }]);
  assert.equal(t.summaryAcked, false);
});

test("ピン止めは先頭に集め(出現順)、残りはグループ単位の出現順を保つ", () => {
  const raw = {
    threads: [
      row({ agent_id: "a1", parent_agent_id: "p1", updated_at: 30 }),
      row({ agent_id: "a2", parent_agent_id: "p1", updated_at: 20 }),
      row({ agent_id: "a3", parent_agent_id: "p1", updated_at: 10 }),
      row({ agent_id: "b1", parent_agent_id: "p2", updated_at: 5 }),
    ],
  };
  const ids = normalizeChildThreads(raw, [], new Set(), new Set(["a3", "b1"])).map(
    (t) => t.agentId,
  );
  // 並べ替え前(既定順)の出現順は a1,a2,a3,b1。ピン行はその出現順で先頭へ、非ピンは元の順のまま。
  assert.deepEqual(ids, ["a3", "b1", "a1", "a2"]);
});

// 統合(2026-10-25): 司令塔の行は呼び出し元(`index.server.ts`)が先頭に置き、手動順は最後に全体へ掛かる。
// 手動順で司令塔を末尾へ動かしても、再読み込み後は同じ並び(手動順)で戻ることを確かめる。
// 注意: この手順は司令塔を「司令塔グループ」の先頭には戻さない(司令塔の子は司令塔グループ、
// 司令塔本人は自分の題名のグループになるため)。グループ先頭への固定はしない(2026-10-25 司令塔の判断)。
test("司令塔の行が手動順の末尾にあっても、司令塔グループ内の並びは手動順どおり", () => {
  const raw = {
    threads: [
      row({ agent_id: "kid2", parent_agent_id: "chief", updated_at: 30 }),
      row({ agent_id: "kid1", parent_agent_id: "chief", updated_at: 20 }),
      row({ agent_id: "x1", parent_agent_id: null, updated_at: 10 }),
    ],
  };
  const chief: ChildThread = {
    agentId: "chief",
    title: "総司令",
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
    coordinator: true,
    parentOpenable: false,
    access: null,
  };
  // index.server.ts と同じ組み方: 司令塔を先頭に置いてから手動順を最後に適用する。
  const threads = applyChildThreadOrder(
    [chief, ...normalizeChildThreads(raw)],
    ["x1", "kid1", "kid2", "chief"],
  );
  const { coordinatorIds, rows } = upperRowsLikeClient(threads);
  const grouped = rows
    .filter(
      (r) => visibleGroupKeyOf(r.thread, coordinatorIds, COORDINATOR_GROUP) === COORDINATOR_GROUP,
    )
    .map((r) => r.thread.agentId);
  assert.deepEqual(grouped, ["kid1", "kid2", "chief"]);
});

/** 画面と同じ作り方: 全スレから司令塔の集合を作り、上段の行へ絞る(`buildUpperRows`)。 */
function upperRowsLikeClient(threads: ChildThread[]) {
  return {
    coordinatorIds: coordinatorIdSet(threads),
    rows: buildUpperRows(threads, new Map()),
  };
}

test("ピン止めの往復(切り替え・外す。壊れた/無いファイルは空)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-"));
  assert.deepEqual(readChildThreadPins(dir), []);
  assert.deepEqual(writeChildThreadPin(dir, "a1", true), ["a1"]);
  assert.deepEqual(writeChildThreadPin(dir, "a2", true), ["a1", "a2"]);
  // 何度押しても重複しない
  assert.deepEqual(writeChildThreadPin(dir, "a1", true), ["a1", "a2"]);
  assert.deepEqual(writeChildThreadPin(dir, "a1", false), ["a2"]);
  assert.deepEqual(readChildThreadPins(dir), ["a2"]);
  fs.writeFileSync(path.join(dir, "child_threads_pins.json"), "{broken");
  assert.deepEqual(readChildThreadPins(dir), []);
});

// ---- 2026-10-27 通し検証BのOpus指摘1 ----

test("親(子司令塔)は行として残し `groupingParent` を立てる(状態を落とさない)", () => {
  const list = normalizeChildThreads({
    threads: [
      row({ agent_id: "cc", status: "ユーザー判断待ち", updated_at: 9 }),
      row({
        agent_id: "k1",
        status: "実装中",
        updated_at: 5,
        parent_agent_id: "cc",
        parent_title: "子司令塔",
      }),
    ],
  });
  const byId = new Map(list.map((t) => [t.agentId, t]));
  assert.equal(byId.get("cc")?.groupingParent, true);
  assert.equal(byId.get("cc")?.status, "ユーザー判断待ち");
  // 子はフラグ無し
  assert.equal(byId.get("k1")?.groupingParent, false);
});

test("readKnownChildThreadIds は畳み済み・見出しの親も含めて登録簿の id を全部返す(2026-10-27 実測 12b4eab)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "known-ids-"));
  fs.writeFileSync(
    path.join(dir, "child_threads.json"),
    JSON.stringify({
      threads: [
        row({ agent_id: "done-parent", archived: true }),
        row({ agent_id: "live-child", archived: false }),
      ],
    }),
  );
  assert.deepEqual([...readKnownChildThreadIds(dir)].sort(), ["done-parent", "live-child"]);
  // 読めない/無い/壊れている → 空(取り込みを止めない側に倒さない)
  assert.deepEqual([...readKnownChildThreadIds(path.join(dir, "missing"))], []);
  fs.writeFileSync(path.join(dir, "child_threads.json"), "{broken");
  assert.deepEqual([...readKnownChildThreadIds(dir)], []);
});
