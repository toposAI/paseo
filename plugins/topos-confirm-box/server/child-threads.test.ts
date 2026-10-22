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
  readChildThreads,
  writeChildThreadOrder,
} from "./child-threads.js";

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
    ["c1", "a2", "a1", "x1"],
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

test("events ファイルが無ければ誰も確認済みにならない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.writeFileSync(
    path.join(dir, "child_threads.json"),
    JSON.stringify({ threads: [row({ agent_id: "a1", status: "完了", summary_item_id: "bx" })] }),
  );
  const [t] = readChildThreads(dir, [{ id: "bx", background: "s", state: "new" as const }]);
  assert.equal(t.summaryAcked, false);
});
