import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { adoptOrphans, coordinatorRows, readCoordinatorIds } from "./coordinator-threads.js";
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
    ...overrides,
  };
}

test("司令塔の一覧は領域ごとに読み、cid の無い/壊れた領域は飛ばす", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-"));
  const id = "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49";
  fs.mkdirSync(path.join(dir, "domains", "general"), { recursive: true });
  fs.writeFileSync(path.join(dir, "domains", "general", "coordinator_id"), `${id}\n`);
  fs.mkdirSync(path.join(dir, "domains", "empty"), { recursive: true });
  fs.mkdirSync(path.join(dir, "domains", "bad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "domains", "bad", "coordinator_id"), "../../etc/passwd");
  assert.deepEqual(readCoordinatorIds(dir), [id]);
});

test("状態ディレクトリが無くても空で返す(一覧を止めない)", () => {
  assert.deepEqual(readCoordinatorIds(path.join(os.tmpdir(), "no-such-dir-xyz")), []);
});

test("司令塔の行は一覧に居るものだけ・登録簿に既に居るものは除く", () => {
  const rows = coordinatorRows(
    ["c1", "c2", "c3"],
    [
      { id: "c1", title: "総司令塔", status: "idle" },
      { id: "c2", title: "Paseo UI", status: "running" },
    ],
    [thread({ agentId: "c2" })],
  );
  assert.deepEqual(
    rows.map((r) => [r.agentId, r.title, r.machineState, r.coordinator]),
    [["c1", "総司令塔", "idle", true]],
  );
});

test("親なしの子スレは、司令塔が1本だけならその下に寄せる", () => {
  const rows = adoptOrphans([
    thread({ agentId: "c1", coordinator: true }),
    thread({ agentId: "kid", parentAgentId: null }),
    thread({ agentId: "kid2", parentAgentId: "c1" }),
  ]);
  assert.equal(rows[1].parentAgentId, "c1");
  assert.equal(rows[1].parentTitle, "t");
  assert.equal(rows[2].parentAgentId, "c1");
});

test("司令塔が複数/ゼロなら親なしの子スレを推測で付け替えない", () => {
  const two = adoptOrphans([
    thread({ agentId: "c1", coordinator: true }),
    thread({ agentId: "c2", coordinator: true }),
    thread({ agentId: "kid" }),
  ]);
  assert.equal(two[2].parentAgentId, null);
  const none = adoptOrphans([thread({ agentId: "kid" })]);
  assert.equal(none[0].parentAgentId, null);
});
