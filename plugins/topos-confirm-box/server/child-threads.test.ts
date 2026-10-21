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
