import assert from "node:assert/strict";
import test from "node:test";
import {
  countOpenReports,
  isReportComplete,
  type FeedbackReport,
  type FeedbackProgress,
} from "../shared/feedback.js";

function progress(over: Partial<FeedbackProgress> = {}): FeedbackProgress {
  return {
    stage: "investigating",
    detail: "",
    threadId: null,
    itemId: null,
    archived: false,
    ...over,
  };
}

function report(over: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: "fb-20261021-232728-83d2ed",
    kind: "bug",
    title: "検索が固まる",
    text: "検索ボタンで固まります",
    status: "new",
    urgent: false,
    createdAt: "2026-10-21T23:27:28Z",
    ts: 1,
    reporter: "よめ",
    screen: "スマホ画面",
    appVersion: "0.1.4",
    reply: null,
    replySeen: false,
    hasScreenshot: false,
    origin: "家族",
    ...over,
  };
}

test("完了の判定は progress(台帳由来)を正とし、無い古い応答だけ status で代用する", () => {
  assert.equal(isReportComplete(report({ status: "new", progress: progress() })), false);
  assert.equal(
    isReportComplete(report({ status: "done", progress: progress({ archived: true }) })),
    true,
  );
  // progress が無い(古いサーバー)
  assert.equal(isReportComplete(report({ status: "done" })), true);
  assert.equal(isReportComplete(report({ status: "rejected" })), true);
  assert.equal(isReportComplete(report({ status: "will_do" })), false);
  // progress があるときは status より progress を信じる
  assert.equal(
    isReportComplete(report({ status: "done", progress: progress({ archived: false }) })),
    false,
  );
});

test("バッジ=まだ終わっていない報告の数(未対応だけでなく調査中・判断待ち・反映中も数える)", () => {
  const rows = [
    report({ status: "new" }),
    report({ status: "will_do", progress: progress({ stage: "investigating" }) }),
    report({ progress: progress({ stage: "awaiting_decision" }) }),
    report({ progress: progress({ stage: "applying" }) }),
    report({ status: "done", progress: progress({ stage: "done", archived: true }) }),
    report({ status: "rejected", progress: progress({ stage: "done", archived: true }) }),
  ];
  assert.equal(countOpenReports(rows), 4);
  assert.equal(countOpenReports([]), 0);
});

test("完了した報告は、返信が未読でも数えない(バッジは管理者の仕事が残っている数)", () => {
  const done = report({
    status: "done",
    progress: progress({ stage: "done", archived: true }),
    reply: "直しました。",
    replySeen: false,
  });
  assert.equal(countOpenReports([done]), 0);
  assert.equal(countOpenReports([{ ...done, replySeen: true }]), 0);
});

test("返信が無い完了報告は数えない", () => {
  assert.equal(
    countOpenReports([report({ status: "done", progress: progress({ archived: true }) })]),
    0,
  );
});
