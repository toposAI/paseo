/**
 * スレの状態を**読むだけ**で取る(アーカイブを解かない読み方)。
 *
 * なぜ要るか(2026-11-01 ユーザー報告「手動でアーカイブしたスレが画面を開くだけで復活する」):
 * 確認箱は「そのスレを開けるか」「まだ生きているか」を知るためだけに
 * `agents.ref(id).refresh()` を呼んでいた。Paseo の**書き込み系**はアーカイブ済みのスレを
 * 開き直す(サーバー側で無条件に `unarchiveAgentState` を呼ぶ)ので、読み取りのつもりの呼び方でも
 * 解除が起きうる、と疑われた。
 *
 * 使い捨て home の実デーモンで確かめた結果(2026-11-01、`packages/server` の一時検証):
 *
 * | 呼び方 | 送られる要求 | アーカイブ済みを解除するか |
 * |---|---|---|
 * | `agents.ref(id).refresh()` / `fetchAgent()` | `fetch_agent_request` → `handleFetchAgent` | **解除しない**(記録を読むだけ) |
 * | `agents.ref(id).timeline.refetch()` | `fetch_agent_timeline_request` | 解除しない(ただしスレを**読み込む**) |
 * | `client.refreshAgent(id)`(`paseo agent reload`) | `refresh_agent_request` → `handleRefreshAgentRequest` | **解除する** |
 * | `agents.ref(id).send()` / `resume` / `update` | `send_agent_message` など | 解除する(意図した操作) |
 *
 * つまり**状態を見るだけの場面で使ってよいのは `refresh()`**。`timeline.refetch()` も解除はしないが、
 * 未読込のスレを provider セッションごと起こすので、状態を見るだけの用途には重すぎる
 * (アーカイブ済みなら `purpose: "history"` の読み込みが走る)。
 *
 * 読み取りをこの1関数に集めておくのは、将来ここを `refreshAgent`(= `paseo agent reload`)や
 * `send` に差し替えると**画面を開いただけで解除される**側へ戻るため。`server/agent-read.test.ts` が
 * 「読むだけの関数が解除を起こす API を呼ばない」ことを固定する。
 */
import { getPaseoClient } from "@getpaseo/plugin/client";

/** 読み手が要る分だけの状態。`null` の項目は「分からない」。 */
export interface AgentStateRead {
  /** アーカイブ済みなら ISO 文字列。生きていれば null。 */
  archivedAt: string | null;
  /** `idle`/`running`/`closed` など。 */
  status: string | null;
  /** そのスレのワークスペース。 */
  workspaceId: string | null;
}

/**
 * 読む所だけを持たせたクライアント(テストで差し替えるため)。
 * `refresh()` 以外を足さないこと — 足した瞬間に「読むだけ」でなくなる。
 */
export interface AgentStateClient {
  agents: {
    ref(agentId: string): {
      refresh(): Promise<{ agent?: unknown } | null>;
    };
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * アーカイブ時刻は「null/undefined 以外はすべてアーカイブ済み」として残す(2026-11-01 出口レビュー指摘3)。
 * 文字列でない値を null(=生きている)へ畳むと、`ChatDock`/`CardChatPane` が**アーカイブ済みの相手へ
 * 送信できてしまい、その送信で解除される**(`send_agent_message` は解除する)。読み取り側は
 * 「分からない」を「生きている」に倒さない。
 */
const archivedAtOf = (v: unknown): string | null => {
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
};

/** `fetch_agent_response`(または `refresh()` の戻り)から状態だけ取り出す。読めなければ null。 */
export function agentStateOf(snapshot: unknown): AgentStateRead | null {
  const agent = (snapshot as { agent?: unknown } | null | undefined)?.agent as
    | { archivedAt?: unknown; status?: unknown; workspaceId?: unknown }
    | undefined;
  if (!agent) return null;
  return {
    archivedAt: archivedAtOf(agent.archivedAt),
    status: str(agent.status),
    workspaceId: str(agent.workspaceId),
  };
}

/** 状態を1件読む。引けなければ null(「分からない」を「閉じている」と言い換えない)。 */
export async function readAgentState(
  client: AgentStateClient,
  agentId: string,
): Promise<AgentStateRead | null> {
  return agentStateOf(await client.agents.ref(agentId).refresh());
}

/** 接続先のクライアントを引いて状態を1件読む。同期の例外も Promise の失敗に揃える。 */
export async function readAgentStateOn(
  serverId: string,
  agentId: string,
): Promise<AgentStateRead | null> {
  return readAgentState(getPaseoClient(serverId), agentId);
}
