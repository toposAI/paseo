import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPaneActivity, paneActivityLabel } from "../shared/pane-activity.js";
import { clampPaneWidth, defaultPaneWidth, parseStoredPaneWidth } from "../shared/pane-width.js";

test("送信→考え中→圧縮中→完了→返信→idleで解除", () => {
  let s = nextPaneActivity(null, { kind: "sent" });
  assert.equal(s, "sent");
  s = nextPaneActivity(s, { kind: "agent-status", status: "running" });
  // 内部は「送信済み+実行中」。画面には従来どおり「送信済み」を出す。
  assert.equal(paneActivityLabel(s), "sent");
  s = nextPaneActivity(s, { kind: "item", itemType: "reasoning" });
  assert.equal(s, "thinking");
  s = nextPaneActivity(s, {
    kind: "item",
    itemType: "compaction",
    status: "loading",
  });
  assert.equal(s, "compacting");
  s = nextPaneActivity(s, {
    kind: "item",
    itemType: "compaction",
    status: "completed",
  });
  // 圧縮が終わったら「圧縮中」を解除する。まだ項目が無い間は印(running)でラベルは出さない。
  assert.equal(s, "running");
  assert.equal(paneActivityLabel(s), null);
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

// 2026-10-27 本番: 右カラムの本文が「ツールを実行中…」のまま9分止まり、リロード後は空だった。
// 原因は2つで、どちらもここで固定する:
// - 購読は接続直後に過去の書き込みを `tool_call` として届けるので、送信前でも「実行中」になる。
// - スレの状態(running/idle)を送った後に一度も見ていないので、`tool_call` を受けると手が止まっても戻らない。

test("(2) 送信前の古い書き込み(tool_call)では「実行中」を出さない", () => {
  const idle = nextPaneActivity(null, { kind: "agent-status", status: "idle" });
  assert.equal(idle, null);
  assert.equal(
    nextPaneActivity(idle, {
      kind: "item",
      itemType: "tool_call",
      status: "completed",
    }),
    null,
  );
  assert.equal(nextPaneActivity(idle, { kind: "item", itemType: "tool_call" }), null);
  assert.equal(nextPaneActivity(idle, { kind: "item", itemType: "reasoning" }), null);
});

test("(2) スレが実行中になってから開いた作業は「実行中」を出す", () => {
  const running = nextPaneActivity(null, {
    kind: "agent-status",
    status: "running",
  });
  assert.equal(nextPaneActivity(running, { kind: "item", itemType: "tool_call" }), "working");
  assert.equal(nextPaneActivity(running, { kind: "item", itemType: "reasoning" }), "thinking");
});

test("(2) 止まっているスレの過去の返信・圧縮では何も出さない(表示が止まらない)", () => {
  // 返信・圧縮も過去分の流し込みで届く。状態を見ずに進めると「返信中…」「考え中…」が残る(round1 F1)。
  assert.equal(nextPaneActivity(null, { kind: "item", itemType: "assistant_message" }), null);
  assert.equal(
    nextPaneActivity(null, { kind: "item", itemType: "compaction", status: "completed" }),
    null,
  );
  assert.equal(
    nextPaneActivity(null, { kind: "item", itemType: "compaction", status: "loading" }),
    null,
  );
});

test("(2) 圧縮の完了は「圧縮中」だけを解除する", () => {
  assert.equal(
    nextPaneActivity("working", { kind: "item", itemType: "compaction", status: "completed" }),
    "working",
  );
  assert.equal(
    nextPaneActivity("compacting", { kind: "item", itemType: "compaction", status: "completed" }),
    "running",
  );
});

test("(2) 実行中の再通知(running)で作業表示を消さない", () => {
  assert.equal(nextPaneActivity("working", { kind: "agent-status", status: "running" }), "working");
  assert.equal(nextPaneActivity("thinking", { kind: "agent-status", status: "running" }), "thinking");
});

test("(2) 実行中に始まった作業は、スレが止まったら「実行中」を消す", () => {
  const running = nextPaneActivity(null, {
    kind: "agent-status",
    status: "running",
  });
  const working = nextPaneActivity(running, {
    kind: "item",
    itemType: "tool_call",
  });
  assert.equal(working, "working");
  assert.equal(nextPaneActivity(working, { kind: "agent-status", status: "idle" }), null);
});

test("送信直後は、止まっていても「送信済み」を残す(反応待ちを嘘にしない)", () => {
  assert.equal(nextPaneActivity(null, { kind: "sent" }), "sent");
  assert.equal(nextPaneActivity("sent", { kind: "agent-status", status: "idle" }), "sent");
  assert.equal(
    nextPaneActivity("sent", { kind: "agent-status", status: "running" }),
    "sent-running",
  );
  assert.equal(nextPaneActivity("sent-running", { kind: "agent-status", status: "idle" }), "sent");
  assert.equal(
    nextPaneActivity("sent", {
      kind: "item",
      itemType: "tool_call",
      status: "completed",
    }),
    "sent",
  );
  const running = nextPaneActivity("sent", {
    kind: "agent-status",
    status: "running",
  });
  assert.equal(nextPaneActivity(running, { kind: "item", itemType: "tool_call" }), "working");
});
