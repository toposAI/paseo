import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captionToShow,
  headingText,
  HEADING_MAX,
  HEADING_SOFT,
  shotRatio,
  splitShotCount,
  SHOT_FALLBACK_RATIO,
} from "./card-title.js";

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

test("見出しは長い題を最初の1問に切り、2行に収まらない分は読点で畳む", () => {
  // 投函側が2つの質問を「 / 」でつないだ実例(2026-11-08 ユーザー指摘「題名が長過ぎ」)
  const long =
    "【確認箱の取り下げ(このスレの修理)】確認箱で画像カードを「取り下げ」と答えたとき、以後どこまで出し直しを止めますか？ 今は、回答に「全部」「まとめて」などがあれば同じ画面の一続き全体、無ければその1画面だけを止めています。 / 【確認箱の「隠す」ボタン】確認箱の画面でカードを「隠す」操作をしたとき";
  const h = headingText(long);
  // iPhone幅で2行に収まる長さに畳み、途中で切ったことが分かる「…」を付ける
  // (3行に伸ばすと行の右端がギザギザになる、2026-11-08 ui-visual-check の差し戻し)
  assert.ok(h.length <= HEADING_SOFT + 2, `${HEADING_SOFT}字前後: ${h.length}`);
  assert.ok(h.endsWith("…"), h);
  assert.ok(!h.includes("【確認箱の「隠す」ボタン】"), "2問目は見出しに出さない");
  // 異常に長い1問(改行も句点も無い)は歯止めで「…」に縮める
  const monstrous = "あ".repeat(HEADING_MAX + 40);
  const m = headingText(monstrous);
  assert.ok(m.length <= HEADING_MAX && m.endsWith("…"), `${m.length}`);
  // 枚数表記は見出し本体から外す(別に必ず表示する)
  assert.equal(
    headingText("UI確認: 共有の置き場(家族版)(2/2枚目)"),
    "UI確認: 共有の置き場(家族版)",
  );
  // 短い題はそのまま(畳まない)
  assert.equal(
    headingText("失効するAPIクレジットを何に使うか"),
    "失効するAPIクレジットを何に使うか",
  );
});

test("区切りの「 / 」は質問の区切りとは限らない(1問目が短ければ切らない)", () => {
  // 「PC」だけの見出しになるのを防ぐ(2026-11-09 出口レビューの指摘)
  const t = "PC / iPhone の表示幅をそろえる案";
  assert.equal(headingText(t), t);
  // 1問目が十分長ければ従来どおり切る
  assert.equal(
    headingText("家族版を出荷してよいですか？ / 旧画面を消してよいですか？"),
    "家族版を出荷してよいですか？",
  );
});

test("半角の「!」も文の終わりとして扱い、絵文字は割らない", () => {
  assert.equal(
    headingText("共有の置き場を家族版へ移してよいですか! 移すと元に戻せません"),
    "共有の置き場を家族版へ移してよいですか!",
  );
  // サロゲートペアを半分に切らない(文字数で歯止めを掛ける)
  const emoji = "🎉".repeat(HEADING_MAX + 10);
  const e = headingText(emoji);
  assert.ok(e.endsWith("…"), e);
  assert.equal(Array.from(e).length, HEADING_MAX, `${Array.from(e).length}`);
  assert.ok(!/[\uD800-\uDBFF]$/.test(e.slice(0, -1)), "絵文字が途中で割れていない");
});

test("読点も助詞も無い題は畳めず、歯止め(HEADING_MAX)まで残る", () => {
  // カタカナだけの題には「、」も助詞(はがをにでともへやの)も無い
  const t = "アイウエオカキクケコ".repeat(6); // 60字
  const h = headingText(t);
  assert.equal(h, t, "畳めない題はそのまま(80字の歯止めには届かない)");
  assert.ok(h.length > HEADING_SOFT && h.length <= HEADING_MAX, `${h.length}`);
});

test("読点が無い題は助詞の直後で畳む", () => {
  const t =
    "確認箱のカードの題名が長すぎるので最初の質問だけを出して残りは背景で読ませる案を今日から試して見てもらう";
  const h = headingText(t);
  assert.ok(h.endsWith("…"), h);
  assert.ok(h.length <= HEADING_SOFT + 2, `${h.length}`);
  assert.ok(t.startsWith(h.slice(0, -1)), h);
});
