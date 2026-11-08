/** カードからの発言を「受け箱へ溜めるか」の判定の試験(2026-11-08)。
 *
 * ユーザー決定(2026-11-08): 画像への直接コメント・画像つき発言も受け箱に溜め、5分おきのまとめで届ける。
 * ただし故障検知・本番入れ替えなど5分待つと損をするものは従来どおり即送り。
 *
 * 判断は `shared/card-pane.ts` の `shouldQueueCardChat` に置いたので、画面を動かさず直接確かめる。
 * 画面側は「その関数に渡している」ことと「画像コメントを溜めから外す古い条件が戻っていない」ことだけ見る
 * (React を動かす基盤が無いため。既存の ui-card-manual-done.test.ts と同じソース検査)。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shouldQueueCardChat } from "../shared/card-pane.js";

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");

const base = {
  hasItem: true,
  attachedImages: 0,
  text: "余白が広すぎる",
  targetLive: true,
};

test("ふつうのカード発言は溜める", () => {
  assert.equal(shouldQueueCardChat(base), true);
});

test("画像への直接コメントも溜める(2026-11-08 のユーザー決定)", () => {
  // 画像コメントかどうかは溜める判断を変えない(=画像コメントも溜める)
  assert.equal(shouldQueueCardChat(base), true);
});

test("故障・本番入れ替えなどは溜めずに即時に送る(画像コメントに限らない)", () => {
  assert.equal(shouldQueueCardChat({ ...base, text: "ボタンが動かない" }), false);
  assert.equal(shouldQueueCardChat({ ...base, text: "本番入れ替えを先にしたい" }), false);
});

test("安全網(L0)・出口レビュー(Critique)の語も即時に送る", () => {
  assert.equal(shouldQueueCardChat({ ...base, text: "L0で止まった" }), false);
  assert.equal(shouldQueueCardChat({ ...base, text: "Critiqueが落ちた" }), false);
  assert.equal(shouldQueueCardChat({ ...base, text: "collect-auditorが異常検知" }), false);
});

test("画像ファイルの添付は溜めない(受け箱が運べないので直接送る)", () => {
  assert.equal(shouldQueueCardChat({ ...base, attachedImages: 1 }), false);
  assert.equal(shouldQueueCardChat({ ...base, attachedImages: 2 }), false);
});

test("カードの項目が無い発言は溜めない", () => {
  assert.equal(shouldQueueCardChat({ ...base, hasItem: false }), false);
});

test("宛先が死んでいたら溜めない(まとめ送りが永久に届かない)", () => {
  assert.equal(shouldQueueCardChat({ ...base, targetLive: false }), false);
});

test("画面は shared の判定を使い、見出しを付ける前の本文を渡す", () => {
  const source = readFileSync(path.join(clientDir, "CardChatPane.tsx"), "utf8");
  const start = source.indexOf("const queueable =");
  assert.ok(start >= 0, "queueable の判定が見つからない");
  const end = source.indexOf(";", start);
  const expr = source.slice(start, end);

  assert.match(expr, /shouldQueueCardChat\(\{/, `shared の判定を使っていない: ${expr}`);
  assert.match(expr, /attachedImages:\s*sentImages\.length/, "画像添付の有無を渡していない");
  assert.match(expr, /targetLive:\s*targetLive\(target\)/, "宛先の生死を渡していない");
  assert.match(
    expr,
    /text:\s*tagged\b/,
    `見出しを付ける前の本文(tagged)を渡していない(件名の語で即時判定が誤爆する): ${expr}`,
  );
  assert.equal(
    /!\s*imageComment\b/.test(expr),
    false,
    `画像コメントを溜めから外す古い条件が戻っている: ${expr}`,
  );
});
