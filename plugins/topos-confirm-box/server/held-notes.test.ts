import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { countJudgmentCounted } from "../shared/judgment-open.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { readHeldNotes, readVaultDecisions, VAULT_DECISION_SOURCE } from "./vault-decisions.js";

// 2026-10-28 ユーザー指摘「そしたらバッジださないでよ。そして開くとカードあったけど？」
// 裏方が検討中・保留中の件は窓口Aも出せないので、バッジに数えず、一覧には「保留中」として残す。

function vault(id: string, extra: Partial<ConfirmBoxItem> = {}): ConfirmBoxItem {
  return {
    id: `pending:vault:${id}`,
    kind: "pending",
    priority: "normal",
    subrank: 0,
    group: null,
    subject: id,
    summary: "",
    background: "",
    source: VAULT_DECISION_SOURCE,
    threadRef: null,
    stoppedCount: 0,
    options: [],
    recommended: null,
    state: "new",
    urgency: "normal",
    judgment: true,
    key: `vault:${id}`,
    agentId: null,
    workspaceId: null,
    ts: 1_700_000_000_000,
    ...extra,
  } as ConfirmBoxItem;
}

function claimsDir(claims: unknown): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-notes-"));
  fs.writeFileSync(path.join(dir, "claims.json"), JSON.stringify(claims));
  return { TOPOS_JUDGMENT_WINDOW_DIR: dir } as NodeJS.ProcessEnv;
}

const NOW = 1_800_000_000_000;

test("検討中・回し中の有効な印だけ保留として返す(窓口A・記録中・期限切れは返さない)", () => {
  const env = claimsDir({
    "j-consult": { window: "consulting", expires_at: NOW / 1000 + 60 },
    "j-hold": {
      window: "consulting",
      expires_at: NOW / 1000 + 9999,
      hold_reason: "壁打ちスレで決めるまで\n保留",
    },
    "j-park": { window: "escalated", expires_at: NOW / 1000 + 60 },
    "j-a": { window: "A", expires_at: NOW / 1000 + 60 },
    "j-rec": { window: "recording", expires_at: NOW / 1000 + 60 },
    "j-expired": { window: "consulting", expires_at: NOW / 1000 - 1 },
  });
  const held = readHeldNotes(env, NOW);
  assert.deepEqual([...held.keys()].sort(), ["j-consult", "j-hold", "j-park"]);
  assert.equal(held.get("j-consult"), "裏方で検討中");
  assert.equal(held.get("j-hold"), "保留中: 壁打ちスレで決めるまで 保留");
});

test("台帳が無い・壊れているときは空(従来どおり全部数える)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-notes-"));
  assert.equal(readHeldNotes({ TOPOS_JUDGMENT_WINDOW_DIR: dir } as NodeJS.ProcessEnv, NOW).size, 0);
  fs.writeFileSync(path.join(dir, "claims.json"), "{broken");
  assert.equal(readHeldNotes({ TOPOS_JUDGMENT_WINDOW_DIR: dir } as NodeJS.ProcessEnv, NOW).size, 0);
});

test("ノートを読む流れで保留の印がonHoldになり、バッジから外れる(台帳の実形式: キー=ノートid・秒の浮動小数)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-int-"));
  const note = (id: string) =>
    `---\nid: ${id}\nstate: open\npriority: design\nraised: 2026-10-28\nanswered_at: null\nroute: null\nmaterials: null\nlegacy_keys: []\nmodified_history:\n- 2026-10-28 15:00 (user)\n---\n# 題名 ${id}\n\n## 背景\n背景\n\n## 選択肢と推奨\na 維持=推奨 / b 取り消す\n\n## 回答原文と日時\n- (未回答)\n`;
  fs.writeFileSync(path.join(dir, "j-held.md"), note("j-held"));
  fs.writeFileSync(path.join(dir, "j-free.md"), note("j-free"));
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "held-ledger-"));
  fs.writeFileSync(
    path.join(ledger, "claims.json"),
    JSON.stringify({
      "j-held": {
        window: "consulting",
        expires_at: Date.now() / 1000 + 3600.5,
        hold_reason: "壁打ちで決める",
      },
    }),
  );
  const r = readVaultDecisions({
    TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: dir,
    TOPOS_JUDGMENT_WINDOW_DIR: ledger,
  } as NodeJS.ProcessEnv);
  assert.equal(r.items.find((i) => i.key === "vault:j-held")?.onHold, "保留中: 壁打ちで決める");
  assert.equal(r.items.find((i) => i.key === "vault:j-free")?.onHold, undefined);
  assert.equal(countJudgmentCounted(r.items), 1);
});

test("バッジは保留中の件を数えない(窓口が出せる件だけ)", () => {
  const items = [
    vault("a"),
    vault("b", { onHold: "裏方で検討中" }),
    vault("c", { onHold: "保留中: x" }),
  ];
  assert.equal(countJudgmentCounted(items), 1);
});
