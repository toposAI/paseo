import assert from "node:assert/strict";
import { test } from "node:test";
import { displayStatus } from "../shared/thread-status-label.js";

test("displayStatus: 閉じたスレは status に関わらず「終了」", () => {
  assert.deepEqual(displayStatus("実装中", "closed"), { text: "終了", kind: "closed" });
  assert.deepEqual(displayStatus("ユーザー判断待ち", "closed"), { text: "終了", kind: "closed" });
});

test("displayStatus: 機械状態が生きているスレは自己申告を出す", () => {
  assert.deepEqual(displayStatus("実装中", "idle"), { text: "実装中", kind: "running" });
  assert.deepEqual(displayStatus("ユーザー判断待ち", "running"), {
    text: "判断待ち",
    kind: "waiting",
  });
  assert.deepEqual(displayStatus("完了", "idle"), { text: "完了", kind: "done" });
});

test("displayStatus: 取得失敗時は古い表示であることを添える", () => {
  assert.deepEqual(displayStatus("実装中", null, true), {
    text: "実装中(古い表示)",
    kind: "running",
  });
  assert.deepEqual(displayStatus("完了", "idle", true), {
    text: "完了(古い表示)",
    kind: "done",
  });
});
