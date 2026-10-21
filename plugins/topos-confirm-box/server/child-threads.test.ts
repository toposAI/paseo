import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeChildThreads, readChildThreads } from "./child-threads.ts";

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
  const [t] = normalizeChildThreads(
    { threads: [row({ status: "完了", summary_item_id: "i1" })] },
    [{ id: "i1", background: "## 結論\nX", state: "read" }],
  );
  assert.equal(t.summary, "## 結論\nX");
  assert.equal(t.summaryState, "read");
});

test("ファイルが無ければ空配列、あれば読む", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  assert.deepEqual(readChildThreads(dir), []);
  fs.writeFileSync(path.join(dir, "child_threads.json"), JSON.stringify({ threads: [row({})] }));
  assert.equal(readChildThreads(dir).length, 1);
});
