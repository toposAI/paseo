import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_PAGE_LIMIT, listAllAgents } from "./agent-pages.js";
import type { AgentPage, AgentPageQuery } from "./agent-pages.js";

const page = (ids: string[], next?: string): AgentPage => ({
  entries: ids.map((id) => ({ agent: { id } })),
  pageInfo: next ? { nextCursor: next } : {},
});

test("全ページを辿る(続きのカーソルが無くなるまで。背景は既定で含めない)", async () => {
  const queries: (AgentPageQuery | undefined)[] = [];
  const res = await listAllAgents({
    async list(q) {
      queries.push(q);
      if (!q?.page?.cursor) return page(["a"], "c1");
      return page(["b", "c"]);
    },
  });
  assert.deepEqual(
    res.agents.map((a) => a.id),
    ["a", "b", "c"],
  );
  assert.equal(res.truncated, false);
  assert.equal(res.backgroundDropped, false);
  assert.equal(queries.length, 2);
  // アーカイブ済みは要求しない(増え続ける履歴で頁数の上限に当たらないため)
  assert.equal(queries[0]?.filter, undefined);
});

test("アーカイブ済みを含める指定は、背景の指定が無くてもフィルタに載る", async () => {
  // 行の取り込みは「背景を含めず・アーカイブ済みは含めて」引く(閉じたスレを弾く側で落とすため)。
  const queries: (AgentPageQuery | undefined)[] = [];
  await listAllAgents(
    {
      async list(q) {
        queries.push(q);
        return page(["a"]);
      },
    },
    { includeArchived: true },
  );
  assert.deepEqual(queries[0]?.filter, { includeArchived: true });
});

test("背景込みを頼んだら背景込みで引く", async () => {
  const res = await listAllAgents(
    {
      async list() {
        return page(["a"]);
      },
    },
    { includeBackground: true },
  );
  assert.deepEqual(
    res.agents.map((a) => a.id),
    ["a"],
  );
  assert.equal(res.backgroundDropped, false);
});

// 出口レビュー round3 指摘2: 古いホストは背景込みの取得を送信前に同期で断る
// (`requireBackgroundWorkspaces`)。そのときは最初から背景無しで引き直す(頁を混ぜない)。
test("背景込みを断られたら、背景無しで最初から引き直す(途中の頁を混ぜない)", async () => {
  const calls: (AgentPageQuery | undefined)[] = [];
  const res = await listAllAgents(
    {
      async list(q) {
        calls.push(q);
        if (q?.filter?.includeBackground)
          throw new Error("Update the host to use background workspaces.");
        if (!q?.page?.cursor) return page(["x"], "c1");
        return page(["y", "z"]);
      },
    },
    { includeBackground: true },
  );
  assert.deepEqual(
    res.agents.map((a) => a.id),
    ["x", "y", "z"],
  );
  assert.equal(res.backgroundDropped, true);
  assert.equal(res.truncated, false);
  // 背景込みの1回 + 背景無しの2頁
  assert.equal(calls.length, 3);
});

test("2ページ目で失敗したら、集めた分を truncated で返す(例外にしない)", async () => {
  let n = 0;
  const res = await listAllAgents({
    async list() {
      n += 1;
      if (n === 1) return page(["a"], "c1");
      throw new Error("timeout");
    },
  });
  assert.deepEqual(
    res.agents.map((a) => a.id),
    ["a"],
  );
  assert.equal(res.truncated, true);
});

test("1ページ目が失敗したら例外(一覧そのものが引けない)", async () => {
  await assert.rejects(
    listAllAgents({
      async list() {
        throw new Error("boom");
      },
    }),
  );
});

test("頁数の上限に達したら truncated(例外的にカーソルが永遠に続く)", async () => {
  let n = 0;
  const res = await listAllAgents({
    async list() {
      n += 1;
      return page([`a${n}`], `c${n}`);
    },
  });
  assert.equal(n, AGENT_PAGE_LIMIT);
  assert.equal(res.agents.length, AGENT_PAGE_LIMIT);
  assert.equal(res.truncated, true);
});
