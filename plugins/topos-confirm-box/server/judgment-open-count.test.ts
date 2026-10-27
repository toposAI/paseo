/**
 * サイドバー(下部バー)と確認箱の中のバッジの件数が、確認箱の open 件数 N から逃げない回帰ガード
 * (2026-10-27: バッジが N より大きく出ることがあった。実測 11 対 窓口A「残り3」)。
 *
 * 数え方の SSOT は `shared/judgment-open.ts` の `countJudgmentCounted`。N は判断窓口
 * (`judgment_window.py` の `counts.open` = Vault 判断ノートの open)と同じ対象にする。
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
import { countOpen, type ConfirmBoxItem } from "../shared/contract.js";
import { countJudgmentCounted, isJudgmentCounted } from "../shared/judgment-open.js";
import { readVaultDecisions } from "./vault-decisions.js";

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

test("N は Vault ノート由来(vault:)と permit の new だけ。材料待ち・既読・承認済み・ノート無しの箱行は数えない", () => {
  const items = [
    item({ id: "v1", kind: "pending", key: "vault:j-1" }),
    item({ id: "v2", kind: "pending", key: "vault:j-2", priority: "blocking" }),
    item({ id: "p", kind: "permit", judgment: false }),
    // 材料待ち相当(既読)・承認済みは数えない
    item({ id: "materials", kind: "pending", key: "vault:j-3", state: "read" }),
    item({ id: "done", kind: "pending", key: "vault:j-4", state: "approved" }),
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
  assert.equal(countJudgmentCounted(r.items), 2, "材料待ちは出さないのでバッジにも乗らない");
});

test("実データの形: Stale な箱行が残っていても N はノートの open と同じ", () => {
  // 画面の一覧(ノート + 残った箱行)で数えても、バッジの数え方はノートの open から動かない
  const items = [
    item({ id: "pending:vault:j-a", kind: "pending", key: "vault:j-a" }),
    item({ id: "pending:vault:j-b", kind: "pending", key: "vault:j-b" }),
    item({ id: "b4ec64f814d1477d", key: "inbox-monitor-parallel-count-merge-blocked-20261025" }),
    item({ id: "0d6672bfb083419e", key: "coord-j-6b02455-20261025" }),
  ];
  assert.equal(countOpen(items), 2);
});

test("Vault 読み取りを止めた(TOPOS_CONFIRM_BOX_VAULT_SOURCE=0)ときは、permit だけを数える", () => {
  // ノートを読まない設定では N もノート由来の項目を持たない。箱の判断行まで数えると N より多くなるので数えない
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

  // クライアント: 下部バーの `useJudgmentBadge` は件数 RPC の値を書き換えずに出す
  const start = clientSource.indexOf("function useJudgmentBadge(");
  assert.ok(start >= 0, "useJudgmentBadge がある");
  const body = clientSource.slice(start, clientSource.indexOf("\n}\n", start));
  assert.match(body, /setN\(r\.open\)/, "下部バーは件数 RPC の open をそのまま出す");
  assert.doesNotMatch(body, /\.filter\(/, "下部バーで独自に絞り込まない(画面と同じ数え方を使う)");
});
