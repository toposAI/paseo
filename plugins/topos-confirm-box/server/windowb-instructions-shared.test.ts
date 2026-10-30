/**
 * 窓口Bの「指示の一覧」の表示の決まり。取れなかったときに前回の一覧を残すこと・並び・
 * 開く場所だけを見る(状態の判断は Python 側)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WindowBInstructionsOutput } from "../shared/contract.js";
import {
  WIDE_MIN_WIDTH,
  keepLastOnFailure,
  paneLocation,
  rowOrder,
  summarize,
} from "../shared/windowb-instructions.js";

function out(total: number, alerts = 0, warns = 0): WindowBInstructionsOutput {
  return {
    generatedAt: 0,
    ledgerUpdatedAt: 0,
    total,
    items: [],
    counts: {},
    alerts,
    warns,
    notices: [],
  };
}

test("失敗したら前回の一覧を残し、知らせだけ出す(空にしない)", () => {
  const prev = out(3);
  const failed = keepLastOnFailure(prev, { ok: false, error: "timeout" });
  assert.equal(failed.data, prev);
  assert.equal(failed.error, "timeout");
  // 一度も取れていなければ null(= 空ではなく「取れない」)
  assert.deepEqual(keepLastOnFailure(null, { ok: false, error: "x" }), { data: null, error: "x" });
  // 成功したら差し替えて知らせを消す
  const next = out(4);
  assert.deepEqual(keepLastOnFailure(prev, { ok: true, data: next }), { data: next, error: null });
});

test("要約は件数と赤・未登録だけを短く出す", () => {
  assert.equal(summarize(null), "読み込めていません");
  assert.equal(summarize(out(2)), "2件");
  assert.equal(summarize(out(5, 2, 1)), "5件 / 赤 2 / 未登録 1");
});

test("並びは 赤 → 判断待ち → 未登録 → その他 → 完了。同じ群は元の順", () => {
  const rows = [
    { key: "done", alert: null, warn: null, kind: "完了" },
    { key: "working", alert: null, warn: null, kind: "作業中" },
    { key: "x", alert: "no_reply", warn: null, kind: "作業中" },
    { key: "wait", alert: null, warn: null, kind: "判断待ち(確認箱)" },
    { key: "y", alert: "unassigned", warn: null, kind: "受付済み" },
    { key: "unl", alert: null, warn: "unledgered", kind: "未登録" },
    { key: "working2", alert: null, warn: null, kind: "作業中" },
  ];
  assert.deepEqual(
    rowOrder(rows).map((r) => r.key),
    ["x", "y", "wait", "unl", "working", "working2", "done"],
  );
});

test("PC幅は右カラム、狭い画面は主ペイン(全画面)", () => {
  assert.equal(paneLocation(WIDE_MIN_WIDTH), "right");
  assert.equal(paneLocation(1440), "right");
  assert.equal(paneLocation(WIDE_MIN_WIDTH - 1), "workspace");
  // iPhone の幅
  assert.equal(paneLocation(390), "workspace");
});
