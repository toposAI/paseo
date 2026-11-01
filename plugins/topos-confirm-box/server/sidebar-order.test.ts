/**
 * ピン止めの並び順が「保存順のとおり」に出るための回帰ガード(2026-11-01)。
 *
 * ユーザー報告「新しい判断窓口Aがピン止めの一番下に固定されている。一番上にしたい。
 * ドラッグで動くけど一番下に戻ってしまう」に対して、原因は2つあった:
 *
 * 1. 判断窓口Aは判断カードの子スレを持つので `groupingParent`(子を持つ親)になる。
 *    上段の組み立て(`buildUpperRows`)が**親の行を一律に末尾へ回して**いたため、保存順で
 *    先頭に置いても表示は末尾へ戻っていた(ピン止めした親は見出しにならないので回す理由が無い)。
 * 2. 乗り換えで新しくなった agent id は保存済みの並び(`child_threads_order.json`)に無く、
 *    `applyChildThreadOrder` は**保存に無い id を末尾へ**置くので、乗り換え直後は必ず一番下に出る。
 *    → 役(`judgment_window/windows/A.id`)で先頭へ寄せる(`hoistRowsToTop`)。
 *
 * ここは純粋関数だけを検査する(描画は実機確認)。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyChildThreadOrder } from "./child-threads.js";
import type { ChildThread } from "../shared/child-threads.js";
import { buildUpperRows } from "../shared/sidebar-rows.js";
import { hoistRowsToTop, readSidebarTopAgentIds } from "./closed-rows.js";

const A = "e4f13248-e503-4aa7-ac67-a8773fcde25e"; // 判断窓口A(役A)
const A2 = "6f56a8c9-e258-4c12-a69d-d93a492038e7";
const CHILD = "1a0b7f26-8f0f-4a5e-9f5e-1f0e6f3a2b11";
const OTHER = "b85c9940-1fc0-499e-9beb-1824de53687c";

function row(agentId: string, over: Partial<ChildThread> = {}): ChildThread {
  return {
    agentId,
    title: agentId.slice(0, 8),
    status: "実装中",
    machineState: "idle",
    request: "",
    summaryItemId: null,
    nocard: false,
    summary: null,
    summaryState: null,
    summaryAcked: false,
    updatedAt: 1,
    parentAgentId: null,
    parentTitle: null,
    pinned: true,
    coordinator: false,
    parentOpenable: false,
    access: "open",
    ...over,
  };
}

function ids(rows: readonly { agentId: string }[]): string[] {
  return rows.map((r) => r.agentId);
}

/** `buildUpperRows` の出力(行ビュー)から id を取る。 */
function viewIds(rows: readonly { thread: { agentId: string } }[]): string[] {
  return rows.map((r) => r.thread.agentId);
}

test("ピン止めした親の行は末尾へ回さない(回すと保存順で先頭に置いても表示が末尾へ戻る)", () => {
  const rows = buildUpperRows(
    [row(A, { groupingParent: true } as Partial<ChildThread>), row(A2), row(OTHER)] as never,
    new Map() as never,
  );
  assert.deepEqual(viewIds(rows), [A, A2, OTHER]);
});

test("ピン止めしていない親の行は従来どおり末尾へ(子の見出しとして使う)", () => {
  const rows = buildUpperRows(
    [
      row(A, { groupingParent: true, pinned: false } as Partial<ChildThread>),
      row(A2, { pinned: false }),
      row(OTHER, { pinned: false }),
    ] as never,
    new Map() as never,
  );
  assert.deepEqual(viewIds(rows), [A2, OTHER, A]);
});

test("乗り換え直後の新しい id は保存順に無いので末尾に落ちる(前提の確認)", () => {
  const threads = [row(A2), row(OTHER), row(A), row(CHILD, { parentAgentId: A })];
  const ordered = applyChildThreadOrder(threads, [A2, OTHER, CHILD]);
  assert.deepEqual(ids(ordered), [A2, OTHER, CHILD, A], "保存に無い A は末尾");
});

test("役で引いた id を先頭へ寄せる(乗り換えで id が変わっても同じ場所に来る)", () => {
  const threads = [row(A2), row(OTHER), row(A), row(CHILD, { parentAgentId: A })];
  const ordered = applyChildThreadOrder(threads, [A2, OTHER, CHILD]);
  const hoisted = hoistRowsToTop(ordered, [A]);
  assert.equal(hoisted[0].agentId, A);
  assert.deepEqual(ids(hoisted), [A, A2, OTHER, CHILD], "残りの相対順は変えない");
});

test("hoistRowsToTop は該当が無い/空なら並びを変えない", () => {
  const rows = [row(A2), row(OTHER)];
  assert.deepEqual(ids(hoistRowsToTop(rows, [])), [A2, OTHER]);
  assert.deepEqual(ids(hoistRowsToTop(rows, [A])), [A2, OTHER]);
  assert.deepEqual(ids(hoistRowsToTop([], [A])), []);
});

test("保存順に居る行は先頭へ寄せない(ドラッグした位置を上書きしない)", () => {
  const ordered = [row(A2), row(A), row(OTHER)];
  const hoisted = hoistRowsToTop(ordered, [A], [A2, A, OTHER]);
  assert.deepEqual(ids(hoisted), [A2, A, OTHER], "保存順で3番目ならそのまま3番目");
});

test("保存順に居ても、他の固定 id は寄せる(乗り換えで増えた分だけ先頭へ)", () => {
  const ordered = [row(A2), row(A), row(OTHER)];
  const hoisted = hoistRowsToTop(ordered, [A, A2], [A2, A]);
  assert.deepEqual(ids(hoisted), [A2, A, OTHER], "両方とも保存順に居るので動かさない");
  const mixed = hoistRowsToTop([row(OTHER), row(A), row(A2)], [A, A2], [OTHER, A2]);
  assert.deepEqual(ids(mixed), [A, OTHER, A2], "A だけが保存順に無いので A だけ先頭");
});

test("先頭固定の id は役のファイルから引く(A.id と sidebar_top_agent_ids.txt)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-top-"));
  assert.deepEqual(readSidebarTopAgentIds(dir), [], "登録が無ければ空(勝手に固定しない)");
  fs.mkdirSync(path.join(dir, "judgment_window", "windows"), { recursive: true });
  fs.writeFileSync(path.join(dir, "judgment_window", "windows", "A.id"), `${A}\n`);
  fs.writeFileSync(path.join(dir, "sidebar_top_agent_ids.txt"), `# 追加の固定\n${OTHER}\n`);
  assert.deepEqual(readSidebarTopAgentIds(dir), [A, OTHER]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("一覧の組み立てが hoistRowsToTop を通す(配線の回帰)", () => {
  const source = fs.readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(source, /hoistRowsToTop\(threads, readSidebarTopAgentIds\(\), savedOrder\)/);
});
