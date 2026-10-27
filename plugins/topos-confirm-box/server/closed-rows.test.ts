/**
 * 閉じたスレのサイドバー表示(`server/closed-rows.ts`)。
 * 中核は「待機中」で残す・終わった閉じ行と非表示 id は外す・登録簿で実装中のまま閉じた行は残す。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChildThread } from "../shared/child-threads.js";
import { displayStatus } from "../shared/thread-status-label.js";
import {
  dropFinishedClosedRows,
  readCoreWindowIds,
  readSidebarHiddenIds,
  standbyForCoreClosed,
} from "./closed-rows.js";

const A2 = "6f56a8c9-e258-4c12-a69d-d93a492038e7";
const BACKSTAGE = "f2d38a68-fe05-42aa-8555-2224926dc8c2";

function row(agentId: string, over: Partial<ChildThread> = {}): ChildThread {
  return {
    agentId,
    title: "t",
    status: "実装中",
    machineState: "closed",
    request: "",
    summaryItemId: null,
    nocard: false,
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

test("閉じた中核スレ(窓口A'・司令塔)は「終了」でなく「待機中」になる", () => {
  const out = standbyForCoreClosed(
    [
      row(A2),
      row("c0ffee00-0000-0000-0000-000000000000", { coordinator: true }),
      row("other-thread-1"),
    ],
    [A2],
  );
  assert.equal(displayStatus(out[0].status, out[0].machineState).text, "待機中");
  assert.equal(displayStatus(out[1].status, out[1].machineState).text, "待機中");
  assert.equal(displayStatus(out[2].status, out[2].machineState).text, "終了");
});

test("動いている中核スレは触らない", () => {
  const r = row(A2, { machineState: "running" });
  assert.deepEqual(standbyForCoreClosed([r], [A2])[0], r);
});

test("終わった閉じ行(完了・未登録の待機中)は外し、実装中のまま閉じた行は残す", () => {
  const out = dropFinishedClosedRows(
    [
      row("done-thread-1", { status: "完了" }),
      row("unreg-thread-1", { status: "待機中" }),
      row("stuck-thread-1", { status: "実装中" }),
      row("pinned-thread-1", { status: "完了", pinned: true }),
      row("heading-thread-1", { status: "完了", groupingParent: true }),
      row(A2, { status: "待機中" }),
      row("alive-thread-1", { status: "完了", machineState: "idle" }),
    ],
    [A2],
    [],
  );
  assert.deepEqual(
    out.map((t) => t.agentId),
    ["stuck-thread-1", "pinned-thread-1", "heading-thread-1", A2, "alive-thread-1"],
  );
});

test("非表示 id は状態に関わらず外す(短縮形も効く)", () => {
  const out = dropFinishedClosedRows(
    [row(BACKSTAGE, { machineState: "running" }), row("keep-thread-1", { machineState: "idle" })],
    [],
    ["f2d38a68"],
  );
  assert.deepEqual(
    out.map((t) => t.agentId),
    ["keep-thread-1"],
  );
});

test("id ファイルを読む(コメント・壊れた値は無視、無ければ空)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "closed-rows-"));
  fs.mkdirSync(path.join(dir, "judgment_window", "windows"), { recursive: true });
  fs.writeFileSync(path.join(dir, "judgment_window", "windows", "A2.id"), A2 + "\n");
  fs.writeFileSync(path.join(dir, "judgment_window", "windows", "bad.id"), "../x\n");
  fs.writeFileSync(
    path.join(dir, "sidebar_hidden_agent_ids.txt"),
    `# c\n${BACKSTAGE} # 裏方1\n../x\n`,
  );
  assert.deepEqual(readCoreWindowIds(dir), [A2]);
  assert.deepEqual(readSidebarHiddenIds(dir), [BACKSTAGE]);
  assert.deepEqual(readSidebarHiddenIds(path.join(dir, "none")), []);
});
