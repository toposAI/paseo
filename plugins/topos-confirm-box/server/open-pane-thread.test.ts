/**
 * 「スレを開く」の主ペイン化(2026-10-27)。確認箱が `?thread=` で右に出ている状態で押すと、
 * 右に同じ相手が2枚並んでいた。確認箱のペインが同じ相手を出しているなら、右へ並べずに
 * 確認箱のペインを外して主ペインで開く。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openThreadInPane, showsSameThread } from "../client/open-pane-thread.js";

const serverId = ""; // 接続先が無い=一覧を引かずに決まった宛先をそのまま開く経路(判定だけを見るため)

test("確認箱のペインが同じスレを出しているなら、右カラムは指定せず畳む", async () => {
  const calls: unknown[] = [];
  let folded = 0;
  await openThreadInPane({
    serverId,
    target: "A",
    context: { placement: "right", currentPane: { kind: "thread", id: "A" } },
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(calls, [{ agentId: "A" }], "placement を渡さない(=主ペイン)");
  assert.equal(folded, 1, "確認箱のペインを外す");
});

test("別の相手を出しているなら従来どおり右カラムに開く(畳まない)", async () => {
  const calls: unknown[] = [];
  let folded = 0;
  await openThreadInPane({
    serverId,
    target: "A",
    context: { placement: "right", currentPane: { kind: "thread", id: "B" } },
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(calls, [{ agentId: "A", placement: "right" }]);
  assert.equal(folded, 0);
});

test("狭い幅(右カラム指定なし)では畳む判定をしない", async () => {
  const calls: unknown[] = [];
  let folded = 0;
  await openThreadInPane({
    serverId,
    target: "A",
    context: { currentPane: { kind: "thread", id: "A" } },
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(calls, [{ agentId: "A" }]);
  assert.equal(folded, 0);
});

test("カードは「同じカード」ではなく「同じ相手を出しているか」で判定する", () => {
  const card = { kind: "card", id: "c1" } as const;
  assert.equal(showsSameThread(card, "A", "A"), true);
  assert.equal(showsSameThread(card, "A", "B"), false, "答えの宛先が別スレなら畳まない");
  assert.equal(showsSameThread({ kind: "thread", id: "A" }, "A"), true);
  assert.equal(showsSameThread({ kind: "thread", id: "B" }, "A"), false);
  assert.equal(showsSameThread(null, "A"), false);
  assert.equal(showsSameThread(undefined, "A"), false);
});
