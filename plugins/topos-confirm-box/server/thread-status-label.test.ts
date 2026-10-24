import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displayStatus,
  statusKindOfMachine,
  statusTextOfMachine,
} from "../shared/thread-status-label.js";

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

test("機械状態から導く語彙: 動いていない状態を実行中に見せない", () => {
  assert.deepEqual(
    ["running", "initializing"].map((s) => statusTextOfMachine(s)),
    ["実装中", "実装中"],
  );
  assert.equal(statusTextOfMachine("closed"), "終了");
  // idle・error・未知・null は「待機中」(帯の色も idle)
  for (const s of ["idle", "error", "", null]) {
    assert.equal(statusKindOfMachine(s), "idle");
    assert.equal(statusTextOfMachine(s), "待機中");
  }
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
