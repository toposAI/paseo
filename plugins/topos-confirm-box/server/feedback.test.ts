import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FEEDBACK_TEXT_MAX } from "../shared/feedback.js";
import { normalizeReport, readFeedbackReports } from "./feedback.js";

const labels = new Map([["wife", "よめ"]]);

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fb-20261021-232728-83d2ed",
    kind: "bug",
    title: "アプリが落ちる",
    text: "質問中に落ちる",
    status: "new",
    urgent: false,
    created_at: "2026-10-21T23:27:28Z",
    reporter: "wife",
    screen: "スマホ画面",
    app_version: "0.1.4",
    reply: null,
    reply_seen: false,
    screenshot: "fb-20261021-232728-83d2ed.png",
    ...over,
  };
}

test("ID形式外は出さない(壊れたファイルを一覧に混ぜない)", () => {
  assert.equal(normalizeReport(report({ id: "../../etc/passwd" }), "家族", labels), null);
  assert.equal(normalizeReport(null, "家族", labels), null);
});

test("報告者名は上書き表で解決し、無ければ id のまま", () => {
  assert.equal(normalizeReport(report(), "家族", labels)?.reporter, "よめ");
  assert.equal(normalizeReport(report({ reporter: "yui" }), "家族", labels)?.reporter, "yui");
});

test("未知の kind は bug に寄せ、status はそのまま出す(勝手に言い換えない)", () => {
  const r = normalizeReport(report({ kind: "weird", status: "triage" }), "家族", labels);
  assert.equal(r?.kind, "bug");
  assert.equal(r?.status, "triage");
});

test("本文は上限で切る(巨大な報告で一覧が壊れない)", () => {
  const r = normalizeReport(report({ text: "あ".repeat(FEEDBACK_TEXT_MAX + 100) }), "家族", labels);
  assert.equal(r?.text.length, FEEDBACK_TEXT_MAX);
});

test("日時が読めない報告は ts=0 で並びの最後に落ちる", () => {
  const r = normalizeReport(report({ created_at: "not-a-date" }), "家族", labels);
  assert.equal(r?.ts, 0);
});

test("複数ディレクトリを読み、新しい順に返す。読めないディレクトリは sources に出す", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-fb-"));
  const a = path.join(root, "family", "_feedback");
  const b = path.join(root, "trial", "_feedback");
  fs.mkdirSync(path.join(a, "reports"), { recursive: true });
  fs.mkdirSync(path.join(b, "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(a, "reports", "fb-20261020-000000-aaaa.json"),
    JSON.stringify(report({ id: "fb-20261020-000000-aaaa", created_at: "2026-10-20T00:00:00Z" })),
  );
  fs.writeFileSync(
    path.join(b, "reports", "fb-20261021-000000-bbbb.json"),
    JSON.stringify(report({ id: "fb-20261021-000000-bbbb", created_at: "2026-10-21T00:00:00Z" })),
  );
  // 壊れた1件は飛ばす
  fs.writeFileSync(path.join(b, "reports", "fb-20261022-000000-cccc.json"), "{not json");

  const { reports, sources } = readFeedbackReports([a, b, path.join(root, "missing")], labels);
  assert.deepEqual(
    reports.map((r) => r.id),
    ["fb-20261021-000000-bbbb", "fb-20261020-000000-aaaa"],
  );
  assert.equal(reports[0].origin, "trial");
  assert.equal(sources.filter((s) => s.ok).length, 2);
  assert.equal(sources.filter((s) => !s.ok).length, 1);
});
