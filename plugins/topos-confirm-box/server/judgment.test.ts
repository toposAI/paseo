/**
 * 判断タブの振り分けの回帰テスト。メール通知などの「決めることが無いお知らせ」が
 * 判断タブに混ざらないこと・各項目がちょうど1つのタブにだけ出ることを固定する。
 *
 * きっかけ: 2026-10-22、判断タブにウォッチドッグのメール通知が通知タブと二重に並んでいた
 * (判断タブは出所 `kind` で絞らず全項目を並べていた)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  countOpen,
  countUnreadNotifications,
  isJudgmentItem,
  isNotificationItem,
  judgmentTabRows,
  notificationTabRows,
} from "../shared/contract.js";
import type { ConfirmBoxItem } from "../shared/contract.js";

function item(over: Partial<ConfirmBoxItem> = {}): ConfirmBoxItem {
  return {
    id: "box:1",
    kind: "box",
    priority: "normal",
    subrank: 0,
    group: null,
    subject: "件名",
    summary: "本文",
    background: "",
    source: "unknown",
    threadRef: null,
    stoppedCount: 0,
    options: [],
    recommended: null,
    state: "new",
    urgency: "normal",
    key: null,
    agentId: null,
    workspaceId: null,
    ts: 1,
    ...over,
  };
}

const MAIL = item({
  id: "box:mail",
  source: "mailtriage_deepseek_safety_net_watchdog",
  subject: "[mailtriage_deepseek_safety_net_watchdog] 110番 無人経路で止まったジョブ",
});

test("メール通知(選択肢なし)は判断タブに入らず、通知タブだけに入る", () => {
  assert.equal(isJudgmentItem(MAIL), false);
  assert.equal(isNotificationItem(MAIL), true);
});

test("選択肢のある箱の項目は判断タブだけに入る(通知タブに入らない)", () => {
  const decision = item({
    id: "box:decision",
    source: "総司令",
    options: [
      { id: "a", label: "やる" },
      { id: "b", label: "やらない" },
    ],
  });
  assert.equal(isJudgmentItem(decision), true);
  assert.equal(isNotificationItem(decision), false);
});

test("中間形式(pending)も選択肢の有無で同じ規則", () => {
  const pendingDecision = item({
    id: "pending:x",
    kind: "pending",
    key: "x",
    options: [{ id: "a", label: "A" }],
  });
  const pendingInfo = item({
    id: "pending:info-x",
    kind: "pending",
    key: "info-x",
    priority: "info",
  });
  assert.equal(isJudgmentItem(pendingDecision), true);
  assert.equal(isJudgmentItem(pendingInfo), false);
  assert.equal(isNotificationItem(pendingInfo), true);
});

test("permit(承認待ち)は選択肢が無くても判断", () => {
  const permit = item({ id: "permit:a:p", kind: "permit", agentId: "a" });
  assert.equal(isJudgmentItem(permit), true);
  assert.equal(isNotificationItem(permit), false);
});

test("バグ報告・子スレ完了まとめは専用タブのみ(判断タブにも通知タブにも出さない)", () => {
  for (const source of ["topos_feedback", "child_thread_report"]) {
    const row = item({ id: `box:${source}`, source });
    assert.equal(isJudgmentItem(row), false);
    assert.equal(isNotificationItem(row), false);
  }
});

test("各項目は判断タブか通知タブのどちらか片方にだけ出る(二重表示しない)", () => {
  const rows = [
    MAIL,
    item({ id: "box:decision", options: [{ id: "a", label: "A" }] }),
    item({ id: "permit:a:p", kind: "permit" }),
  ];
  for (const row of rows) {
    assert.notEqual(isJudgmentItem(row), isNotificationItem(row));
  }
});

test("要対応件数(判断タブのバッジ)は通知を数えず、承認済みも数えない", () => {
  const rows = [
    MAIL,
    item({ id: "box:decision", options: [{ id: "a", label: "A" }] }),
    item({ id: "box:done", options: [{ id: "a", label: "A" }], state: "approved" }),
    item({ id: "permit:a:p", kind: "permit" }),
    item({ id: "box:notify-read", source: "x", state: "read" }),
  ];
  assert.equal(countOpen(rows), 2);
});

test("通知タブのバッジは未読の通知だけ数える", () => {
  const rows = [
    MAIL,
    item({ id: "box:mail-read", source: "mailtriage_deepseek_safety_net_watchdog", state: "read" }),
  ];
  assert.equal(countUnreadNotifications(rows), 1);
});

test("判断タブの行(画面と共通の絞り込み)に通知・バグ報告・完了報告は入らない", () => {
  const decision = item({
    id: "box:decision",
    options: [
      { id: "a", label: "やる" },
      { id: "b", label: "やらない" },
    ],
  });
  const rows = judgmentTabRows(
    [
      MAIL,
      decision,
      item({ id: "permit:a:p", kind: "permit" }),
      item({ id: "box:topos_feedback", source: "topos_feedback" }),
      item({ id: "box:child_thread_report", source: "child_thread_report" }),
    ],
    { showDone: true, prio: null, newestFirst: false },
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["box:decision", "permit:a:p"],
  );
});

test("判断タブの行は「決定済みも表示」と優先度の絞り込みにだけ従う(通知は絞り込みを外しても出ない)", () => {
  const rows = [
    MAIL,
    item({ id: "box:done", options: [{ id: "a", label: "A" }], state: "approved" }),
    item({ id: "box:blocking", priority: "blocking", options: [{ id: "a", label: "A" }] }),
  ];
  const ids = (o: Parameters<typeof judgmentTabRows>[1]) =>
    judgmentTabRows(rows, o).map((r) => r.id);
  assert.deepEqual(ids({ showDone: false, prio: null, newestFirst: true }), ["box:blocking"]);
  assert.deepEqual(ids({ showDone: true, prio: null, newestFirst: false }), [
    "box:done",
    "box:blocking",
  ]);
  assert.deepEqual(ids({ showDone: true, prio: "normal", newestFirst: false }), ["box:done"]);
});

test("通知タブは緊急を先に、同順位は新しい順(判断タブから外した緊急通知を埋もれさせない)", () => {
  const rows = notificationTabRows(
    [
      item({ id: "box:new-normal", urgency: "normal", ts: 30 }),
      item({ id: "box:urgent-old", urgency: "urgent", ts: 10 }),
      item({ id: "box:old-normal", urgency: "normal", ts: 5 }),
      item({ id: "box:urgent-new", urgency: "urgent", ts: 20 }),
      item({ id: "box:decision", options: [{ id: "a", label: "A" }], ts: 99 }),
    ],
    true,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["box:urgent-new", "box:urgent-old", "box:new-normal", "box:old-normal"],
  );
  assert.deepEqual(
    notificationTabRows(rows, false).map((r) => r.id),
    ["box:urgent-new", "box:urgent-old", "box:new-normal", "box:old-normal"],
  );
});

test("画面側は自前の絞り込みを書かず、共通の judgmentTabRows を使う", () => {
  const view = readFileSync(new URL("../client/ConfirmBoxView.tsx", import.meta.url), "utf8");
  assert.match(view, /judgmentTabRows\(/);
  assert.doesNotMatch(view, /isJudgmentItem\(/);
});
