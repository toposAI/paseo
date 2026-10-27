import assert from "node:assert/strict";
import test from "node:test";
import { countOpen, judgmentTabRows, type ConfirmBoxItem } from "../shared/contract.js";
import { countJudgmentOpen } from "../shared/judgment-open.js";

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
    // 既読=材料待ち相当。判断窓口の open ではないので、バッジにも判断タブにも出さない(2026-10-27)
    item("n", { state: "read" }),
  ];
  const rows = judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false });
  assert.equal(countOpen(items), rows.length);
  assert.equal(countJudgmentOpen(items), countOpen(items));
  // a・b・p の3件だけ(approved・read・印なしは数えない)
  assert.equal(rows.length, 3);
});

test("バッジの件数は判断窓口の open 件数と同じ(材料待ち・承認済み・既読を足さない)", () => {
  const items = [
    item("open-1"),
    item("open-2", { priority: "blocking" }),
    item("approve", { state: "approved" }),
    item("read-1", { state: "read" }),
    item("notice", { judgment: false, options: [] }),
  ];
  assert.equal(countJudgmentOpen(items), 2);
  // 判断タブ(既定の絞り込み)の行数と揃う
  assert.equal(
    judgmentTabRows(items, { showDone: false, prio: null, newestFirst: false }).length,
    2,
  );
  // 決定済みを出す設定でもバッジの数は変わらない(バッジは open だけ)
  assert.equal(countJudgmentOpen(items), 2);
});
