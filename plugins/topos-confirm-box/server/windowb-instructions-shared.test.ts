/**
 * 窓口Bの「指示の一覧」の表示の決まり。取れなかったときに前回の一覧を残すこと・並び・
 * 開く場所だけを見る(状態の判断は Python 側)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WindowBInstructionsOutput } from "../shared/contract.js";
import {
  STALE_AFTER_MS,
  WIDE_MIN_WIDTH,
  doneButtonText,
  emptyText,
  filterByMode,
  freshnessText,
  keepLastOnFailure,
  paneLocation,
  rowOrder,
  staleNotice,
  summarize,
  truncationNote,
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

test("並びは 赤 → 判断待ち → 届いたか不明/返事なし → 橙 → その他 → 完了。同じ群は元の順", () => {
  const rows = [
    { key: "done", alert: null, warn: null, kind: "完了" },
    { key: "working", alert: null, warn: null, kind: "作業中" },
    { key: "x", alert: "no_reply", warn: null, kind: "作業中" },
    { key: "wait", alert: null, warn: null, kind: "判断待ち(確認箱)" },
    { key: "y", alert: "unassigned", warn: null, kind: "受付済み" },
    { key: "unl", alert: null, warn: "unledgered", kind: "未登録" },
    { key: "unknown", alert: null, warn: null, kind: "届いたか不明" },
    { key: "working2", alert: null, warn: null, kind: "作業中" },
  ];
  assert.deepEqual(
    rowOrder(rows).map((r) => r.key),
    ["x", "y", "wait", "unknown", "unl", "working", "working2", "done"],
  );
});

test("上限で切ったときは何件出しているかを言う(切ったと分からないと赤が無いと読み違える)", () => {
  assert.equal(truncationNote({ ...out(3), items: [{}, {}, {}] as never }), null);
  assert.equal(
    truncationNote({ ...out(60), items: Array.from({ length: 40 }, () => ({})) as never }),
    "表示は上位40件(全60件。赤と届いたか不明・返事なしは先に出しています)",
  );
});

test("いつ時点の一覧かを出す(台帳の更新時刻はミリ秒。0 は「更新時刻なし」)", () => {
  const t = new Date(2026, 9, 30, 10, 5).getTime();
  const data = { ...out(1), generatedAt: t, ledgerUpdatedAt: t - 60_000 };
  assert.equal(freshnessText(data), "読み出し 10:05 / 台帳 10:04");
  assert.equal(
    freshnessText({ ...data, ledgerUpdatedAt: 0 }),
    "読み出し 10:05 / 台帳の更新時刻なし",
  );
});

test("PC幅は右カラム、狭い画面は主ペイン(全画面)", () => {
  assert.equal(paneLocation(WIDE_MIN_WIDTH), "right");
  assert.equal(paneLocation(1440), "right");
  assert.equal(paneLocation(WIDE_MIN_WIDTH - 1), "workspace");
  // iPhone の幅
  assert.equal(paneLocation(390), "workspace");
});

test("15分以上前の読み出しは「古い表示(時刻)」として目立たせる", () => {
  const t = new Date(2026, 9, 30, 9, 41).getTime();
  const data = { ...out(1), generatedAt: t };
  // ちょうど15分は古い扱い(「より古い」ではなく「15分たったら」)
  assert.equal(staleNotice(data, t + STALE_AFTER_MS), "古い表示(09:41時点)");
  // 14分59秒はまだ新しい
  assert.equal(staleNotice(data, t + STALE_AFTER_MS - 1), null);
  // 読み出しが0(=一度も取れていない)は古い扱い
  assert.equal(staleNotice({ ...out(1), generatedAt: 0 }, t) !== null, true);
});

test("filterByMode: 既定は完了を隠し、done は完了だけ", () => {
  const rows = [{ kind: "作業中" }, { kind: "完了" }, { kind: "返事なし" }, { kind: "完了" }];
  assert.deepEqual(
    filterByMode(rows, "active").map((r) => r.kind),
    ["作業中", "返事なし"],
  );
  assert.deepEqual(
    filterByMode(rows, "done").map((r) => r.kind),
    ["完了", "完了"],
  );
  // 完了だけ の間も、判断待ち・赤・橙は隠さない
  const att = [
    { kind: "完了" },
    { kind: "判断待ち(確認箱)" },
    { kind: "作業中", alert: "no_reply" },
    { kind: "作業中", warn: "unposted" },
    { kind: "作業中" },
  ];
  assert.equal(filterByMode(att, "done").length, 4);
  assert.equal(doneButtonText("active", 3), "完了だけ(3)");
  assert.equal(doneButtonText("done", 3), "一覧にもどる");
  assert.notEqual(emptyText("active"), emptyText("done"));
});
