import assert from "node:assert/strict";
import { test } from "node:test";
import { captionToShow, shotRatio, splitShotCount, SHOT_FALLBACK_RATIO } from "./card-title.js";

test("枚数表記を見出し本体から分ける", () => {
  assert.deepEqual(splitShotCount("UI確認: 共有の置き場(家族版)(2/2枚目)"), {
    title: "UI確認: 共有の置き場(家族版)",
    suffix: "(2/2枚目)",
  });
  assert.deepEqual(splitShotCount("UI確認 (1 / 3 枚目)"), {
    title: "UI確認",
    suffix: "(1 / 3 枚目)",
  });
  assert.deepEqual(splitShotCount("普通の件名"), { title: "普通の件名", suffix: "" });
});

test("説明文が見出しと同じなら出さない", () => {
  assert.equal(captionToShow("UI確認: A(1/2枚目)", "UI確認: A(1/2枚目)"), null);
  assert.equal(captionToShow("UI確認: A", "UI確認: A(2/2枚目)"), null);
  assert.equal(captionToShow("pc 幅", "UI確認: A(1/2枚目)"), "pc 幅");
  assert.equal(captionToShow(undefined, "x"), null);
  assert.equal(captionToShow("  ", "x"), null);
});

test("縦横比は壊れた値で仮の比に落ちる", () => {
  assert.equal(shotRatio(0, 10), SHOT_FALLBACK_RATIO);
  assert.equal(shotRatio(200, 100), 2);
});
