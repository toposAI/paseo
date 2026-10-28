/**
 * 「タスク台帳」の画面の配線の形の回帰ガード(2026-10-28 ユーザー指示
 * 「この窓口Bの右側にその台帳をつくってほしい…完了したものを表示にするモードと完了したものは非表示にする
 * モードの2つを作って」)。
 *
 * 描画の実体は React Native なので `node --test` では動かせない。**ソースの形**を機械的に検査する
 * (`open-agent-right-column.test.ts` と同じ方式)。実際に出るかは実機確認(browser-op)で担保する。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "index.client.tsx"), "utf8");
const viewSource = readFileSync(join(here, "..", "client", "TaskLedgerView.tsx"), "utf8");

test("ワークスペースの面板として登録し、右側の欄(explorer)にも置ける", () => {
  const start = clientSource.indexOf("id: TASK_LEDGER_PANEL_ID,\n    title:");
  assert.ok(start >= 0, "addWorkspacePanel に台帳の面板がある");
  const body = clientSource.slice(start - 40, clientSource.indexOf("});", start));
  assert.match(body, /id: TASK_LEDGER_PANEL_ID/);
  assert.match(body, /context: "workspace"/, "窓口Bのスレが閉じても台帳は開ける");
  assert.match(body, /locations: \["workspace", "explorer"\]/, "右側の欄に置ける");
  assert.match(viewSource, /const TASK_LEDGER_PANEL_ID = "window-b-ledger"/);
});

test("窓口Bの見出しに台帳のボタンを足し、押すと右側の欄に開く", () => {
  assert.match(clientSource, /const TASK_LEDGER_HEADER_ID = "task-ledger"/);
  assert.match(clientSource, /id: TASK_LEDGER_HEADER_ID/);
  assert.match(
    clientSource,
    /c\.openPanel\(TASK_LEDGER_PANEL_ID, \{ workspaceId, location: "explorer" \}\)/,
    "右側の欄(explorer)に開く",
  );
  // 窓口Bのワークスペースのときだけ出る。
  assert.match(clientSource, /visible: false/, "最初は隠しておく");
  assert.match(clientSource, /update\(\{ visible: workspaceId === windowBWorkspaceId \}\)/);
});

test("広い画面で欄を閉じたときの逃げ道として全画面も登録する", () => {
  assert.match(clientSource, /ctx\.addScreen\(\{ id: TASK_LEDGER_SCREEN_ID, title: "タスク台帳"/);
  assert.match(
    clientSource,
    /c\.openScreen\(\{ screenId: TASK_LEDGER_SCREEN_ID \}\)/,
    "欄が使えないときは全画面",
  );
});

test("完了の表示モードは「完了も表示」と「完了は隠す」の2つで、既定は完了を隠す", () => {
  const start = viewSource.indexOf("export function useTaskLedger");
  assert.ok(start >= 0, "useTaskLedger がある");
  const body = viewSource.slice(start, viewSource.indexOf("\nexport function", start + 10));
  assert.match(body, /useState<LedgerMode>\("hide-done"\)/, "既定は「完了は隠す」");
  assert.match(viewSource, /完了は隠す/);
  assert.match(viewSource, /完了も表示/);
  assert.match(viewSource, /filterLedgerRows\(/, "並びと完了の判定は共通の1本を通す");
});

test("行には振り先(子スレ名・進捗)と開発プロジェクトを出す", () => {
  assert.match(viewSource, /LEDGER_PROGRESS_LABEL\[/);
  assert.match(viewSource, /LEDGER_KIND_LABEL\[/);
  assert.match(viewSource, /振り先/);
  assert.match(viewSource, /子スレを開く/);
  assert.match(viewSource, /row\.project/);
  assert.match(viewSource, /推測/, "台帳の正が無い間の行は推測と出す");
});

test("15秒ごとに読み直す(受付されたら台帳に追加される)", () => {
  assert.match(viewSource, /REFRESH_MS = 15_000/);
});

test("行の開発プロジェクトを押すと優先順位の画面が開く", () => {
  assert.match(viewSource, /openPriorityScreen\(\)/);
  const screensSource = readFileSync(join(here, "..", "client", "screens.ts"), "utf8");
  assert.match(
    screensSource,
    /screenId: BOX_TAB_SCREEN_ID, params: \{ tab: "priority" \}/,
    "確認箱の優先順位のタブ",
  );
  assert.match(clientSource, /setScreenOpener\(openBoxScreen\)/, "画面を開く入口を預ける");
  assert.match(clientSource, /params\.tab === "priority" \? "priority" : "items"/, "タブを選ぶ");
});
