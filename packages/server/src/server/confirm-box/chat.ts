import type { ConfirmBoxThreadRef } from "./store.js";

/**
 * 確認箱のチャット欄(A案・2026-10-21 ユーザー決定)の型と、返答を切り出す純関数。
 *
 * 箱のチャット欄で質問を打つと `thread_ref` の**元スレへ送られ、返答が箱に戻ってくる**
 * (箱を閉じずに聞ける)。「箱の中にQ&A欄は作らない」という以前の設計は、**聞かれた内容が
 * そのまま学習ログに残らない**ことを理由に破棄された(元スレを開くだけのB案だと、
 * 質問文を feedback スレが手作業で拾うことになる)。
 *
 * 送信はデーモン内から `agent-prompt.ts` の `sendPromptToAgent()` を呼ぶ。フォークに
 * **エージェント宛メッセージのHTTPルートは無く**(エージェント操作はWebSocket経由)、
 * `sendPromptToAgent()` が「Session/WS・MCP・CLI・chat mentions・notify-on-finish の
 * 全送信面が必ず通る」唯一の関所だから。`source` を渡さないので、投入された質問は
 * 元スレでは**人間のユーザーメッセージ**として見える。
 *
 * 返答は元スレのタイムラインを `clientMessageId` で切り出して取り込む(下の
 * `selectChatTranscript()`)。新しい購読は作らず、箱の既存の15秒ポーリングに相乗りする。
 */

/**
 * 元スレのタイムライン1件。`agent/agent-sdk-types.ts` の `AgentTimelineItem` のうち
 * 箱が要る形だけを**構造的に**写したもの(confirm-box から agent 側の型へ依存しないため)。
 */
export type ConfirmBoxTimelineItem =
  | { type: "user_message"; text: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string };

/**
 * 元スレへの送信と、そのタイムラインの読み出し。実装は `bootstrap.ts` が
 * `sendPromptToAgent()` と `AgentManager` を包んで渡す。
 *
 * **遅延getterで受ける**のは、`agentManager` / `agentStorage` が `setupConfirmBox()` より
 * 後に生成されるため(既存の `getPushSender: () => … wsServer?.…` と同じ形)。
 */
export interface ConfirmBoxThreadGateway {
  /** 質問を元スレへ送る。`clientMessageId` は返答の対応付けに使う。 */
  send(input: { agentId: string; question: string; clientMessageId: string }): Promise<void>;
  /** 元スレのタイムライン。読めないとき(未ロード等)は例外を投げてよい。 */
  timeline(agentId: string): Promise<ConfirmBoxTimelineItem[]>;
}

export interface ConfirmBoxChatTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * 箱から送れるのは Paseo のエージェントだけ。`thread_ref.kind` がこれ以外
 * (Topos側のスレッドID等)は送り先が無いので、箱はチャット欄を出さず
 * 「元スレを開く」だけを出す。
 */
export const SENDABLE_THREAD_KIND = "paseo_agent";

export function isSendableThread(ref: ConfirmBoxThreadRef | null): ref is ConfirmBoxThreadRef {
  return Boolean(ref && ref.kind === SENDABLE_THREAD_KIND && ref.id);
}

/** 箱に出す会話の上限。長い相談は元スレで読む(箱は「聞いて返ってきた所」だけ見せればよい)。 */
export const MAX_TRANSCRIPT_TURNS = 20;

/**
 * タイムラインから「箱から聞いたやり取り」だけを切り出す。
 *
 * 起点は**箱が付けた `clientMessageId` を持つ user_message**。そこから後ろの
 * user/assistant 発言を順に拾う(人間が元スレで直接打った発言も同じ並びで見せる=
 * 箱と元スレで見えるものが食い違わない)。
 *
 * - 起点が見つからなければ**空を返す**。デーモン再起動後は元スレがメモリから消えて
 *   タイムラインを読めないことがあり、そこで推測で別の返答を出すと嘘になる。
 * - tool_call / reasoning 等は捨てる(箱は判断の材料になる発言だけ見せる)。
 */
export function selectChatTranscript(
  timeline: readonly ConfirmBoxTimelineItem[],
  askedClientMessageIds: readonly string[],
): ConfirmBoxChatTurn[] {
  const asked = new Set(askedClientMessageIds.filter((id) => id.length > 0));
  if (asked.size === 0) return [];
  const turns: ConfirmBoxChatTurn[] = [];
  let started = false;
  for (const item of timeline) {
    if (!started) {
      if (
        item.type === "user_message" &&
        typeof item.clientMessageId === "string" &&
        asked.has(item.clientMessageId)
      ) {
        started = true;
      } else {
        continue;
      }
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    if (item.type === "user_message") turns.push({ role: "user", text });
    else if (item.type === "assistant_message") turns.push({ role: "assistant", text });
  }
  return turns.slice(-MAX_TRANSCRIPT_TURNS);
}
