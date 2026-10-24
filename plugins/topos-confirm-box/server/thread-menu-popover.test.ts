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

test("行メニューは行の中に差し込まない(行の高さ・並びが開閉で変わらない)", () => {
  // 描ける場所は2つだけ: スマホ幅のホストのシート(`renderMenuPopover`)と、PC 幅の
  // サイドバー内の絶対配置(`inlineMenu` の useMemo)。行の `children` の中には描かない。
  assert.equal(
    countMatches(sidebarSource, /<ThreadMenu\b/g),
    2,
    "ThreadMenu を描くのはシートとサイドバー内メニューの2か所だけ",
  );
  assert.match(sidebarSource, /const renderMenuPopover[\s\S]*?<ThreadMenu\b/);
  assert.match(sidebarSource, /const inlineMenu = useMemo[\s\S]*?<ThreadMenu\b/);
  const threadRow = sidebarSource.slice(sidebarSource.indexOf("function ThreadRow("));
  assert.doesNotMatch(
    threadRow.slice(0, threadRow.indexOf("const styles")),
    /<ThreadMenu\b/,
    "行の中にメニューを描かない",
  );
});

test("PC幅はサイドバーの内側に出す(ホストの浮きパネルをサイドバーの外へ出さない)", () => {
  // 2026-10-24 ユーザー指示「メイン画面の方じゃなくて、サイドバーの方に出して」。
  // シート(openPopover)は狭い幅のときだけ。広い幅では位置を測って自分で描く。
  assert.match(
    sidebarSource,
    /const anchor = compact \? null : measureMenuAnchor\(anchorNode, rootRef\.current\)/,
    "広い幅では押した行の位置を測る",
  );
  assert.match(
    sidebarSource,
    /if \(!anchor\) openPopover\?\.\(menuPopoverComponent\)/,
    "シートは退避時だけ",
  );
  // パネルは絶対配置で、幅は外枠に合わせて丸める(サイドバーの外へはみ出さない)。
  assert.match(sidebarSource, /testID="child-thread-menu-inline"/);
  assert.match(sidebarSource, /position:\s*"absolute"/);
  assert.match(
    sidebarSource,
    /Math\.min\(MENU_MAX_WIDTH, Math\.round\(anchor\.width - EDGE_PADDING \* 2\)\)/,
  );
  // 閉じる手段: 幕(外枠全体)のタップ・Esc・メニューの外の pointerdown。
  assert.match(sidebarSource, /testID="child-thread-menu-inline-backdrop"/);
  assert.match(sidebarSource, /event\.key === "Escape"/);
  assert.match(sidebarSource, /document\.addEventListener\("pointerdown", onDown, true\)/);
});

test("行の部品はメニューを受け取らない(行の高さが開閉で変わらない)", () => {
  // `ThreadRow` の props から `children` が消えていること。戻すと行が伸びる。
  const threadRow = sidebarSource.slice(sidebarSource.indexOf("function ThreadRow("));
  const head = threadRow.slice(0, threadRow.indexOf("}) {"));
  assert.doesNotMatch(head, /children\??:/, "ThreadRow は children を受け取らない");
});

test("メニューの一番上に操作対象のスレ名を出す(スマホのシートで行が見えなくても分かる)", () => {
  // 2026-10-24 ユーザー指摘「下にだすポップアップの一番上にスレ名を出して」。
  const menuSource = readFileSync(join(clientDir, "ThreadMenu.tsx"), "utf8");
  const body = menuSource.slice(
    menuSource.indexOf("return (\n    <View testID={`child-thread-menu-"),
  );
  const firstItem = body.search(/<MenuItem\b/);
  const title = body.indexOf("child-thread-menu-title-");
  assert.ok(title >= 0, "スレ名の見出しがある");
  assert.ok(firstItem >= 0 && title < firstItem, "見出しが項目より上にある");
  assert.match(body.slice(0, firstItem), /\{title\}/, "行に出ている題名を使う");
});

test("ポップアップの部品は開き直しても同じ関数(ホストが毎回作り直さない)", () => {
  // `openPopover` に渡す部品を押すたびに作ると、開いている最中の再描画で開き直しになる。
  assert.match(
    sidebarSource,
    /useMemo<ComponentType<PluginPopoverProps>>/,
    "部品は useMemo で固定する",
  );
  assert.match(
    sidebarSource,
    /renderMenuPopoverRef\.current = renderMenuPopover/,
    "中身は ref で最新化",
  );
});
