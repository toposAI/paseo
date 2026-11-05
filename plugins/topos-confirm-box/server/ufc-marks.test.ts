/**
 * 「UIの最終チェック」の返事待ち・未読の印を ask 台帳から作る規則(2026-11-05)。
 *
 * ここで固定したいこと:
 * - 印は画面のメモリではなく台帳から毎回作る(再読み込み・絞り込み切替で消えない)
 * - 受領(ack)は返事に数えない(以前は ack でも「返事が届きました」になっていた)
 * - 画面で見た印(`t:"seen"`)が返事より新しければ未読は消える。返事待ちは消さない
 * - 投函元スレの生死は見ない(スレが閉じていても返事待ちは残す=総司令塔へ振り替わる)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { askFromPane, cancelFromPane, cardChatMarks, markSeen } from "./cardchat.ts";

const dirs: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ufc-marks-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function eventsFile(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter((n) => /^events-\d{6}\.jsonl$/.test(n))
    .map((n) => path.join(dir, n))
    .sort()
    .at(-1) as string;
}

function appendRaw(dir: string, row: Record<string, unknown>): void {
  fs.appendFileSync(eventsFile(dir), `${JSON.stringify(row)}\n`, { encoding: "utf-8" });
}

const target = { id: "pending:ui-1", key: "ui-1" };
const now = 1_800_000_000_000;

test("何も無ければ印は出ない", () => {
  const dir = tmp();
  assert.deepEqual(cardChatMarks(dir, target, now), {
    waiting: false,
    unread: false,
    replies: 0,
    lastReplyAt: null,
  });
});

test("ペインから送って返事が無いうちは返事待ち(別の項目の質問では立たない)", () => {
  const dir = tmp();
  askFromPane(dir, target, "直してほしい", "agent-1", now - 1000);
  askFromPane(dir, { id: "pending:other", key: "other" }, "別件", "agent-1", now - 1000);
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.waiting, true);
  assert.equal(m.unread, false);
  assert.equal(m.replies, 0);
});

test("ack は返事に数えない(受領だけでは未読にならない)", () => {
  const dir = tmp();
  const out = askFromPane(dir, target, "直してほしい", "agent-1", now - 1000);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: now - 900,
    re: out.replyId,
    by: "ack",
    text: "受け取りました",
  });
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.waiting, true);
  assert.equal(m.unread, false);
  assert.equal(m.replies, 0);
});

test("ack 以外の返事が届いたら返事待ちが解けて未読になる", () => {
  const dir = tmp();
  const out = askFromPane(dir, target, "直してほしい", "agent-1", now - 1000);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: now - 500,
    re: out.replyId,
    by: "hub_thread",
    text: "直しました",
  });
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.waiting, false);
  assert.equal(m.unread, true);
  assert.equal(m.replies, 1);
  assert.equal(m.lastReplyAt, now - 500);
});

test("見た印が返事より新しければ未読は消えるが、返事の数は残る", () => {
  const dir = tmp();
  const out = askFromPane(dir, target, "直してほしい", "agent-1", now - 1000);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: now - 500,
    re: out.replyId,
    by: "origin_thread",
    text: "直しました",
  });
  markSeen(dir, target, now - 400);
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.unread, false);
  assert.equal(m.replies, 1);
});

test("見た印より後に返事が来たら未読に戻る(再読み込みしても消えない)", () => {
  const dir = tmp();
  const first = askFromPane(dir, target, "直してほしい", "agent-1", now - 3000);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: now - 2500,
    re: first.replyId,
    by: "origin_thread",
    text: "直しました",
  });
  markSeen(dir, target, now - 2000);
  const second = askFromPane(dir, target, "もう1点", "agent-1", now - 1500);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: now - 1000,
    re: second.replyId,
    by: "origin_thread",
    text: "直しました2",
  });
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.unread, true);
  assert.equal(m.replies, 2);
});

test("送信に失敗して取り消した質問は返事待ちに数えない", () => {
  const dir = tmp();
  const out = askFromPane(dir, target, "直してほしい", "agent-1", now - 1000);
  cancelFromPane(dir, target, out.replyId ?? "");
  assert.equal(cardChatMarks(dir, target, now).waiting, false);
});

test("7日より古い質問・返事は数えない", () => {
  const dir = tmp();
  const old = now - 8 * 24 * 3600 * 1000;
  const out = askFromPane(dir, target, "古い質問", "agent-1", old);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: old + 100,
    re: out.replyId,
    by: "origin_thread",
    text: "古い返事",
  });
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.waiting, false);
  assert.equal(m.unread, false);
  assert.equal(m.replies, 0);
});

test("返事待ちの間に見た印を書いても、返事待ちは消えない", () => {
  const dir = tmp();
  askFromPane(dir, target, "直してほしい", "agent-1", now - 1000);
  markSeen(dir, target, now - 500);
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.waiting, true);
  assert.equal(m.unread, false);
});

test("既に読んでいれば見た印を書き足さない(開くたびに台帳が伸びない)", () => {
  const dir = tmp();
  const out = askFromPane(dir, target, "直してほしい", "agent-1", now - 3000);
  appendRaw(dir, {
    t: "reply",
    id: target.id,
    ts: now - 2000,
    re: out.replyId,
    by: "origin_thread",
    text: "直しました",
  });
  const before = fs.readFileSync(eventsFile(dir), "utf-8").split("\n").filter(Boolean).length;
  assert.equal(markSeen(dir, target, now - 1000), true);
  assert.equal(markSeen(dir, target, now - 900), false);
  assert.equal(markSeen(dir, target, now - 800), false);
  const after = fs.readFileSync(eventsFile(dir), "utf-8").split("\n").filter(Boolean).length;
  assert.equal(after, before + 1);
});

test("投函元スレが生きているかは見ない(スレが閉じても返事待ちは残す)", () => {
  const dir = tmp();
  askFromPane(dir, target, "直してほしい", "agent-that-was-archived", now - 1000);
  const m = cardChatMarks(dir, target, now);
  assert.equal(m.waiting, true);
});
