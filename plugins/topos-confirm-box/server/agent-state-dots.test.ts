/**
 * 一覧の行へ点を付ける配線(`server/agent-state-dots.ts`)と、未登録スレの点の材料。
 * 承認待ちは `pendingPermissions` / `attentionReason` からしか出ないので、そこが写経で
 * 落ちていないことを固定する。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyStateDots, stateDotsById } from "./agent-state-dots.js";
import { mergeUnregisteredThreads, stateDotOf } from "./unregistered-threads.js";
import type { ChildThread } from "../shared/child-threads.js";
import { buildUpperRows } from "../shared/sidebar-rows.js";
import type { RowThread } from "../shared/sidebar-rows.js";

function row(agentId: string, over: Partial<ChildThread> = {}): ChildThread {
  return {
    agentId,
    title: `登録済み ${agentId}`,
    status: "実装中",
    machineState: "idle",
    request: "依頼",
    summaryItemId: null,
    summary: null,
    summaryState: null,
    summaryAcked: false,
    updatedAt: 1,
    parentAgentId: null,
    parentTitle: null,
    pinned: false,
    coordinator: false,
    parentOpenable: false,
    access: "open",
    ...over,
  };
}

test("承認待ちは status=running でも needs_input(橙)になる", () => {
  assert.equal(
    stateDotOf({
      id: "a",
      status: "running",
      pendingPermissions: [{ id: "p1" }],
      attentionReason: "permission",
    }),
    "needs_input",
  );
  // pendingPermissions の長さだけでも出る
  assert.equal(stateDotOf({ id: "a", status: "running", pendingPermissions: [{}] }), "needs_input");
  // 承認待ちが終われば実行中に戻る
  assert.equal(stateDotOf({ id: "a", status: "running", pendingPermissions: [] }), "running");
});

test("一覧から id → 点の種類を作る(アーカイブ済み・id 無しは入れない)", () => {
  const dots = stateDotsById([
    { id: "wait", status: "running", pendingPermissions: [{}] },
    { id: "err", status: "error" },
    { id: "run", status: "running" },
    { id: "new", status: "idle", requiresAttention: true },
    { id: "idle", status: "idle" },
    { id: "archived", status: "running", archivedAt: 123 },
    { status: "running" },
  ]);
  assert.equal(dots.get("wait"), "needs_input");
  assert.equal(dots.get("err"), "failed");
  assert.equal(dots.get("run"), "running");
  assert.equal(dots.get("new"), "attention");
  assert.equal(dots.get("idle"), "done");
  assert.equal(dots.has("archived"), false);
  assert.equal(dots.size, 5);
});

test("行へ点を付ける(一覧に無い行は null=点を出さない)", () => {
  const rows = [row("a"), row("b")];
  const out = applyStateDots(rows, new Map([["a", "needs_input" as const]]));
  assert.equal(out[0]?.stateDot, "needs_input");
  assert.equal(out[1]?.stateDot, null);
  // 変わらない行は同じ参照のまま(ポーリングごとの再描画を増やさない)
  assert.equal(out[0] === rows[0], false);
  assert.equal(out[1] === rows[1], false);
  const same = applyStateDots(out, new Map([["a", "needs_input" as const]]));
  assert.equal(same[0], out[0]);
  assert.equal(same[1], out[1]);
});

test("承認待ちの点が付いた行は帯も「ユーザー判断待ち」に揃う(登録簿の行も)", () => {
  // 登録簿の行は「実装中」と自己申告していても、いま Ask で止まっているなら判断待ちにする
  // (点=橙・帯=実装中 の食い違いを残さない。2026-10-24 実機確認で発覚)
  const [waiting] = applyStateDots(
    [row("registered", { status: "実装中", machineState: "running" })],
    new Map([["registered", "needs_input" as const]]),
  );
  assert.equal(waiting?.status, "ユーザー判断待ち");
  // 承認待ち以外では帯を動かさない(登録簿の自己申告が正)
  const [running] = applyStateDots(
    [row("registered", { status: "実装中" })],
    new Map([["registered", "running" as const]]),
  );
  assert.equal(running?.status, "実装中");
  // 完了の行でも、いま承認待ちなら判断待ちへ上げる(上段から消えて見落とされるのを防ぐ)
  const [completed] = applyStateDots(
    [row("registered", { status: "完了" })],
    new Map([["registered", "needs_input" as const]]),
  );
  assert.equal(completed?.status, "ユーザー判断待ち");
  const upper = buildUpperRows([completed as ChildThread & RowThread], new Map());
  assert.deepEqual(
    upper.map((r) => r.statusLabel),
    ["判断待ち"],
  );
});

test("登録簿に載らないスレも、承認待ちなら橙の点になる", () => {
  const { rows } = mergeUnregisteredThreads(
    [row("registered")],
    [
      {
        id: "direct",
        title: "Paseo から直接建てたスレ",
        status: "running",
        pendingPermissions: [{ id: "p" }],
        updatedAt: 5,
      },
    ],
  );
  assert.equal(rows[1]?.agentId, "direct");
  assert.equal(rows[1]?.stateDot, "needs_input");
  // 帯も承認待ちに揃える(点だけ橙で帯が「実装中」だと食い違う。2026-10-24 実機確認で発覚)
  assert.equal(rows[1]?.status, "ユーザー判断待ち");
  // 登録簿の行はここでは点を付けない(サーバーの配線が付ける)
  assert.equal(rows[0]?.stateDot, undefined);
});
