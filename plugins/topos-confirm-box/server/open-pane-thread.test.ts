/**
 * 「スレを開く」の主ペイン化(2026-10-27)。確認箱が `?thread=` で右に出ている状態で押すと、
 * 右に同じ相手が2枚並んでいた。確認箱のペインが同じ相手を出しているなら、右へ並べずに
 * 確認箱のペインを外して主ペインで開く。
 *
 * round2 指摘1/2: 宛先は「一覧」ではなく1件ずつ引いて確かめる(一覧は全件で重い)。畳む前に同じ相手を
 * 引き直し、引けない・閉じているなら畳まない。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openThreadInPane,
  showsSameThread,
} from "../client/open-pane-thread.js";
import type { AgentRead } from "../client/open-pane-thread.js";

const serverId = "srv"; // readAgent を必ず注入する(実デーモンへは触らない)

/** 引けたスレ(id・アーカイブ無し)。 */
const live = (id: string): AgentRead => ({
  id,
  archivedAt: null,
  status: "idle",
});
/** アーカイブ済み(開けない)。 */
const gone = (id: string): AgentRead => ({
  id,
  archivedAt: "2026-10-27T00:00:00Z",
  status: "closed",
});

/** id → 引いた結果。無いIDは「引けない」(null)。 */
const reader =
  (map: Record<string, AgentRead>) =>
  async (id: string): Promise<AgentRead> =>
    map[id] ?? null;

test("確認箱のペインが同じスレを出しているなら、右カラムは指定せず畳む", async () => {
  const calls: unknown[] = [];
  let folded = 0;
  await openThreadInPane({
    serverId,
    target: "A",
    context: { placement: "right", currentPane: { kind: "thread", id: "A" } },
    readAgent: reader({ A: live("A") }),
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(
    calls,
    [{ agentId: "A" }],
    "placement を渡さない(=主ペイン)"
  );
  assert.equal(folded, 1, "確認箱のペインを外す");
});

test("別の相手を出しているなら従来どおり右カラムに開く(畳まない)", async () => {
  const calls: unknown[] = [];
  let folded = 0;
  await openThreadInPane({
    serverId,
    target: "A",
    context: { placement: "right", currentPane: { kind: "thread", id: "B" } },
    readAgent: reader({ A: live("A") }),
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
    readAgent: reader({ A: live("A") }),
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(calls, [{ agentId: "A" }]);
  assert.equal(folded, 0);
});

test("投函元が無く次点(この欄に答えるスレ)を開くときも、ペインの相手と同じなら畳む", async () => {
  // 畳むかは URL の相手ではなく**実際に開いた宛先**で決める。ペインが親 B を出していて、開く宛先が
  // 決まらず次点の B を開くなら、右に B をもう1枚並べず主ペインにする。
  const calls: unknown[] = [];
  let folded = 0;
  await openThreadInPane({
    serverId,
    target: null,
    destination: "B",
    context: { placement: "right", currentPane: { kind: "thread", id: "B" } },
    readAgent: reader({ B: live("B") }),
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(calls, [{ agentId: "B" }]);
  assert.equal(folded, 1, "開いた宛先がペインと同じなら畳む");
});

test("カードは「同じカード」ではなく「同じ相手を出しているか」で判定する", () => {
  const card = { kind: "card", id: "c1", answerId: "A" } as const;
  assert.equal(showsSameThread(card, "A"), true);
  assert.equal(
    showsSameThread({ kind: "card", id: "c1", answerId: "B" }, "A"),
    false,
    "出している相手が別なら畳まない"
  );
  // 答えるスレが分からないカードは畳まない(「分からない」を「同じ」と取り違えない。round1 F2)。
  assert.equal(showsSameThread({ kind: "card", id: "c1" }, "A"), false);
  assert.equal(
    showsSameThread({ kind: "card", id: "c1", answerId: null }, "A"),
    false
  );
  assert.equal(showsSameThread({ kind: "thread", id: "A" }, "A"), true);
  assert.equal(showsSameThread({ kind: "thread", id: "B" }, "A"), false);
  assert.equal(showsSameThread(null, "A"), false);
  assert.equal(showsSameThread(undefined, "A"), false);
});

test("畳む直前に同じ相手を引き直し、引けない・閉じているなら畳まない(round2 指摘2)", async () => {
  let folded = 0;
  const calls: unknown[] = [];
  // 畳む前の確かめが読めない(古い表示のまま残っているかもしれない)→ 畳まずに右に開く。
  await openThreadInPane({
    serverId,
    target: "A",
    context: { placement: "right", currentPane: { kind: "thread", id: "A" } },
    readAgent: async () => null,
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(
    calls,
    [{ agentId: "A", placement: "right" }],
    "畳まず、従来どおり右カラムに開く"
  );
  assert.equal(folded, 0, "読めない相手では畳まない");
});

test("宛先がアーカイブ済みなら、題名の管轄の司令塔へ1件引いて振り替える(一覧は引かない)", async () => {
  const calls: unknown[] = [];
  const notices: string[] = [];
  const res = await openThreadInPane({
    serverId,
    target: "DEAD",
    context: {
      placement: "right",
      title: "F-80 の続き",
      domainCoordinators: { f80: "F80" },
      coordinatorId: "HUB",
    },
    readAgent: reader({
      DEAD: gone("DEAD"),
      F80: live("F80"),
      HUB: live("HUB"),
    }),
    open: async (input) => void calls.push(input),
    onNotice: (t) => notices.push(t),
  });
  assert.deepEqual(calls, [{ agentId: "F80", placement: "right" }]);
  assert.equal(res?.reason, "domain-coordinator");
  assert.equal(notices.length, 1, "振り替えた理由を1行出す");
});

test("振り替え先も全部引けないなら、宛先のまま開いて理由を1行出す(黙って飛ばさない)", async () => {
  const calls: unknown[] = [];
  let folded = 0;
  const res = await openThreadInPane({
    serverId,
    target: "DEAD",
    context: {
      placement: "right",
      currentPane: { kind: "thread", id: "DEAD" },
      coordinatorId: "HUB",
    },
    readAgent: reader({ DEAD: gone("DEAD") }),
    open: async (input) => void calls.push(input),
    onFold: () => {
      folded += 1;
    },
  });
  assert.deepEqual(calls, [{ agentId: "DEAD", placement: "right" }]);
  assert.equal(res?.reason, "no-live-thread");
  assert.equal(folded, 0);
});
