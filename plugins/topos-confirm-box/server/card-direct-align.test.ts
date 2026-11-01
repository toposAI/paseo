import { strict as assert } from "node:assert";
import test from "node:test";
import { alignToTop, scrollParent, type AlignBox } from "../client/align-to-top.js";

type Fake = AlignBox & { oy: string };

const box = (top: number, oy = "visible"): Fake => ({
  oy,
  getBoundingClientRect: () => ({ top }),
});

/** カード → … → スクロール領域(ヘッダーの下端が scrollerTop)の連なりを作る。 */
function chain(cardTop: number, scrollerTop: number, scrollTop: number) {
  const scroller = Object.assign(box(scrollerTop, "auto"), {
    scrollTop,
    scrollHeight: 900,
    clientHeight: 660,
  });
  const card = box(cardTop);
  card.parentElement = scroller;
  return { card, scroller };
}

const styleOf = (el: AlignBox) => ({ overflowY: (el as Fake).oy });

test("先頭が見えているときはスクロールを動かさない", () => {
  const { card, scroller } = chain(64, 64, 54);
  alignToTop(card, styleOf);
  assert.equal(scroller.scrollTop, 54);
});

test("ヘッダーの下に少しだけ潜ったら、潜った分だけ戻す(固定値を使わない)", () => {
  // 画面全体(0)からは見えているが、ヘッダーの下端(64)より上 → 旧実装が見のがしていた形
  const { card, scroller } = chain(20, 64, 120);
  alignToTop(card, styleOf);
  assert.equal(scroller.scrollTop, 76); // 120 - 44
});

test("ヘッダーが背高になっても、実測した下端に合わせる", () => {
  const { card, scroller } = chain(0, 96, 300);
  alignToTop(card, styleOf);
  assert.equal(scroller.scrollTop, 204); // 300 - 96
});

test("スクロール領域の上端が 0(ヘッダー無し)なら画面全体と比べる", () => {
  const { card, scroller } = chain(-30, 0, 200);
  alignToTop(card, styleOf);
  assert.equal(scroller.scrollTop, 170);
});

test("丸め誤差(2px 未満)では動かさない", () => {
  const { card, scroller } = chain(63, 64, 40);
  alignToTop(card, styleOf);
  assert.equal(scroller.scrollTop, 40);
});

test("戻し先が負になるなら 0 で止める", () => {
  const { card, scroller } = chain(-10, 64, 20);
  alignToTop(card, styleOf);
  assert.equal(scroller.scrollTop, 0);
});

test("スクロールする親が無ければページを戻す", () => {
  const card = box(-50);
  const calls: number[][] = [];
  const saved = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    scrollBy: (x: number, y: number) => calls.push([x, y]),
  };
  try {
    alignToTop(card, styleOf);
  } finally {
    (globalThis as { window?: unknown }).window = saved;
  }
  assert.deepEqual(calls, [[0, -50]]);
});

test("スクロールする親を、overflow と中身の高さの両方で選ぶ", () => {
  const outer = Object.assign(box(64, "auto"), {
    scrollTop: 0,
    scrollHeight: 900,
    clientHeight: 660,
  });
  const inner = Object.assign(box(64, "hidden"), {
    scrollTop: 0,
    scrollHeight: 900,
    clientHeight: 660,
  });
  const card = box(20);
  card.parentElement = inner;
  inner.parentElement = outer;
  assert.equal(scrollParent(card, styleOf), outer); // hidden は「スクロールする親」ではない
});

test("node が無い・測れないときは何もしない(例外を投げない)", () => {
  assert.doesNotThrow(() => alignToTop(null, styleOf));
  assert.doesNotThrow(() => alignToTop({}, styleOf));
});
