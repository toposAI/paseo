import assert from "node:assert/strict";
import test from "node:test";
import {
  FOOTER_TABS,
  boxTabMode,
  confirmBoxBadgeCount,
  confirmBoxTabs,
  footerTitle,
  isWideLayout,
  showsMovedFooterTabs,
} from "../shared/footer-tabs.js";

// 確認箱の画面のタブ(実装と同じ並び)。id だけを見れば足りる。
const TABS = [
  { id: "items" },
  { id: "bugs" },
  { id: "childdone" },
  { id: "notify" },
  { id: "priority" },
];

test("PC幅の確認箱はユーザー判断・子スレ完了を出さない(下部バーへ移した)", () => {
  assert.deepEqual(
    confirmBoxTabs(TABS, true).map((t) => t.id),
    ["bugs", "notify", "priority"],
  );
});

test("狭い幅(iPhone)は従来どおり5枚のまま", () => {
  assert.deepEqual(confirmBoxTabs(TABS, false), TABS);
});

test("確認箱のバッジは中に残るタブ(バグ報告+通知)の合計だけ", () => {
  assert.equal(confirmBoxBadgeCount({ bugs: 5, notify: 29 }), 34);
  // 移した2枚の件数は数えない(二重に数えない)。
  assert.equal(confirmBoxBadgeCount({ items: 18, childdone: 3, bugs: 5, notify: 29 }), 34);
  assert.equal(confirmBoxBadgeCount({}), 0);
  assert.equal(confirmBoxBadgeCount({ bugs: 2 }), 2);
});

test("PC幅の判定は幅720px・高さ480pxのどちらも満たすとき(高さ未指定は幅だけで見る)", () => {
  assert.equal(isWideLayout(1440, 900), true);
  // 境界は含む。
  assert.equal(isWideLayout(720, 480), true);
  assert.equal(isWideLayout(719, 900), false);
  assert.equal(isWideLayout(1440, 479), false);
  // 高さが取れない呼び出し(ポップオーバーは箱幅を渡す)では幅だけで決める。
  assert.equal(isWideLayout(420, undefined), false);
  assert.equal(isWideLayout(1440, undefined), true);
});

test("下部バーの2項目: iPhone縦・横倒しは出さない、iPadとPCは出す", () => {
  // iPhone 縦(390×844)/ 横(932×430): ホストの compact は横幅で決まるので横倒しでは false になる。
  assert.equal(showsMovedFooterTabs(true, 390, 844), false);
  assert.equal(showsMovedFooterTabs(false, 932, 430), false);
  // iPad 768×1024 と PC。
  assert.equal(showsMovedFooterTabs(false, 768, 1024), true);
  assert.equal(showsMovedFooterTabs(false, 1440, 900), true);
  // ホストが compact と言ったら出さない(ホスト側の境界が変わっても従来どおりへ倒れる)。
  assert.equal(showsMovedFooterTabs(true, 1440, 900), false);
  // 確認箱の中の判定(`isWideLayout`)も同じ compact を受ける(バーと箱で食い違わない)。
  assert.equal(isWideLayout(1440, 900, true), false);
  assert.equal(isWideLayout(1440, 900, false), true);
});

test("下部バーから開く画面のタブは ?mode= で決まる(不正値はユーザー判断)", () => {
  assert.equal(boxTabMode("childdone"), "childdone");
  assert.equal(boxTabMode("items"), "items");
  assert.equal(boxTabMode(undefined), "items");
  assert.equal(boxTabMode("bogus"), "items");
});

test("下部バーの並び: ユーザー判断 → 子スレ完了 → 確認箱 → メール → スレ一覧 → 構想一覧", () => {
  assert.deepEqual(
    FOOTER_TABS.map((t) => [t.id, t.title]),
    [
      ["judgment", "ユーザー判断"],
      ["childdone", "子スレ完了"],
      ["box", "確認箱"],
      ["mail", "メール"],
      ["sidebar-threads", "スレ一覧"],
      ["sidebar-concepts", "構想一覧"],
    ],
  );
});

test("登録タイトルと読み上げ名は FOOTER_TABS と同じ文字列", () => {
  for (const t of FOOTER_TABS) assert.equal(footerTitle(t.id), t.title);
});
