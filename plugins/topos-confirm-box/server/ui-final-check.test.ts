import assert from "node:assert/strict";
import { test } from "node:test";
import { fitInside, isUiFinalCheck, shotLabel, splitShots } from "../shared/ui-final-check.js";

test("件名の接頭辞か group で UIの最終チェック と判定する", () => {
  assert.equal(isUiFinalCheck({ subject: "UIの最終チェック: 設定", group: null }), true);
  assert.equal(isUiFinalCheck({ subject: "別の件", group: "ui-final-check" }), true);
  assert.equal(isUiFinalCheck({ subject: "通常の判断", group: "f80" }), false);
});

test("画像は先頭2枚が完成版、残りが変更前", () => {
  const img = (n: string) => ({ data: n, mimeType: "image/png" });
  const s = splitShots([img("a"), img("b"), img("c"), img("d")]);
  assert.deepEqual(
    s.finals.map((i) => i.data),
    ["a", "b"]
  );
  assert.deepEqual(
    s.befores.map((i) => i.data),
    ["c", "d"]
  );
  assert.deepEqual(splitShots(undefined), { finals: [], befores: [] });
});

test("fitInside は縦横比を保ち拡大しない", () => {
  assert.deepEqual(fitInside(1440, 900, 176, 110), { width: 176, height: 110 });
  assert.deepEqual(fitInside(390, 844, 176, 110), { width: 51, height: 110 });
  assert.deepEqual(fitInside(50, 40, 176, 110), { width: 50, height: 40 });
  assert.deepEqual(fitInside(0, 0, 176, 110), { width: 176, height: 110 });
});

test("見出しは完成版/変更前と PC/iPhone", () => {
  assert.equal(shotLabel(0, false), "完成版 PC");
  assert.equal(shotLabel(1, true), "変更前 iPhone");
});
