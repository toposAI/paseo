import assert from "node:assert/strict";
import test from "node:test";
import { isAwaitingReply } from "./cardchat.js";

const mine = (r: Record<string, unknown>) => r.id === "c1";
const NOW = 2_000_000_000_000;

test("送信後は返事待ち、受領(ack)では戻らず、返事が来たら戻る", () => {
  const ask = {
    t: "chat",
    id: "c1",
    ts: NOW - 1000,
    question: "これは？",
    client_message_id: "cbui-c1-1",
  };
  const ack = {
    t: "reply",
    id: "c1",
    ts: NOW - 1000,
    re: "cbui-c1-1",
    by: "ack",
    text: "受け取りました",
  };
  const real = {
    t: "reply",
    id: "c1",
    ts: NOW - 500,
    re: "cbui-c1-1",
    by: "hub_thread",
    text: "はい",
  };
  assert.equal(isAwaitingReply([], mine, NOW), false);
  assert.equal(isAwaitingReply([ask], mine, NOW), true);
  assert.equal(isAwaitingReply([ask, ack], mine, NOW), true);
  assert.equal(isAwaitingReply([ask, ack, real], mine, NOW), false);
});

test("取消・7日超・他カード・画像コメントは返事待ちにしない", () => {
  const ask = {
    t: "chat",
    id: "c1",
    ts: NOW - 1000,
    question: "q",
    client_message_id: "cbui-c1-1",
  };
  assert.equal(
    isAwaitingReply([ask, { t: "chat_cancel", id: "c1", ts: NOW, re: "cbui-c1-1" }], mine, NOW),
    false,
  );
  assert.equal(isAwaitingReply([{ ...ask, ts: NOW - 8 * 24 * 3600 * 1000 }], mine, NOW), false);
  assert.equal(isAwaitingReply([{ ...ask, id: "other" }], mine, NOW), false);
});
