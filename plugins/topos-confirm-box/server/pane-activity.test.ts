import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPaneActivity } from "../shared/pane-activity.js";
import { clampPaneWidth, defaultPaneWidth, parseStoredPaneWidth } from "../shared/pane-width.js";

test("送信→考え中→圧縮中→完了→返信→idleで解除", () => {
  let s = nextPaneActivity(null, { kind: "sent" });
  assert.equal(s, "sent");
  s = nextPaneActivity(s, { kind: "agent-status", status: "running" });
  assert.equal(s, "sent");
  s = nextPaneActivity(s, { kind: "item", itemType: "reasoning" });
  assert.equal(s, "thinking");
  s = nextPaneActivity(s, { kind: "item", itemType: "compaction", status: "loading" });
  assert.equal(s, "compacting");
  s = nextPaneActivity(s, { kind: "item", itemType: "compaction", status: "completed" });
  assert.equal(s, "thinking");
  s = nextPaneActivity(s, { kind: "item", itemType: "assistant_message" });
  assert.equal(s, "replying");
  assert.equal(nextPaneActivity(s, { kind: "agent-status", status: "idle" }), null);
});

test("未知の項目は状態を変えない", () => {
  assert.equal(nextPaneActivity("thinking", { kind: "item", itemType: "todo" }), "thinking");
});

test("幅の範囲と保存値", () => {
  assert.equal(clampPaneWidth(100, 1500), 280);
  assert.equal(clampPaneWidth(5000, 1500), 1050);
  assert.equal(clampPaneWidth(Number.NaN, 1000), defaultPaneWidth(1000));
  assert.equal(parseStoredPaneWidth("abc"), null);
  assert.equal(parseStoredPaneWidth("400"), 400);
});
