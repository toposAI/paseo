import assert from "node:assert/strict";
import test from "node:test";
import { countOpen, judgmentTabRows, type ConfirmBoxItem } from "../shared/contract.js";

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

test("バッジの件数(countOpen)と判断タブの既定の行数は常に一致する", () => {
  const items = [
    item("a"),
    item("b", { priority: "blocking" }),
    item("c", { state: "approved" }),
    item("d", { judgment: false }),
    item("e", { judgment: false, options: [{ id: "a", label: "x" } as never] }),
    item("p", { kind: "permit", judgment: false }),
    item("n", { state: "read" }),
  ];
  const rows = judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false });
  assert.equal(countOpen(items), rows.length);
  assert.equal(rows.length, 4);
});
