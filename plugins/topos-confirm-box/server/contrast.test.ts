import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contrastRatio,
  meetsContrast,
  parseHex,
  pickReadableText,
  relativeLuminance,
} from "../shared/contrast.js";

test("parseHexは#rgb/#rrggbbと不透明な#rrggbbaaを読み、半透明は判定不能にする", () => {
  assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
  assert.deepEqual(parseHex("000000"), [0, 0, 0]);
  assert.deepEqual(parseHex("#336699ff"), [0x33, 0x66, 0x99]);
  // 半透明は背景と合成しないと比を出せないので、通さない(薄い色を合格と誤判定しない)
  assert.equal(parseHex("#336699cc"), null);
  assert.equal(parseHex("red"), null);
  assert.equal(parseHex("#12345"), null);
});

test("contrastRatio: 黒と白は21:1、同じ色は1:1", () => {
  assert.ok(Math.abs((contrastRatio("#000000", "#ffffff") ?? 0) - 21) < 0.01);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(contrastRatio("not-a-color", "#fff"), null);
});

test("relativeLuminance: 白=1、黒=0の間に入る", () => {
  assert.equal(relativeLuminance("#ffffff"), 1);
  assert.equal(relativeLuminance("#000000"), 0);
});

test("pickReadableText: 4.5:1を満たす色を選び、満たさなければforegroundへ落とす", () => {
  // 薄いグレー(#999)は白地で約2.85:1 → 落ちる
  assert.equal(pickReadableText("#999999", "#1a1a1a", ["#ffffff", "#f5f5f5"]), "#1a1a1a");
  // 濃いグレー(#555)は白地で約7.5:1 → そのまま
  assert.equal(pickReadableText("#555555", "#1a1a1a", ["#ffffff", "#f5f5f5"]), "#555555");
});

test("pickReadableText: 背景のどれか1つが不足なら落とす", () => {
  // #777 は白地で4.48:1(4.5未満)なので、明るい背景が混ざれば駄目
  assert.equal(pickReadableText("#777777", "#000000", ["#000000"]), "#777777");
  assert.equal(pickReadableText("#777777", "#000000", ["#ffffff"]), "#000000");
});

test("pickReadableText: 背景が無い/色が読めないときは安全側(foreground)", () => {
  assert.equal(pickReadableText("#555555", "#111111", []), "#111111");
});

test("pickReadableText: 落とした先も満たさないテーマでは、より読める方(比が高い方)を返す", () => {
  // 明るいグレー地でどちらも4.5未満。#888 の方が #999 より読める(引数の順に依らない)
  assert.equal(pickReadableText("#999999", "#888888", ["#f0f0f0"]), "#888888");
  assert.equal(pickReadableText("#888888", "#999999", ["#f0f0f0"]), "#888888");
});

test("meetsContrast: 判定不能(非hex・半透明)は満たさない扱い", () => {
  assert.equal(meetsContrast("#555555", ["#ffffff"]), true);
  assert.equal(meetsContrast("var(--fg)", ["#ffffff"]), false);
  assert.equal(meetsContrast("#55555580", ["#ffffff"]), false);
});
