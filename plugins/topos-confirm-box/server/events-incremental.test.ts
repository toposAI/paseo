/**
 * `events-*.jsonl` の差分読み(2026-11-09)。
 *
 * 当月の events が 41MB まで育ち、30秒ごとの一覧取得とボタンを押すたびの取り直しで
 * 毎回その全行を読んでいた(実測 0.4〜1.0 秒)。前回読んだ位置から先だけを畳むように
 * 変えたので、**追記だけのときに全読みと同じ結果になる**ことを固定する。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfirmBox, resetEventsCache } from "./box.js";

function tmpBox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "confirm-box-events-"));
}

function jsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join("");
}

const item = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
  t: "item",
  id,
  ts,
  subject: `題名 ${id}`,
  priority: "normal",
  source: "test",
  ...extra,
});

/** 全読み(控えを捨ててから読む)の結果。 */
function fullRead(dir: string) {
  resetEventsCache();
  return readConfirmBox(dir);
}

test("追記だけなら、差分読みは全読みと同じ結果になる", () => {
  const dir = tmpBox();
  const file = path.join(dir, "events-202611.jsonl");
  resetEventsCache();
  fs.writeFileSync(file, jsonl([item("a", 1), item("b", 2)]));
  assert.equal(readConfirmBox(dir).items.length, 2);

  fs.appendFileSync(file, jsonl([item("c", 3), { t: "ack", id: "a", action: "approve" }]));
  const incremental = readConfirmBox(dir);
  const full = fullRead(dir);
  assert.deepEqual(incremental.items, full.items);
  assert.equal(incremental.items.length, 3);
  assert.equal(incremental.items.find((i) => i.id === "a")?.state, "approved");
});

test("hide / unhide は追記をまたいで効く", () => {
  const dir = tmpBox();
  const file = path.join(dir, "events-202611.jsonl");
  resetEventsCache();
  fs.writeFileSync(file, jsonl([item("a", 1), item("b", 2), { t: "hide", id: "b" }]));
  assert.deepEqual(
    readConfirmBox(dir).items.map((i) => i.id),
    ["a"],
  );
  fs.appendFileSync(file, jsonl([{ t: "unhide", id: "b" }]));
  assert.deepEqual(
    readConfirmBox(dir)
      .items.map((i) => i.id)
      .sort(),
    ["a", "b"],
  );
});

test("後から来た item にも key の判断印が当たる(差分読みでも)", () => {
  const dir = tmpBox();
  const file = path.join(dir, "events-202611.jsonl");
  resetEventsCache();
  fs.writeFileSync(file, jsonl([{ t: "judgment", key: "k1", judgment: true }]));
  assert.equal(readConfirmBox(dir).items.length, 0);
  fs.appendFileSync(file, jsonl([item("a", 1, { key: "k1" })]));
  assert.equal(readConfirmBox(dir).items.find((i) => i.id === "a")?.judgment, true);
  assert.equal(readConfirmBox(dir).items.find((i) => i.id === "a")?.judgment, true);
});

test("書き込み途中の行(改行なし)は次回に回し、書けたら読む", () => {
  const dir = tmpBox();
  const file = path.join(dir, "events-202611.jsonl");
  resetEventsCache();
  fs.writeFileSync(file, jsonl([item("a", 1)]));
  assert.equal(readConfirmBox(dir).items.length, 1);
  // 途中まで書かれた行(改行がまだ無い)
  fs.appendFileSync(file, '{"t":"item","id":"b","ts":2,"subj');
  assert.deepEqual(
    readConfirmBox(dir).items.map((i) => i.id),
    ["a"],
  );
  fs.appendFileSync(file, 'ect":"題名 b"}\n');
  assert.deepEqual(
    readConfirmBox(dir)
      .items.map((i) => i.id)
      .sort(),
    ["a", "b"],
  );
});

test("ファイルが縮んだら全読みし直す(控えを捨てる)", () => {
  const dir = tmpBox();
  const file = path.join(dir, "events-202611.jsonl");
  resetEventsCache();
  fs.writeFileSync(file, jsonl([item("a", 1), item("b", 2), item("c", 3)]));
  assert.equal(readConfirmBox(dir).items.length, 3);
  fs.writeFileSync(file, jsonl([item("z", 9)]));
  const after = readConfirmBox(dir);
  assert.deepEqual(
    after.items.map((i) => i.id),
    ["z"],
  );
  assert.deepEqual(after.items, fullRead(dir).items);
});

test("同じサイズで書き換えられたら全読みし直す", () => {
  const dir = tmpBox();
  const file = path.join(dir, "events-202611.jsonl");
  resetEventsCache();
  fs.writeFileSync(file, jsonl([item("aaaa", 1)]));
  assert.equal(readConfirmBox(dir).items[0]?.id, "aaaa");
  fs.writeFileSync(file, jsonl([item("bbbb", 1)]));
  // 同じ長さでも中身が変わったら気づく(mtime を見る)
  assert.deepEqual(
    readConfirmBox(dir).items.map((i) => i.id),
    ["bbbb"],
  );
});

test("新しい月のファイルが増えても、前の月の畳み込みは保たれる", () => {
  const dir = tmpBox();
  resetEventsCache();
  fs.writeFileSync(path.join(dir, "events-202611.jsonl"), jsonl([item("a", 1)]));
  assert.equal(readConfirmBox(dir).items.length, 1);
  fs.writeFileSync(path.join(dir, "events-202612.jsonl"), jsonl([item("b", 2)]));
  const incremental = readConfirmBox(dir);
  assert.deepEqual(incremental.items.map((i) => i.id).sort(), ["a", "b"]);
  assert.deepEqual(incremental.items, fullRead(dir).items);
});

test("ファイルが消えたら全読みし直す", () => {
  const dir = tmpBox();
  resetEventsCache();
  fs.writeFileSync(path.join(dir, "events-202611.jsonl"), jsonl([item("a", 1)]));
  fs.writeFileSync(path.join(dir, "events-202612.jsonl"), jsonl([item("b", 2)]));
  assert.equal(readConfirmBox(dir).items.length, 2);
  fs.rmSync(path.join(dir, "events-202611.jsonl"));
  assert.deepEqual(
    readConfirmBox(dir).items.map((i) => i.id),
    ["b"],
  );
});
