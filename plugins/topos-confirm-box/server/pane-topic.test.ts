/** 方式a(この話題だけ): ペイン発の質問・say待ち・Enter送信の純関数テスト。 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  IMAGE_COMMENT_TAG,
  imageCommentText,
  isHubTarget,
  isImageComment,
  pendingLabel,
  shouldSubmitOnEnter,
  withNoReplyInstruction,
  withSayInstruction,
} from "../shared/card-pane.js";
import { askFromPane, cancelFromPane, panePending, readCardChat } from "./cardchat.js";

function eventsFile(dir: string): string {
  const d = new Date();
  return path.join(
    dir,
    `events-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`,
  );
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
  assert.match(
    out,
    /--id 'i'"'"'1' --re 'cbui-i1-100' --by hub_thread --text-file - <<'(REPLY_[0-9a-f]{16})'\n\(返事\)\n\1$/,
  );
  assert.notEqual(
    withSayInstruction("a", { replyId: "r", cardId: "c" }),
    withSayInstruction("a", { replyId: "r", cardId: "c" }),
  );
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
  assert.equal(
    readCardChat(dir, { id: "i1" }, { topic: true }).some((m) => m.by === "ack"),
    false,
  );
  addReply(dir, re, "hub_thread", t0 + 5, "答え");
  assert.equal(panePending(dir, { id: "i1" }, t0 + 6000).length, 0);
  assert.equal(readCardChat(dir, { id: "i1" }, { topic: true }).at(-1)?.text, "答え");
});

test("返信IDは200字以内(長いカードIDでも)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  const r = askFromPane(dir, { id: "x".repeat(300) }, "q", "a", 1_700_000_000_000);
  assert.ok((r.replyId ?? "").length <= 200);
  assert.ok((r.replyId ?? "").endsWith("-1700000000000"));
});

test("取り消した質問は待ちに出ない・7日超は出ない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  const t0 = Date.now();
  const r = askFromPane(dir, { id: "i1" }, "q", "a", t0);
  assert.equal(panePending(dir, { id: "i1" }, t0 + 1).length, 1);
  assert.equal(panePending(dir, { id: "i1" }, t0 + 8 * 24 * 3600 * 1000).length, 0);
  assert.equal(cancelFromPane(dir, { id: "i1" }, r.replyId as string), true);
  assert.equal(panePending(dir, { id: "i1" }, t0 + 1).length, 0);
});

test("askFromPane は空文字・宛先なしを拒否", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  assert.equal(askFromPane(dir, { id: "i1" }, "  ", "a").ok, false);
  assert.equal(askFromPane(dir, { id: "i1" }, "x", " ").ok, false);
});

test("画像への直接コメント: 返事待ちに出ず、転送文には返事不要とだけ書く(2026-11-06)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  const t0 = Date.now();
  // ペインは「【直してほしい】」を前置きしてから台帳へ書く(実際の送信と同じ形)。
  const text = `【直してほしい】${IMAGE_COMMENT_TAG}【完成版へのコメント】ここを直して`;
  assert.equal(isImageComment(text), true);
  assert.equal(isImageComment("【直してほしい】普通の指摘"), false);
  // 画像名が長い・記号を含む場合でも、固定の目印で見分けるので取りこぼさない。
  assert.equal(isImageComment(`${IMAGE_COMMENT_TAG}【${"あ".repeat(100)}へのコメント】x`), true);
  // 文の組み立ても1か所(画面ごとにぶれない)。前後の空白は落とし、先頭に固定の目印を置く。
  assert.equal(
    imageCommentText("完成版", " ここを直して "),
    `${IMAGE_COMMENT_TAG}【完成版へのコメント】ここを直して`,
  );
  assert.equal(isImageComment(imageCommentText("完成版", "ここを直して")), true);
  askFromPane(dir, { id: "i1" }, text, "a", t0);
  // 催促の元・返事待ちの目印にしない(3分超でも overdue にならない)。
  assert.equal(panePending(dir, { id: "i1" }, t0 + 200_000).length, 0);
  const out = withNoReplyInstruction("本文");
  assert.match(out, /^本文\n\n【返事不要】/);
  assert.doesNotMatch(out, /confirm_box_reply\.py say/);
});

test("画像への直接コメント: 質問を取り消してもコメント自体はカードに残る(2026-11-06)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pane-"));
  const t0 = Date.now();
  const text = `${IMAGE_COMMENT_TAG}【完成版へのコメント】ここを直して`;
  // 送信側(CardChatPane)は、送った後に「返事待ち」を取り消す。取り消しが効いても
  // コメント本文はカードの履歴に残る(投函元が直しを進められるように)。
  const asked = askFromPane(dir, { id: "i1" }, text, "a", t0);
  assert.equal(asked.ok, true);
  if (!asked.replyId) throw new Error("replyId が無い");
  cancelFromPane(dir, { id: "i1" }, asked.replyId);
  assert.equal(panePending(dir, { id: "i1" }, t0 + 200_000).length, 0);
  const chat = readCardChat(dir, { id: "i1" });
  assert.equal(
    chat.some((m) => m.text.includes(IMAGE_COMMENT_TAG)),
    true,
  );
});
