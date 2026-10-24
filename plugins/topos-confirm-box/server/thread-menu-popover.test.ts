/**
 * 行メニューが**サイドバーに割り込まない**ことの回帰ガード(2026-10-24 ユーザー指摘)。
 *
 * 症状は「帯を押すと、その行の下に行が差し込まれて下の行が押し下げられる」。原因は
 * `ThreadRow` の `children` にメニューを描いていたこと。いまはホストの `openPopover` に渡して
 * 一覧の外(PC=行の右横の浮きパネル / スマホ=ボトムシート)に出すので、行の高さは変わらない。
 *
 * 描画の実体は React Native なので `node --test` では動かせない。代わりに**ソースの形**を機械的に
 * 検査して、行の中へ差し込む形が戻ってきたら落ちるようにする(見た目は実機確認で担保する)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "client");
const sidebarSource = readFileSync(join(clientDir, "ChildThreadsSidebar.tsx"), "utf8");

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

test("行メニューはホストのポップアップに出す(行の中に差し込まない)", () => {
  // 入口はホストの `openPopover`。行の中に描く `children` は使わない。
  assert.match(sidebarSource, /openPopover\(menuPopoverComponent\)/, "openPopover で開く");
  // メニューの本体はポップアップの部品(`renderMenuPopover`)の中だけで描く。
  assert.equal(
    countMatches(sidebarSource, /<ThreadMenu\b/g),
    1,
    "ThreadMenu を描くのはポップアップの中の1か所だけ",
  );
  assert.match(sidebarSource, /const renderMenuPopover[\s\S]*?<ThreadMenu\b/);
});

test("行の部品はメニューを受け取らない(行の高さが開閉で変わらない)", () => {
  // `ThreadRow` の props から `children` が消えていること。戻すと行が伸びる。
  const threadRow = sidebarSource.slice(sidebarSource.indexOf("function ThreadRow("));
  const head = threadRow.slice(0, threadRow.indexOf("}) {"));
  assert.doesNotMatch(head, /children\??:/, "ThreadRow は children を受け取らない");
});

test("ポップアップの部品は開き直しても同じ関数(ホストが毎回作り直さない)", () => {
  // `openPopover` に渡す部品を押すたびに作ると、開いている最中の再描画で開き直しになる。
  assert.match(sidebarSource, /useMemo<ComponentType<object>>/, "部品は useMemo で固定する");
  assert.match(sidebarSource, /renderMenuPopoverRef\.current = renderMenuPopover/, "中身は ref で最新化");
});
