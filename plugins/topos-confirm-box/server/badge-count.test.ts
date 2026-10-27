import assert from "node:assert/strict";
import test from "node:test";
import { countOpen, judgmentTabRows, type ConfirmBoxItem } from "../shared/contract.js";
import { countJudgmentCounted } from "../shared/judgment-open.js";
import { VAULT_DECISION_SOURCE } from "./vault-decisions.js";

/** Vault 判断ノートから作られた形の項目(`readVaultDecisions` と同じ出所・id・key)。 */
function vault(id: string, extra: Partial<ConfirmBoxItem> = {}): ConfirmBoxItem {
  return item(`pending:vault:${id}`, {
    kind: "pending",
    key: `vault:${id}`,
    source: VAULT_DECISION_SOURCE,
    ...extra,
  });
}

function item(id: string, extra: Partial<ConfirmBoxItem> = {}): ConfirmBoxItem {
  return {
    id,
    kind: "box",
    priority: "normal",
    subrank: 0,
    group: null,
    subject: id,
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
    ts: 1_700_000_000_000,
    ...extra,
  } as ConfirmBoxItem;
}

test("バッジの件数(countOpen)は判断窓口の N(Vault ノート由来 + permit の open)と同じ", () => {
  const items = [
    // Vault 判断ノート由来(ノート化された判断)
    vault("v1"),
    vault("v2", { priority: "blocking" }),
    vault("c", { state: "approved" }),
    item("d", { judgment: false }),
    item("e", { judgment: false, options: [{ id: "a", label: "x" }] as never }),
    item("p", { kind: "permit", judgment: false }),
    // 既読(人が箱で既読にした行)。判断窓口の open ではないので、バッジにも判断タブにも出さない
    vault("n", { state: "read" }),
    // ノート化されていない古い箱の判断行。N に出てこないのでバッジには数えない(2026-10-27)
    item("stale", { key: "coord-j-6b02455-20261025" }),
  ];
  const rows = judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false });
  // v1・v2・p の3件だけ(approved・read・印なし・ノート無しの箱行は数えない)
  assert.equal(countOpen(items), 3);
  assert.equal(countJudgmentCounted(items), countOpen(items));
  // 判断タブはまだノートになっていない投函も見せるので N ≤ 行数(隠す方が害が大きい)
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r) => r.id === "stale"));
});

test("バッジの件数は判断窓口の open 件数と同じ(材料待ち・承認済み・既読・ノート無しの箱行を足さない)", () => {
  const items = [
    vault("open-1"),
    vault("open-2", { priority: "blocking" }),
    vault("approve", { state: "approved" }),
    vault("read-1", { state: "read" }),
    item("notice", { judgment: false, options: [] }),
    item("stale", { key: "inbox-monitor-parallel-count-merge-blocked-20261025" }),
  ];
  assert.equal(countJudgmentCounted(items), 2);
  // 判断タブ(既定の絞り込み)は、承認済み・既読・通知を除いた3件(ノート無しの箱行は出す)
  assert.equal(
    judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false }).length,
    3,
  );
  // 決定済みを出す設定でもバッジの数は変わらない(バッジは open だけ)
  assert.equal(countJudgmentCounted(items), 2);
});
