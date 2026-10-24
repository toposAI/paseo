import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRevertArgs, summarizeRevert } from "./child-revert.js";

test("buildRevertArgs: CLI は revert <id> --instruction <文> で、指示は上限で切る", () => {
  const args = buildRevertArgs("/x/child_thread_registry.py", "abc", "直して");
  assert.deepEqual(args, [
    "/x/child_thread_registry.py",
    "revert",
    "--instruction=直して",
    "--",
    "abc",
  ]);
  const long = buildRevertArgs("/x/r.py", "abc", "あ".repeat(5000));
  assert.equal(long[2].length, "--instruction=".length + 2000);
  assert.deepEqual(buildRevertArgs("/x/r.py", "abc", "--force")[2], "--instruction=--force");
});

test("summarizeRevert: 全部戻って届いた", () => {
  const out = JSON.stringify([
    {
      result: "reverted",
      delivery: "delivered",
      verified: { registry: true, box: true, note: true },
    },
  ]);
  const r = summarizeRevert(out);
  assert.equal(r.ok, true);
  assert.match(r.message, /差し戻しました/);
  assert.match(r.message, /ログに載りました/);
});

test("summarizeRevert: ログ空は未確認と書き、届いたとは言わない", () => {
  const r = summarizeRevert(
    JSON.stringify({
      result: "reverted",
      delivery: "unverified",
      verified: { registry: true, box: true, note: true },
    }),
  );
  assert.equal(r.ok, true);
  assert.match(r.message, /未確認/);
  assert.doesNotMatch(r.message, /ログに載りました/);
});

test("summarizeRevert: 送信失敗・読み返し不一致は理由を出す", () => {
  const r = summarizeRevert(
    JSON.stringify({
      result: "reverted",
      delivery: "send-failed",
      verified: { registry: true, box: false, note: true },
    }),
  );
  assert.match(r.message, /送信に失敗/);
  assert.match(r.message, /確認箱/);
});

test("summarizeRevert: 作業中で送っていない", () => {
  const r = summarizeRevert(
    JSON.stringify({
      result: "reverted",
      delivery: "held-busy",
      verified: { registry: true, box: true, note: true },
    }),
  );
  assert.match(r.message, /送っていません/);
});

test("summarizeRevert: 対象外と壊れた出力", () => {
  assert.equal(summarizeRevert(JSON.stringify({ result: "not-applicable" })).ok, false);
  assert.match(summarizeRevert(JSON.stringify({ result: "not-applicable" })).message, /対象外/);
  assert.equal(summarizeRevert("not json").ok, false);
});
