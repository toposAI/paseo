import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyAuxGroup, readChildThreadSides, writeChildThreadSide } from "./child-sides.js";
import { CHILD_THREAD_SIDES_FILE } from "../shared/child-threads.js";
import type { ChildThread } from "../shared/child-threads.js";
import { groupThreadRowsBySide, sideOfThread } from "../shared/sidebar-rows.js";
import type { SidebarRowView } from "../shared/sidebar-rows.js";
import { sideMenuLabel, nextMenu, OPEN_MENU } from "../shared/thread-menu.js";

function thread(overrides: Partial<ChildThread>): ChildThread {
  return {
    agentId: "a",
    title: "t",
    status: "実装中",
    machineState: null,
    request: "",
    summaryItemId: null,
    nocard: false,
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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sides-"));

test("自動判定: 登録簿の行=補助、登録簿に無い人が建てたスレ=壁打ち、司令塔と見出しの親は常に補助", () => {
  const rows = applyAuxGroup(
    [
      thread({ agentId: "reg", parentAgentId: "p", parentTitle: "P" }),
      thread({ agentId: "mine" }),
      thread({ agentId: "co", coordinator: true }),
      thread({ agentId: "head", groupingParent: true }),
    ],
    new Set(["reg", "head"]),
    new Map(),
  );
  const side = Object.fromEntries(rows.map((t) => [t.agentId, sideOfThread(t)]));
  assert.deepEqual(side, { reg: "aux", mine: "walltalk", co: "aux", head: "aux" });
  assert.equal(rows[0]?.parentAgentId, "p");
});

test("手動指定は自動判定より優先し、壁打ちへ移した行は親の印を外す。司令塔は動かせない", () => {
  const rows = applyAuxGroup(
    [
      thread({ agentId: "reg", parentAgentId: "p", parentTitle: "P" }),
      thread({ agentId: "mine" }),
      thread({ agentId: "co", coordinator: true }),
    ],
    new Set(["reg"]),
    new Map([
      ["reg", "walltalk"],
      ["mine", "aux"],
      ["co", "walltalk"],
    ] as const),
  );
  assert.equal(sideOfThread(rows[0]!), "walltalk");
  assert.equal(rows[0]?.parentAgentId, null);
  assert.equal(rows[0]?.parentTitle, null);
  assert.equal(sideOfThread(rows[1]!), "aux");
  assert.equal(sideOfThread(rows[2]!), "aux");
});

test("振り分けの保存: 書く→読める、null で自動へ戻る、壊れたファイルは空", () => {
  const dir = tmp();
  assert.equal(readChildThreadSides(dir).size, 0);
  writeChildThreadSide(dir, "x", "aux");
  writeChildThreadSide(dir, "y", "walltalk");
  assert.deepEqual(
    [...readChildThreadSides(dir)],
    [
      ["x", "aux"],
      ["y", "walltalk"],
    ],
  );
  writeChildThreadSide(dir, "x", null);
  assert.deepEqual([...readChildThreadSides(dir).keys()], ["y"]);
  assert.throws(() => writeChildThreadSide(dir, "", "aux"));
  fs.writeFileSync(path.join(dir, CHILD_THREAD_SIDES_FILE), "{broken");
  assert.equal(readChildThreadSides(dir).size, 0);
  fs.writeFileSync(
    path.join(dir, CHILD_THREAD_SIDES_FILE),
    JSON.stringify({ sides: { a: "aux", b: "bogus" } }),
  );
  assert.deepEqual([...readChildThreadSides(dir)], [["a", "aux"]]);
});

const rowOf = (
  t: ChildThread,
  statusLabel: SidebarRowView<ChildThread>["statusLabel"] = "実装中",
) => ({ thread: t, statusLabel, title: t.title }) as unknown as SidebarRowView<ChildThread>;

test("2群へ分ける: 壁打ちの親なしは見出し無し(キー空)、補助側の判断待ちを数える", () => {
  const sides = groupThreadRowsBySide(
    [
      rowOf(thread({ agentId: "mine", aux: false })),
      rowOf(thread({ agentId: "r1", aux: true, parentAgentId: "p", parentTitle: "P" }), "判断待ち"),
      rowOf(thread({ agentId: "r2", aux: true, parentAgentId: "p", parentTitle: "P" })),
      rowOf(thread({ agentId: "orphan", aux: true })),
    ],
    new Set(),
    "__c",
    "__p",
    "ピン止め",
    "",
  );
  assert.deepEqual(
    sides.walltalk.map((g) => [g.key, g.rows.length]),
    [["", 1]],
  );
  assert.deepEqual(
    sides.aux.map((g) => [g.key, g.rows.length]),
    [
      ["p", 2],
      ["", 1],
    ],
  );
  assert.equal(sides.auxWaiting, 1);
});

test("メニュー: 移動項目の文言と遷移(司令塔・見出しの親には出さない)", () => {
  assert.equal(sideMenuLabel({ aux: false }), "補助スレへ移す");
  assert.equal(sideMenuLabel({}), "補助スレへ移す");
  assert.equal(sideMenuLabel({ aux: true }), "壁打ちへ戻す");
  assert.equal(sideMenuLabel({ coordinator: true }), null);
  assert.equal(sideMenuLabel({ groupingParent: true, aux: true }), null);
  assert.equal(nextMenu(OPEN_MENU, "toggle-side").intent, "toggle-side");
  assert.equal(nextMenu(OPEN_MENU, "toggle-side").state.open, false);
  assert.equal(nextMenu({ open: false, confirmingArchive: false }, "toggle-side").intent, null);
});

test("承認待ち(needs_input)・失敗の点も補助スレの要対応件数に数える", () => {
  const sides = groupThreadRowsBySide(
    [
      rowOf(thread({ agentId: "x1", aux: true, stateDot: "needs_input" })),
      rowOf(thread({ agentId: "x2", aux: true, stateDot: "failed" })),
      rowOf(thread({ agentId: "x3", aux: true, stateDot: "running" })),
    ],
    new Set(),
    "__c",
    "__p",
    "ピン止め",
    "",
  );
  assert.equal(sides.auxWaiting, 2);
});

test("壊れた保存ファイルは上書き前に退避する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sides-corrupt-"));
  fs.writeFileSync(path.join(dir, CHILD_THREAD_SIDES_FILE), "{not json", "utf8");
  writeChildThreadSide(dir, "a", "aux");
  assert.ok(fs.readdirSync(dir).some((f) => f.includes(".corrupt-")));
  assert.equal(readChildThreadSides(dir).get("a"), "aux");
});
