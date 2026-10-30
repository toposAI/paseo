/**
 * 「ぼくの指示」を PC の右カラムに常時出す配線の形の回帰ガード
 * (2026-10-30 08:18 ユーザー(確認箱)「右側に一覧(PCは常時・iPhoneはボタンで開閉)で作る」)。
 *
 * 描画の実体は React Native なので `node --test` では動かせない。**ソースの形**を機械的に検査する
 * (`task-ledger-wiring.test.ts` と同じ方式)。実際に出るかは実機確認(browser-op)で担保する。
 * ホスト側(自動で出す仕組み・右カラムの置き方)は `packages/app` の vitest で検査する。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const clientSource = readFileSync(join(root, "index.client.tsx"), "utf8");
const panelSource = readFileSync(join(root, "client", "WindowBInstructions.tsx"), "utf8");
const viewSource = readFileSync(join(root, "client", "TaskLedgerView.tsx"), "utf8");

test("窓口Bのスレを開いたら自動で出す指定と、右カラムに置ける指定が揃っている", () => {
  const start = clientSource.indexOf("id: WINDOWB_PANEL_ID,");
  assert.ok(start >= 0, "addWorkspacePanel に「指示一覧」の面板がある");
  const body = clientSource.slice(start, clientSource.indexOf("});", start));
  assert.match(body, /locations: \["workspace", "right"\]/, "右カラムに置ける");
  assert.match(
    body,
    /autoOpen: \{ whenAgentIds: \[WINDOW_B_AGENT_ID\](, edgeSwipe: true)? \}/,
    "窓口Bのスレのときだけ自動で出す",
  );
  // 2026-10-30: 右端スワイプと会話の上の帯も、窓口Bのスレだけを指す。
  assert.match(body, /edgeSwipe: true/, "狭い画面の右端スワイプで開く");
  assert.match(body, /band: \{ whenAgentIds: \[WINDOW_B_AGENT_ID\], Component: WindowBBand \}/);
  // スレID は台帳と同じ定数(窓口B の固定ID)。別名で書き直さない。
  assert.match(viewSource, /WINDOW_B_AGENT_ID = "29f7ab97-3c33-407e-8a2b-c5284dd38f99"/);
});

test("iPhone の入口(「指示」ボタン)は残っていて、窓口Bのワークスペースにだけ出る", () => {
  assert.match(clientSource, /const WINDOWB_HEADER_ID = "windowb-instructions"/);
  assert.match(clientSource, /addWindowBHeaderButton\(client, found\)/, "見つけたら足す");
  assert.match(clientSource, /windowBHeaderButtons\.get\(found\)\?\.update\(\{ visible: true \}\)/);
  // 作るときは隠す(他のワークスペースには出さない)。押すと開く。
  const start = clientSource.indexOf("function addWindowBHeaderButton");
  const body = clientSource.slice(start, clientSource.indexOf("\n}\n", start));
  assert.match(body, /visible: false/);
  assert.match(body, /pinned: true/, "「…」に畳まず直接表示する(2026-10-30)");
  assert.match(body, /openWindowBFor\(c, workspaceId/);
});

test("一覧の面は、読んだ時刻が15分より前なら上部に目立つ色で「古い表示(時刻)」を出す", () => {
  assert.match(panelSource, /staleNotice\(data, now\)/);
  assert.match(panelSource, /testID="windowb-stale"/);
  assert.match(panelSource, /statusDanger/, "警告色(赤系)で出す");
});
