import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterReply,
  afterSent,
  applyMarks,
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

test("送って進んだ先のカードが未読なら、見えているので印を外す", () => {
  const f = afterSent({ current: "a", waiting: [], unread: ["b"] }, ids, "a");
  assert.deepEqual(f, { current: "b", waiting: ["a"], unread: [] });
});

test("reconcile で見ているカードになった未読は印を外す", () => {
  const f = reconcile({ current: "a", waiting: [], unread: ["b"] }, ["a", "b"], ["b"]);
  assert.deepEqual(f, { current: "b", waiting: [], unread: [] });
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
  // 次に見るカードが未読だった場合は、見えているので印を外す
  assert.deepEqual(r, { current: "a", waiting: ["c"], unread: [] });
  assert.deepEqual(reconcile(f, ids, ids), f);
  assert.equal(reconcile(f, ids, []).current, null);
});

test("台帳の印: 返事待ち・未読はサーバの ask 台帳が正(再読み込みしても残る)", () => {
  // 画面のメモリは空(再読み込み直後)でも、台帳に返事待ちがあるカードは返事待ちで出る。
  const f = applyMarks({ current: "b", waiting: [], unread: [] }, ids, {
    a: { waiting: true, unread: false },
    b: { waiting: false, unread: false },
  });
  assert.deepEqual(f, { current: "b", waiting: ["a"], unread: [] });
  assert.equal(ufcCounts(ids, f).waiting, 1);
});

test("台帳の印: 台帳が返事待ちを解いたら、画面のメモリの印も消える", () => {
  const f = applyMarks({ current: "b", waiting: ["a"], unread: [] }, ids, {
    a: { waiting: false, unread: true },
  });
  assert.deepEqual(f, { current: "b", waiting: [], unread: ["a"] });
  assert.equal(ufcStatus(f, "a"), "unread");
});

test("台帳の印: 見ているカードの未読も台帳どおり残す(既読は開いた時に台帳へ書く)", () => {
  // 再読み込み直後は先頭の未回答カードが current になる。ここで印を落とすと、
  // 再読み込みのたびに「返事が届きました」が消えてしまう(2026-11-05)。
  const f = applyMarks({ current: "a", waiting: ["c"], unread: [] }, ids, {
    a: { waiting: false, unread: true },
  });
  assert.deepEqual(f, { current: "a", waiting: ["c"], unread: ["a"] });
  // 一覧から消えた id は落とす
  const g = applyMarks({ current: "a", waiting: ["z"], unread: [] }, ids, {});
  assert.deepEqual(g, { current: "a", waiting: [], unread: [] });
});
