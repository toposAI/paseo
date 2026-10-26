/**
 * サイドバーの行末は「状態の帯だけ」であることの回帰ガード(2026-10-26 ユーザー指摘)。
 *
 * 症状は「三点リーダー(⋯)が復活した」。決定済みの形は**帯そのものが入口**で、待機中・実装中などの
 * 状態の文字を押すとピン止め・アーカイブのポップアップが開く。行末に別のボタンを並べない
 * (2026-10-24 ユーザー指示で帯を入口にした後、2026-10-26 の 13px 化のコミットで ⋯ が戻った)。
 *
 * 描画の実体は React Native なので `node --test` では動かせない。代わりに**ソースの形**を機械的に
 * 検査する(`thread-menu-popover.test.ts` と同じ方式)。見た目そのものは実機確認で担保する。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "client");
const sidebarSource = readFileSync(join(clientDir, "ChildThreadsSidebar.tsx"), "utf8");
const badgeSource = readFileSync(join(clientDir, "sidebar-badge.tsx"), "utf8");

/** スレ行(`ThreadRow`)の本体。`const styles` より前を切り出す。 */
function threadRowBody(source: string): string {
  const start = source.indexOf("function ThreadRow(");
  assert.ok(start >= 0, "ThreadRow がある");
  const body = source.slice(start);
  const stylesAt = body.indexOf("const styles");
  assert.ok(stylesAt > 0, "ThreadRow の直後に styles がある");
  return body.slice(0, stylesAt);
}

test("行末に三点リーダー(⋯)のボタンを描かない", () => {
  const row = threadRowBody(sidebarSource);
  assert.doesNotMatch(row, /<MenuButton\b/, "行末に MenuButton を描かない");
  // 説明のコメントで ⋯ に触れるのはよい。**画面に出る文字**として描かないことだけを見る。
  assert.doesNotMatch(row, />\s*⋯\s*</, "行末に ⋯ の文字を出さない");
  // 部品そのものも復活させない(使われない export を残すと、次の改修でまた挿される)。
  assert.doesNotMatch(badgeSource, /export function MenuButton\b/, "MenuButton を定義しない");
  assert.doesNotMatch(badgeSource, />\s*⋯\s*</, "sidebar-badge に ⋯ の文字を置かない");
});

test("行末の部品は状態の帯ひとつだけ", () => {
  const row = threadRowBody(sidebarSource);
  const trailing = row.slice(row.indexOf("const trailing = useMemo"));
  assert.ok(trailing.length > 0, "trailing がある");
  assert.equal((trailing.match(/<StatusBadge\b/g) ?? []).length, 1, "行末に状態の帯を1つだけ描く");
  // 行末の容器の中で描く要素は帯だけ(別のボタンを並べると幅を食い、押す場所も分かれる)。
  const container = trailing.slice(0, trailing.indexOf("</View>"));
  assert.equal(
    (container.match(/<(?!View\b|StatusBadge\b)[A-Z][A-Za-z]*\b/g) ?? []).length,
    0,
    "行末の容器には帯以外の部品を置かない",
  );
});

test("状態の帯を押すとピン止め・アーカイブのポップアップが開く", () => {
  const row = threadRowBody(sidebarSource);
  // 帯の押下は行メニュー(ピン止め/アーカイブ)を開く関数へ直結する。位置は帯を含む行末から測る。
  assert.match(
    row,
    /const pressBadge = useCallback\(\(\) => onOpenMenu\(row, badgeRef\.current\)/,
    "帯の押下は行メニューを開く",
  );
  assert.match(
    row,
    /<StatusBadge\b[\s\S]*?onPress=\{pressBadge\}[\s\S]*?\/>/,
    "帯に押下の入口を渡す",
  );
  // 渡された帯はボタンになり、押すとメニューが開くことを読み上げでも示す。
  assert.match(badgeSource, /if \(!onPress\) \{[\s\S]*?return \(/);
  assert.match(badgeSource, /onPress=\{onPress\}/);
  assert.match(
    badgeSource,
    /accessibilityLabel=\{`状態: \$\{text\}\(押すとピン止め・アーカイブのメニュー\)`\}/,
  );
});

test("状態の文字は13pxのまま(読めないという指摘を戻さない)", () => {
  // 13px 化は ⋯ とは別の修正(台帳 ui-be238b34bf)。⋯ を消すときに一緒に戻さない。
  const textStyle = badgeSource.slice(
    badgeSource.indexOf("  text: {"),
    badgeSource.indexOf("  },", badgeSource.indexOf("  text: {")),
  );
  assert.match(textStyle, /fontSize: 13,/);
});
