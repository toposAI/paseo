/**
 * サイドバー(下部バー)と確認箱の中のバッジの件数が、確認箱の open 件数 N から逃げない回帰ガード
 * (2026-10-27: バッジが N より大きく出ることがあった。実測 バッジ11 対 N=10)。
 *
 * 数え方の SSOT は `shared/judgment-open.ts` の `countJudgmentCounted`。N の対象は判断窓口
 * (`judgment_window.py` の `counts.open` = Vault 判断ノートの open)に Paseo の承認待ち(permit)を足したもの。
 * 描画の実体は React Native なので `node --test` では動かせない。代わりに**ソースの形**を機械的に検査する
 * (`sidebar-trailing-badge.test.ts` と同じ方式)。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { countOpen, judgmentTabRows, type ConfirmBoxItem } from "../shared/contract.js";
import {
  countJudgmentCounted,
  isJudgmentCounted,
  isJudgmentOpen,
} from "../shared/judgment-open.js";
import { VAULT_DECISION_SOURCE, readVaultDecisions } from "./vault-decisions.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const serverSource = fs.readFileSync(join(pluginDir, "index.server.ts"), "utf8");
const clientSource = fs.readFileSync(join(pluginDir, "index.client.tsx"), "utf8");

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

/** Vault 判断ノートから作られた形の項目(`readVaultDecisions` と同じ出所・id・key)。 */
function vaultItem(id: string, over: Partial<ConfirmBoxItem> = {}): ConfirmBoxItem {
  return item({
    id: `pending:vault:${id}`,
    kind: "pending",
    key: `vault:${id}`,
    source: VAULT_DECISION_SOURCE,
    ...over,
  });
}

test("N は Vault ノート由来と permit の new だけ。既読・承認済み・ノート無しの箱行は数えない", () => {
  const items = [
    vaultItem("j-1"),
    vaultItem("j-2", { priority: "blocking" }),
    item({ id: "p", kind: "permit", judgment: false }),
    // 既読・承認済みは数えない
    vaultItem("j-3", { state: "read" }),
    vaultItem("j-4", { state: "approved" }),
    // ノート化されていない古い箱の判断行=N に出てこない(2026-10-27 の実例の形)
    item({ id: "stale", key: "coord-j-6b02455-20261025" }),
    // 通知・旧形式
    item({ id: "notice", judgment: false }),
    item({ id: "legacy", judgment: false, options: [{ id: "a", label: "x" }] }),
  ];
  assert.equal(items.filter(isJudgmentCounted).length, 3);
  assert.equal(countJudgmentCounted(items), 3);
  // バッジ(countOpen)も同じ数
  assert.equal(countOpen(items), 3);
});

test("数える対象は必ず判断タブの行にも出る(数える対象 ⊆ 行)", () => {
  const items = [
    vaultItem("j-1"),
    vaultItem("j-2", { state: "read" }),
    vaultItem("j-3", { state: "approved" }),
    item({ id: "p", kind: "permit", judgment: false }),
    item({ id: "stale", key: "coord-j-6b02455-20261025" }),
    item({ id: "stale-read", key: "k", state: "read" }),
    item({ id: "notice", judgment: false }),
    item({ id: "legacy", judgment: false, options: [{ id: "a", label: "x" }] }),
  ];
  const rows = judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false });
  const rowIds = new Set(rows.map((r) => r.id));
  for (const i of items.filter(isJudgmentCounted)) assert.ok(rowIds.has(i.id), i.id);
  assert.ok(items.every((i) => !isJudgmentCounted(i) || isJudgmentOpen(i)));
});

test("旧形式(印なしの選択肢つき)は showDone が false でも legacy=true なら判断タブに出る", () => {
  // 2026-10-27 の 1巡目レビューで見つかった退行(既定の絞り込みに判断印の条件を掛けていた)の回帰ガード
  const items = [
    item({ id: "judgment" }),
    item({ id: "legacy", judgment: false, options: [{ id: "a", label: "x" }] }),
    item({ id: "legacy-read", judgment: false, options: [{ id: "a", label: "x" }], state: "read" }),
  ];
  const ids = (legacy: boolean) =>
    judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false, legacy }).map(
      (r) => r.id,
    );
  assert.deepEqual(ids(false), ["judgment"]);
  assert.deepEqual(ids(true), ["judgment", "legacy"]);
});

