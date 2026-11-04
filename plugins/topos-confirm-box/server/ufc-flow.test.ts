import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterReply,
  afterSent,
  nextOpen,
  reconcile,
  select,
  skipToNext,
  ufcCounts,
  ufcStatus,
  type UfcFlow,
} from "../shared/ufc-flow.js";

const ids = ["a", "b", "c"];
const start: UfcFlow = { current: "a", waiting: [], unread: [] };

test("送ったカードは返事待ちで残り、次の未回答へ進む", () => {
  const f = afterSent(start, ids, "a");
  assert.deepEqual(f, { current: "b", waiting: ["a"], unread: [] });
  assert.deepEqual(ufcCounts(ids, f), { remaining: 2, waiting: 1, unread: 0 });
});

test("全部返事待ちなら動かない", () => {
  let f = afterSent(start, ids, "a");
  f = afterSent(f, ids, "b");
  f = afterSent(f, ids, "c");
  assert.equal(f.current, "c");
  assert.equal(ufcCounts(ids, f).remaining, 0);
});

test("返事: 見ていないカードには未読の印、見ているカードには付けない", () => {
  const f = afterSent(start, ids, "a"); // current=b
  const g = afterReply(f, "a");
  assert.equal(ufcStatus(g, "a"), "unread");
  assert.equal(g.current, "b");
  const h = afterReply(afterSent({ ...start, current: "a" }, ["a"], "a"), "a");
  assert.equal(ufcStatus(h, "a"), "open");
});

test("未読の印から戻ると印が外れ、後回しは返事待ちを飛ばす", () => {
  const g = afterReply(afterSent(start, ids, "a"), "a");
  assert.deepEqual(select(g, "a").unread, []);
  const w = afterSent(start, ids, "a"); // current=b, waiting=[a]
  assert.equal(skipToNext(w, ids).current, "c");
  assert.equal(nextOpen(["a"], "a", []), null);
});

test("OK で消えたら直後の未回答カードへ。返事待ちの印は消えたカード分を落とす", () => {
  const f: UfcFlow = { current: "b", waiting: ["c"], unread: ["a"] };
  const r = reconcile(f, ids, ["a", "c"]);
  assert.deepEqual(r, { current: "a", waiting: ["c"], unread: ["a"] });
  assert.deepEqual(reconcile(f, ids, ids), f);
  assert.equal(reconcile(f, ids, []).current, null);
});
