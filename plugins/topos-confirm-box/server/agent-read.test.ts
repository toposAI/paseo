/**
 * スレの状態を「読むだけ」で取る(2026-11-01 ユーザー報告「手動でアーカイブしたスレが画面を開くだけで復活する」)。
 *
 * サーバー側の意味は使い捨て home の実デーモンで確かめた(`client/agent-read.ts` の表):
 * `fetch_agent_request`(`agents.ref(id).refresh()`)は記録を読むだけで**解除しない**。
 * 解除するのは `refresh_agent_request`(`refreshAgent` = `paseo agent reload`)と
 * `send_agent_message`(`send`)/`resume`/`update`。
 *
 * このテストが固定するのは「読むだけの関数が、解除を起こす API を呼ばない」こと。
 * 将来ここを `refreshAgent` や `send` に差し替えると、画面を開いただけでアーカイブが解ける側へ戻る。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { agentStateOf, readAgentState } from "../client/agent-read.js";
import type { AgentStateClient } from "../client/agent-read.js";

/** アーカイブ済みのスレ1件(実デーモンで観測した形のまま)。 */
const ARCHIVED = {
  id: "bb27f31b",
  status: "idle",
  workspaceId: "ws-1",
  archivedAt: "2026-11-01T12:27:33.000Z",
};

/**
 * 実サーバーの意味を写した偽クライアント。
 * - `refresh()` = `fetch_agent_request` … 記録を返すだけ(解除しない)
 * - それ以外の書き込み系 … 呼ばれたら数える(= 読むだけの経路が使ってはいけない)
 */
function fakeClient(agent: unknown) {
  const calls: string[] = [];
  const client = {
    agents: {
      ref(id: string) {
        return {
          refresh: async () => {
            calls.push(`refresh:${id}`);
            return agent === undefined ? null : { agent };
          },
          // 実クライアントには在るが、読むだけの経路からは呼ばれないこと。
          send: async () => {
            calls.push(`send:${id}`);
            return null;
          },
          resume: async () => {
            calls.push(`resume:${id}`);
            return null;
          },
          update: async () => {
            calls.push(`update:${id}`);
            return null;
          },
        };
      },
    },
    refreshAgent: async (id: string) => {
      calls.push(`refreshAgent:${id}`);
      return null;
    },
  };
  return { client: client as unknown as AgentStateClient, calls };
}

test("アーカイブ済みのスレを読んでも、解除を起こす API を呼ばない", async () => {
  const { client, calls } = fakeClient(ARCHIVED);
  const state = await readAgentState(client, "bb27f31b");
  assert.deepEqual(state, {
    archivedAt: "2026-11-01T12:27:33.000Z",
    status: "idle",
    workspaceId: "ws-1",
  });
  assert.deepEqual(
    calls,
    ["refresh:bb27f31b"],
    "読むだけの経路は fetch_agent_request だけを使う(解除する呼び方をしない)",
  );
});

test("生きているスレの読み方は今までどおり(archivedAt は null)", async () => {
  const { client, calls } = fakeClient({ ...ARCHIVED, archivedAt: null });
  const state = await readAgentState(client, "live");
  assert.equal(state?.archivedAt, null);
  assert.deepEqual(calls, ["refresh:live"]);
});

test("引けないときは null(「分からない」を「閉じている」と言い換えない)", async () => {
  const { client } = fakeClient(undefined);
  assert.equal(await readAgentState(client, "gone"), null);
});

test("状態の項目が欠けていても落ちない(欠けは null)", () => {
  assert.deepEqual(agentStateOf({ agent: { id: "a" } }), {
    archivedAt: null,
    status: null,
    workspaceId: null,
  });
  assert.equal(agentStateOf(null), null);
  assert.equal(agentStateOf({ agent: null }), null);
});

test("アーカイブ時刻が文字列でなくても「生きている」へ倒さない", () => {
  // 文字列でない値を null に畳むと、アーカイブ済みの相手へ送信できてしまい、その送信で解除される。
  const state = agentStateOf({
    agent: { archivedAt: new Date("2026-11-01T00:00:00Z"), status: "closed" },
  });
  assert.notEqual(state?.archivedAt, null, "null/undefined 以外はアーカイブ済みとして残す");
  assert.equal(state?.status, "closed");
});

/** ソースからコメントを落とす(表や説明に API 名が出てくるため)。 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

test("読むだけの関数のソースに、解除を起こす呼び方が無い", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(dir, "..", "client", "agent-read.ts"), "utf8");
  const code = withoutComments(src);
  for (const forbidden of ["refreshAgent", ".send(", ".resume(", ".update("]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `${forbidden} は解除を起こす。読むだけの経路に足さない`,
    );
  }
});

test("クライアント全体で、解除を起こす呼び方が意図した箇所だけに残っている", () => {
  // 退行が起きるのは `agent-read.ts` ではなく呼び出し側。`client/**` を走査して固定する
  // (2026-11-01 出口レビュー指摘4)。送信箇所を足すときは、下の許可リストに理由つきで足すこと。
  const allowedSend = new Set(["ChatDock.tsx", "CardChatPane.tsx"]); // ユーザーが押した送信
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length > 10, "クライアントのソースを読めている");
  const offenders: string[] = [];
  for (const file of files) {
    const code = withoutComments(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const token of ["refreshAgent(", ".resume(", ".update("]) {
      if (code.includes(token)) offenders.push(`${file}: ${token}`);
    }
    const name = path.basename(file);
    if (code.includes(".send(") && !allowedSend.has(name)) {
      offenders.push(`${file}: .send(`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "解除を起こす呼び方は、読むだけの経路に置かない(送信はユーザー操作の2箇所だけ)",
  );
});