test("Vault の判断ノート: open を読み、材料待ちは出す前の段で外す(窓口の open_notes と同じ数)", () => {
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
  assert.equal(countJudgmentCounted(r.items), 2, "材料待ちは出さないのでバッジにも乗らない");
});

test("実データの形: 残った箱の判断行が2件あっても N はノートの open(10)と同じ", () => {
  const items = [
    ...Array.from({ length: 10 }, (_, k) => vaultItem(`j-${k}`)),
    item({ id: "b4ec64f814d1477d", key: "inbox-monitor-parallel-count-merge-blocked-20261025" }),
    item({ id: "0d6672bfb083419e", key: "coord-j-6b02455-20261025" }),
  ];
  assert.equal(countOpen(items), 10);
  // 判断タブは残った箱行も出す(隠すと画面から判断が消えるため。N ≤ 行数)
  assert.equal(
    judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false }).length,
    12,
  );
});

test("箱の行に vault: 形の key が付いていても二重に数えない(出所で判定する)", () => {
  // ノート由来の項目と、同じ key の箱側の行が両方残っても1件。key の形だけでは見分けない
  const items = [vaultItem("j-1"), item({ id: "box-copy", key: "vault:j-1" })];
  assert.equal(countJudgmentCounted(items), 1);
});

test("Vault 読み取りを止めた(TOPOS_CONFIRM_BOX_VAULT_SOURCE=0)ときは、permit だけを数える", () => {
  // ノートを読まない設定では N もノート由来の項目を持たない。箱の判断行まで数えると N より多くなるので数えない。
  // このときは RPC の `openKnown` が false になる(件数 0 を「判断待ちなし」と読ませない)。
  const items = [
    item({ id: "stale", key: "coord-j-6b02455-20261025" }),
    item({ id: "p", kind: "permit", judgment: false }),
  ];
  assert.equal(countJudgmentCounted(items), 1);
});

test("確認箱の中のバッジ(サーバー)と下部バー(クライアント)は `countJudgmentCounted` の1本を使う", () => {
  // サーバー: 件数 RPC の open は isJudgmentCounted で絞る(`state !== "approved"` を復活させない)
  assert.match(
    serverSource,
    /import \{ isJudgmentCounted \} from "\.\/shared\/judgment-open\.js";/,
  );
  assert.match(serverSource, /const open = items\.filter\(isJudgmentCounted\);/);
  assert.doesNotMatch(serverSource, /i\.state !== "approved"/);
  assert.doesNotMatch(
    serverSource,
    /items\.filter\(isJudgmentOpen\)/,
    "N を判断タブの全行で数えない",
  );

  // サーバー: Vault を読めない/読まない設定のときは openKnown=false(数字の 0 を出さない)
  assert.match(
    serverSource,
    /const openKnown = vaultSourceEnabled\(\) && sources\.every\(\(src\) => src\.ok\);/,
  );
  assert.match(serverSource, /^\s+openKnown,$/m, "件数 RPC の返り値に openKnown を入れる");

  // クライアント: 下部バーの `useJudgmentBadge` は件数 RPC の値を書き換えずに出す
  const start = clientSource.indexOf("function useJudgmentBadge(");
  assert.ok(start >= 0, "useJudgmentBadge がある");
  const body = clientSource.slice(start, clientSource.indexOf("\n}\n", start));
  assert.match(body, /setN\(r\.open\)/, "下部バーは件数 RPC の open をそのまま出す");
  assert.match(body, /setUnknown\(!r\.openKnown\)/, "数え切れていないときは不明の印を出す");
  assert.doesNotMatch(body, /\.filter\(/, "下部バーで独自に絞り込まない(画面と同じ数え方を使う)");
});
