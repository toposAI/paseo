import assert from "node:assert/strict";
import { test } from "node:test";
import { rowStatusText, rowStatusKind } from "./thread-status-label.js";

test("閉じたスレの「実装中」は「終了」(自分申告を機械状態が打ち消す)", () => {
  assert.deepEqual(rowStatusText("実装中", "closed"), { text: "終了", kind: "closed" });
  assert.equal(rowStatusKind("実装中", "closed"), "closed");
});

test("動いているスレの「実装中」はそのまま", () => {
  assert.deepEqual(rowStatusText("実装中", "running"), { text: "実装中", kind: "running" });
  assert.deepEqual(rowStatusText("実装中", null), { text: "実装中", kind: "running" });
});

test("判断待ちは機械状態が closed でも判断待ちのまま(見落とさない側)", () => {
  assert.deepEqual(rowStatusText("判断待ち", "closed"), { text: "判断待ち", kind: "waiting" });
  assert.deepEqual(rowStatusText("判断待ち", "idle"), { text: "判断待ち", kind: "waiting" });
});

test("ノート由来の他の語彙は従来どおり(確認待ちは done、待機中は idle)", () => {
  assert.deepEqual(rowStatusText("確認待ち", "running"), { text: "確認待ち", kind: "done" });
  assert.deepEqual(rowStatusText("待機中", "idle"), { text: "待機中", kind: "idle" });
  assert.deepEqual(rowStatusText("完了", "idle"), { text: "完了", kind: "done" });
});

// ---- 2026-10-27 出口レビュー round1 R1-7 ----

test("R1-7: 閉じたスレの「待機中」(未登録の closed 行)も「終了」", () => {
  const r = rowStatusText("待機中", "closed");
  assert.equal(r.text, "終了");
  assert.equal(r.kind, "closed");
  // 閉じていなければ「待機中」のまま
  assert.equal(rowStatusText("待機中", "idle").text, "待機中");
});
