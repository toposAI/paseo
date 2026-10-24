import assert from "node:assert/strict";
import test from "node:test";
import {
  FOOTER_TABS,
  boxTabMode,
  confirmBoxBadgeCount,
  confirmBoxTabs,
  isWideLayout,
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

test("広い画面の判定は720px境界(狭いほうに倒す)", () => {
  assert.equal(isWideLayout(undefined, 1440), true);
  assert.equal(isWideLayout(undefined, 720), true);
  assert.equal(isWideLayout(undefined, 719), false);
  assert.equal(isWideLayout(undefined, 390), false);
  // ポップオーバーは窓が広くても箱が狭い: 箱幅を優先する。
  assert.equal(isWideLayout(420, 1440), false);
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
