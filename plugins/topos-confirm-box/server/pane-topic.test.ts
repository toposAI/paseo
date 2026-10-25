/** 方式a(この話題だけ): ペイン発の質問・say待ち・Enter送信の純関数テスト。 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isHubTarget,
  pendingLabel,
  shouldSubmitOnEnter,
  withSayInstruction,
} from "../shared/card-pane.js";
import { askFromPane, panePending, readCardChat } from "./cardchat.js";

function eventsFile(dir: string): string {
  const d = new Date();
  return path.join(dir, `events-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`);
}

function addReply(dir: string, re: string, by: string, ts: number, text: string): void {
  fs.appendFileSync(
    eventsFile(dir),
    `${JSON.stringify({ t: "reply", id: "i1", key: null, ts, re, by, text })}\n`,
  );
}

test("ハブ宛の判定(振り替え or hubIds に含まれる)", () => {
  assert.equal(isHubTarget({ fallback: true, agentId: null, hubIds: [] }), true);
  assert.equal(isHubTarget({ fallback: false, agentId: "a", hubIds: ["a", "b"] }), true);
  assert.equal(isHubTarget({ fallback: false, agentId: "c", hubIds: ["a"] }), false);
  assert.equal(isHubTarget({ fallback: false, agentId: null, hubIds: ["a"] }), false);
});

test("返信IDと say コマンドが完成形で付く(クォート込み)", () => {
  const out = withSayInstruction("質問です", { replyId: "cbui-i1-100", cardId: "i'1" });
  assert.match(out, /^質問です\n\n/);
  assert.match(out, /--id 'i'"'"'1' --re 'cbui-i1-100' --by hub_thread --text-file - <<'REPLY'/);
});

test("返事待ちの目印", () => {
  assert.equal(pendingLabel("waiting", 0), "返事待ち");
  assert.equal(pendingLabel("overdue", 0), "返事待ち(sayなし)");
  assert.equal(pendingLabel("overdue", 2), "返事待ち(sayなし・催促2回)");
});

test("Enter 送信: PC幅のWebだけ。IME変換中・Shift+Enter・iPhone は送らない", () => {
  const base = { key: "Enter", isWeb: true, compact: false } as const;
  assert.equal(shouldSubmitOnEnter(base), true);
  assert.equal(shouldSubmitOnEnter({ ...base, shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ ...base, isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ ...base, keyCode: 229 }), false);
  assert.equal(shouldSubmitOnEnter({ ...base, compact: true }), false);
  assert.equal(shouldSubmitOnEnter({ ...base, isWeb: false }), false);
  assert.equal(shouldSubmitOnEnter({ ...base, key: "a" }), false);
});

test("ペイン発の質問: ackなし。sayが付くまで pending、ackは話題表示に出ない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  const t0 = Date.now();
  const r = askFromPane(dir, { id: "i1" }, "どう思う?", "agent-hub-1", t0);
  assert.equal(r.ok, true);
  assert.ok(r.replyId);
  const re = r.replyId as string;
  assert.equal(panePending(dir, { id: "i1" }, t0 + 1000)[0]?.state, "waiting");
  assert.equal(panePending(dir, { id: "i1" }, t0 + 200_000)[0]?.state, "overdue");
  addReply(dir, re, "ack", t0 + 1, "受領");
  assert.equal(panePending(dir, { id: "i1" }, t0 + 2000).length, 1); // ackは回答に数えない
  assert.equal(readCardChat(dir, { id: "i1" }, { topic: true }).some((m) => m.by === "ack"), false);
  addReply(dir, re, "hub_thread", t0 + 5, "答え");
  assert.equal(panePending(dir, { id: "i1" }, t0 + 6000).length, 0);
  assert.equal(readCardChat(dir, { id: "i1" }, { topic: true }).at(-1)?.text, "答え");
});

test("askFromPane は空文字・宛先なしを拒否", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  assert.equal(askFromPane(dir, { id: "i1" }, "  ", "a").ok, false);
  assert.equal(askFromPane(dir, { id: "i1" }, "x", " ").ok, false);
});
