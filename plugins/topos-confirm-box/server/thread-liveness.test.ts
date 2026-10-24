import assert from "node:assert/strict";
import { test } from "node:test";

import { applyThreadAccess, threadAccessById } from "./thread-liveness.js";
import { blockedMessage } from "../shared/child-threads.js";
import type { ChildThread } from "../shared/child-threads.js";

function thread(overrides: Partial<ChildThread>): ChildThread {
  return {
    agentId: "a",
    title: "t",
    status: "実装中",
    machineState: null,
    request: "",
    summaryItemId: null,
    summary: null,
    summaryState: null,
    summaryAcked: false,
    updatedAt: 0,
    parentAgentId: null,
    parentTitle: null,
    pinned: false,
    coordinator: false,
    parentOpenable: false,
    access: null,
    ...overrides,
  };
}

test("生きたワークスペースのスレは open、閉じたものは workspace-archived", () => {
  const access = threadAccessById(
    [
      { id: "a", workspaceId: "w-live" },
      { id: "b", workspaceId: "w-arch" },
    ],
    [{ workspaceId: "w-live" }, { workspaceId: "w-arch", archivedAt: "2026-10-23T00:00:00Z" }],
  );
  assert.equal(access.get("a"), "open");
  assert.equal(access.get("b"), "workspace-archived");
});

test("スレ自身のアーカイブはワークスペースより優先する", () => {
  const access = threadAccessById(
    [{ id: "a", workspaceId: "w-live", archivedAt: "2026-10-23T00:00:00Z" }],
    [{ workspaceId: "w-live" }],
  );
  assert.equal(access.get("a"), "thread-archived");
});

test("ワークスペースの記録が無い/IDが空なら印を付けない(不明を『開けない』と言い換えない)", () => {
  const access = threadAccessById(
    [{ id: "a", workspaceId: "unknown" }, { id: "b" }],
    [{ workspaceId: "w-live" }],
  );
  assert.equal(access.get("a"), "open");
  assert.equal(access.get("b"), "open");
});

test("同じワークスペースに生きている記録が1つでもあれば開ける", () => {
  const access = threadAccessById(
    [{ id: "a", workspaceId: "w" }],
    [{ workspaceId: "w", archivedAt: "2026-10-23T00:00:00Z" }, { workspaceId: "w" }],
  );
  assert.equal(access.get("a"), "open");
});

test("印を付けるのは判定にある行だけ(それ以外は null=不明のまま)", () => {
  const rows = applyThreadAccess(
    [thread({ agentId: "a" }), thread({ agentId: "b" })],
    new Map([["a", "workspace-archived" as const]]),
  );
  assert.equal(rows[0].access, "workspace-archived");
  assert.equal(rows[1].access, null);
});

test("開けない理由は開けない印のときだけ返す", () => {
  assert.equal(blockedMessage("open"), null);
  assert.equal(blockedMessage(null), null);
  assert.match(blockedMessage("workspace-archived") ?? "", /アーカイブ済み/);
  assert.match(blockedMessage("thread-archived") ?? "", /アーカイブ済み/);
});

// 出口レビュー round2 指摘2: 本番の呼び出しは生存ワークスペースの id しか渡さないので、
// `workspace-archived` は付かない(既知の残差)。この写しは「本番の形」を固定する。
test("本番の形(生存idのみ)では workspace-archived が付かない(既知の残差)", () => {
  const access = threadAccessById(
    [{ id: "a", workspaceId: "w-gone" }],
    [{ workspaceId: "w-live" }],
  );
  assert.equal(access.get("a"), "open");
});

// 出口レビュー round3 指摘4: 背景のスレを「不明」にする処置は、元から `open` と同じ表示で
// 効果が無かったため外した。背景のスレは「全 id」に居ないので `open` になる(既知の残差)ことも固定する。
test("背景のスレ(ワークスペースが引けない)は open のまま(既知の残差。表示は変えない)", () => {
  const access = threadAccessById(
    [
      { id: "bg", workspaceId: "w-background" },
      { id: "no-ws", workspaceId: "" },
      { id: "live", workspaceId: "w-live" },
    ],
    [{ workspaceId: "w-live" }],
  );
  assert.equal(access.get("bg"), "open");
  assert.equal(access.get("no-ws"), "open");
  assert.equal(access.get("live"), "open");
});
