/**
 * 確認箱の「スレを開く」が PC 幅で右カラムに開くことの回帰ガード(2026-10-25 ユーザー指示
 * 「右側に新しいカラムを開いて、そこにスレを表示してほしい」)。
 *
 * 描画の実体は React Native なので `node --test` では動かせない。代わりに**ソースの形**を
 * 機械的に検査する(`sidebar-trailing-badge.test.ts` と同じ方式)。実際に右カラムが出るかは
 * 実機確認(browser-op)で担保する。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const confirmBoxSource = readFileSync(join(here, "..", "client", "ConfirmBoxView.tsx"), "utf8");

/** カードチャットのペイン見出し「スレを開く」のハンドラ(2026-10-27 にフックへ切り出した)。 */
function openPaneThreadBody(source: string): string {
  const start = source.indexOf("function usePaneOpenThread");
  assert.ok(start >= 0, "usePaneOpenThread がある");
  const body = source.slice(start);
  const end = body.indexOf("}, [");
  assert.ok(end > 0, "usePaneOpenThread の依存配列で終わる");
  return body.slice(0, end);
}

test("PC 幅では「スレを開く」に placement: right を渡す", () => {
  const body = openPaneThreadBody(confirmBoxSource);
  assert.match(body, /placement:\s*"right"/, "右カラムの指定を渡す");
  // 開く実行は `openThreadInPane`(宛先を一覧で確かめてから開く)。
  assert.match(body, /openThreadInPane\(/, "宛先を確かめる実行部を通す");
});

test("右カラムの指定は幅(wide)で切り替え、狭い幅では従来どおり遷移する", () => {
  const body = openPaneThreadBody(confirmBoxSource);
  assert.match(body, /\bwide\b/, "幅の判定(wide)で分岐する");
  assert.doesNotMatch(body, /placement:\s*"right"\s*[},]/, "無条件に右カラムを指定しない");
  assert.match(body, /wide\s*&&\s*!?promotes\s*\?/, "wide のときだけ右カラムを足す");
});

test("依存配列に幅の判定を入れて、幅が変わったら作り直す", () => {
  const start = confirmBoxSource.indexOf("function usePaneOpenThread");
  const depsAt = confirmBoxSource.indexOf("}, [", start);
  const deps = confirmBoxSource.slice(depsAt, confirmBoxSource.indexOf("]", depsAt) + 1);
  assert.match(deps, /\bwide\b/, "依存配列に wide を入れる");
});
