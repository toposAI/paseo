/**
 * サイドバー(下部バー)と確認箱の中のバッジの件数が、確認箱の open 件数 N から逃げない回帰ガード
 * (2026-10-27: バッジが N より大きく出ることがあった)。
 *
 * 数え方は3箇所(画面の一覧・確認箱の中のバッジ・下部バー)にあるが、SSOT は `countJudgmentOpen` の1本。
 * 描画の実体は React Native なので `node --test` では動かせない。代わりに**ソースの形**を機械的に検査する
 * (`sidebar-trailing-badge.test.ts` と同じ方式)。
 */
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isJudgmentItem, type ConfirmBoxItem } from "../shared/contract.js";
import { countJudgmentOpen, isJudgmentOpen } from "../shared/judgment-open.js";
import { readVaultDecisions } from "./vault-decisions.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const serverSource = readFileSync(join(pluginDir, "index.server.ts"), "utf8");
const clientSource = readFileSync(join(pluginDir, "index.client.tsx"), "utf8");

function item(over: Partial<ConfirmBoxItem>): ConfirmBoxItem {
  return {
    id: "x",
    kind: "box",
    priority: "normal",
    subrank: 0,
    group: null,
    subject: "s",
    summary: "",
    background: "",
    source: "t",
    threadRef: null,
    stoppedCount: 0,
    options: [],
    recommended: null,
    state: "new",
    urgency: "normal",
    judgment: true,
    key: null,
    agentId: null,
    workspaceId: null,
    ts: 1,
    ...over,
  };
}

test("open=N は箱の new(判断印・permit)だけ。材料待ち・既読・承認済み・通知・旧形式は数えない", () => {
  const items = [
    item({ id: "a" }),
    item({ id: "b", priority: "blocking" }),
    item({ id: "p", kind: "permit", judgment: false }),
    item({ id: "materials", state: "read", summary: "【材料待ち】差分の整理" }),
    item({ id: "done", state: "approved" }),
    item({ id: "notice", judgment: false }),
    item({ id: "legacy", judgment: false, options: [{ id: "a", label: "x" }] }),
  ];
  const open = items.filter(isJudgmentOpen);
  assert.equal(open.length, 3);
  assert.equal(countJudgmentOpen(items), 3);
  // 数えた項目はすべて judgment(通知・旧形式を混ぜていない)
  assert.ok(open.every(isJudgmentItem));
});

test("Vault の判断ノート: open は出し、材料待ちは出す前の段で外す(窓口の open_notes と同じ数)", () => {
  const note = (id: string, state: string) => `---
id: ${id}
state: ${state}
priority: design
raised: 2026-10-22
answered_at: null
route: null
materials: null
legacy_keys: []
modified_history:
- 2026-10-22 23:06 (user)
---
# ${id}

## 背景
背景。

## 選択肢と推奨
a 維持 / b 取り消す

## 回答原文と日時
- (未回答)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judgment-open-"));
  fs.writeFileSync(path.join(dir, "j-1.md"), note("j-1", "open"));
  fs.writeFileSync(path.join(dir, "j-2.md"), note("j-2", "open"));
  fs.writeFileSync(path.join(dir, "j-3.md"), note("j-3", "waiting_materials"));
  fs.writeFileSync(path.join(dir, "j-4.md"), note("j-4", "answered"));
  const r = readVaultDecisions({ TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: dir });
  assert.equal(r.error, null);
  assert.equal(r.waiting, 1);
  assert.equal(countJudgmentOpen(r.items), 2, "材料待ちは出さないのでバッジにも乗らない");
});

test("確認箱の中のバッジ(サーバー)と下部バー(クライアント)は `countJudgmentOpen` の1本を使う", () => {
  // サーバー: 件数 RPC の open は isJudgmentOpen で絞る(`state !== "approved"` を復活させない)
  assert.match(serverSource, /import \{ isJudgmentOpen \} from "\.\/shared\/judgment-open\.js";/);
  assert.match(serverSource, /const open = items\.filter\(isJudgmentOpen\);/);
  assert.doesNotMatch(serverSource, /i\.state !== "approved"/);

  // クライアント: 下部バーの `useJudgmentBadge` は件数 RPC の値を書き換えずに出す
  const start = clientSource.indexOf("function useJudgmentBadge(");
  assert.ok(start >= 0, "useJudgmentBadge がある");
  const body = clientSource.slice(start, clientSource.indexOf("\n}\n", start));
  assert.match(body, /setN\(r\.open\)/, "下部バーは件数 RPC の open をそのまま出す");
  assert.doesNotMatch(body, /\.filter\(/, "下部バーで独自に絞り込まない(画面と同じ数え方を使う)");
});
