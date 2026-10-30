import assert from "node:assert/strict";
import test from "node:test";
import {
  FOOTER_TABS,
  bugBadgeCount,
  confirmBoxTabs,
  footerTitle,
  isWideLayout,
  judgmentBadgeLabel,
} from "../shared/footer-tabs.js";

// 確認箱の画面のタブ(実装と同じ並び)。id だけを見れば足りる。
const TABS = [{ id: "items" }, { id: "bugs" }, { id: "notify" }, { id: "priority" }];

test("確認箱の中は PC も iPhone も3枚(ユーザー判断は下部バーへ移した)", () => {
  assert.deepEqual(
    confirmBoxTabs(TABS).map((t) => t.id),
    ["bugs", "notify", "priority"],
  );
});

test("下部バーのバッジは未対応のバグ報告の数だけ(通知の未読は箱の中に出す)", () => {
  assert.equal(bugBadgeCount({ bugs: 5 }), 5);
  // 通知と、下部バーへ移した「ユーザー判断」の件数は数えない(二重に数えない)。
  assert.equal(bugBadgeCount({ items: 18, bugs: 5, notify: 29 }), 5);
  assert.equal(bugBadgeCount({}), 0);
});

test("PC幅の判定(一覧とチャットを横に並べるか)は幅720px・高さ480pxのどちらも満たすとき", () => {
  assert.equal(isWideLayout(1440, 900), true);
  // 境界は含む。
  assert.equal(isWideLayout(720, 480), true);
  assert.equal(isWideLayout(719, 900), false);
  // 横倒しの iPhone(932×430)は高さで狭い側へ倒す。
  assert.equal(isWideLayout(932, 430), false);
  // 高さが取れない呼び出し(ポップオーバーは箱幅を渡す)では幅だけで決める。
  assert.equal(isWideLayout(420, undefined), false);
  assert.equal(isWideLayout(1440, undefined), true);
  // ホストが compact と言ったら狭い側(ホスト側の境界が変わっても従来どおりへ倒れる)。
  assert.equal(isWideLayout(1440, 900, true), false);
  assert.equal(isWideLayout(1440, 900, false), true);
});

test("下部バーの並び: ユーザー判断 → バグ報告 → スレ一覧 → 構想一覧 → 共有プロジェクト → メールUI", () => {
  assert.deepEqual(
    FOOTER_TABS.map((t) => [t.id, t.title]),
    [
      ["judgment", "ユーザー判断"],
      ["bugs", "バグ報告"],
      ["sidebar-threads", "スレ一覧"],
      ["sidebar-concepts", "構想一覧"],
      ["sidebar-projects", "共有プロジェクト"],
      ["mail", "メールUI"],
    ],
  );
});

test("登録タイトルと読み上げ名は FOOTER_TABS と同じ文字列", () => {
  for (const t of FOOTER_TABS) assert.equal(footerTitle(t.id), t.title);
});

test("ユーザー判断のバッジは「出せる数/総数」。総数が不明なら出せる数だけ・両方0なら出さない", () => {
  assert.equal(judgmentBadgeLabel(1, 10), "1/10", "確認箱に10件あっても窓口Aが出せるのは1件");
  assert.equal(judgmentBadgeLabel(0, 10), "0/10", "件はあるが窓口は今出せない(0でも総数は見せる)");
  assert.equal(judgmentBadgeLabel(0, 0), null, "両方0は出さない");
  assert.equal(judgmentBadgeLabel(undefined, 0), null);
  assert.equal(judgmentBadgeLabel(1, null), "1", "総数が数えられないときは従来どおり出せる数だけ");
  assert.equal(judgmentBadgeLabel(1, undefined), "1");
  assert.equal(judgmentBadgeLabel(0, null), null);
  assert.equal(judgmentBadgeLabel(undefined, null), null);
  assert.equal(
    judgmentBadgeLabel(undefined, 3),
    "0/3",
    "出せる数が不明でも総数があれば0扱いで出す",
  );
  assert.equal(judgmentBadgeLabel(1, 120), "1/99+", "各数字は99で頭打ち");
});
