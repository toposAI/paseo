/**
 * ピン止めを「司令塔」の外へ出し、サイドバーの上に「ピン止め」グループとして並べる回帰ガード
 * (2026-10-25 ユーザー指示「ピン止めしたら、司令塔スレの外にだして、上部の司令塔の下において」)。
 *
 * 描画の実体は React Native なので `node --test` では動かせない。代わりに**ソースの形**を機械的に
 * 検査する(`thread-menu-popover.test.ts` と同じ流儀。見た目は実機確認で担保する)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "client");
const sidebarSource = readFileSync(join(clientDir, "ChildThreadsSidebar.tsx"), "utf8");
/** グループの割り方(描画)は 2026-10-27 に `shared/sidebar-rows.ts` の `groupThreadRows` へ移した。 */
const sharedSource = readFileSync(join(clientDir, "..", "shared", "sidebar-rows.ts"), "utf8");
const groupingSource = sidebarSource + "\n" + sharedSource;

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

test("グループの振り分けは `rowGroupKeyOf` の1か所だけ(司令塔判定の `visibleGroupKeyOf` を直接呼ばない)", () => {
  // 描画(`groupRows`)・並べ替え(`onReorderGroup`)・挿入時の整列(`pinFirstGrouped`)が同じ関数を通す。
  // `visibleGroupKeyOf` をここで直接呼ぶと、ピン止めした行が司令塔グループに残る(規則の二重定義)。
  assert.doesNotMatch(sidebarSource, /\bvisibleGroupKeyOf\b/, "visibleGroupKeyOf を直接使わない");
  // 呼ぶのは 描画(groupThreadRows の2か所)・並べ替え(onReorderGroup)・挿入時の整列(pinFirstGrouped)
  // と、定義自身(1か所)。`groupingSource` は両ファイルを合わせたもの。
  assert.equal(
    countMatches(groupingSource, /rowGroupKeyOf\(/g),
    5,
    "呼ぶのは groupThreadRows(2)・onReorderGroup・pinFirstGrouped・定義",
  );
});

test("ピン止めグループは司令塔より前に、常に開いたまま出す(折りたたみ不可)", () => {
  // 固定グループは `groups` にも入っているので、そのまま `...groups.values()` を足すと2回描画される
  // (2026-10-25 実機: ピン止め・司令塔が丸ごと2回出た)。`groups` の値のうち固定2つは一度だけ並べる。
  assert.match(
    sharedSource,
    /for \(const key of \[pinnedGroup, coordinatorGroup\]\)/,
    "固定2つを先に取り出す",
  );
  assert.match(
    sharedSource,
    /if \(g\.key !== pinnedGroup && g\.key !== coordinatorGroup\)/,
    "残りだけを後ろへ",
  );
  assert.doesNotMatch(
    sharedSource,
    /\.\.\.groups\.values\(\)/,
    "groups を丸ごと足さない(二重描画)",
  );
  assert.ok(
    sharedSource.indexOf("for (const key of [pinnedGroup, coordinatorGroup])") <
      sharedSource.indexOf("if (g.key !== pinnedGroup && g.key !== coordinatorGroup)"),
    "並びは ピン止め → 司令塔 → その他",
  );
  // 見出しの行末(件数+シェブロン)はピン止めグループだけ出さない
  assert.match(sidebarSource, /const pinned = group\.key === PINNED_GROUP/);
  assert.match(sidebarSource, /pinned \? undefined : \(/);
  assert.match(sidebarSource, /const shown = pinned \|\| open/);
  assert.match(sidebarSource, /\{shown \? \(/, "中身はピン止めなら常に出す");
});

test("ピン止めの保存に失敗したら印を戻し、失敗の知らせを出す(成功の文言を残さない)", () => {
  const body = sidebarSource.slice(
    sidebarSource.indexOf("const onTogglePin = useCallback("),
    sidebarSource.indexOf("/**\n   * 状態の帯を押した"),
  );
  assert.ok(body.length > 0, "onTogglePin がある");
  // 楽観更新と同じ整列(flip)でピンの印を戻す(グループも元へ戻る)
  assert.match(body, /setThreads\(\(prev\) => flip\(t\.pinned\)\(prev\)\)/);
  assert.match(body, /setNotice\("ピン止めを保存できませんでした"\)/);
  // 戻さない形・文言を上書きしない形はどちらも不可
  assert.doesNotMatch(body, /\.catch\(\(\) => (?!revert)/, "例外でも revert する");
  assert.match(body, /else revert\(\)/, "失敗したら印を戻す");
  assert.match(body, /\.catch\(\(\) => revert\(\)\)/);
  // 成功の文言は応答が ok のときだけ出す(楽観更新の時点で出すと、戻したあとに成功の文言が残る)
  assert.match(body, /if \(r\.ok\) setNotice\(pinned \? "ピン止めしました"/);
  assert.doesNotMatch(
    body,
    /^\s*setNotice\(pinned \? "ピン止めしました"/m,
    "楽観更新の直後に成功の文言を出さない",
  );
});
