/**
 * 右ペイン(会話)のURL状態(純関数)。
 *
 * ペインが開けるのは2種類:
 * - カード       … `?card=<確認箱の項目id>`(💬 から。相手は投函元スレ)
 * - スレ直接     … `?thread=<agent id>`(優先順位ページの行タップから。相手は担当スレ)
 *
 * Expo Router の `param.*` とは別名前空間にしてある(プラグイン画面の params は `param.` 前置き
 * だけを拾うため、こちらはルーターに影響しない)。ブラウザAPIには触れないので node:test から
 * そのまま検証できる。
 */

import type { ThreadAccess } from "./child-threads.js";

export const CARD_PANE_PARAM = "card";
export const THREAD_PANE_PARAM = "thread";

/** ペインに出す相手。`id` はカードなら項目id、スレなら agent id。 */
export type PaneTarget = { kind: "card"; id: string } | { kind: "thread"; id: string };

/** `?a=1` / `a=1` / `""` からカードIDを取り出す。空・不正は null。 */
export function cardIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const id = params.get(CARD_PANE_PARAM);
  return id && id.trim() ? id : null;
}

/** `?thread=` から agent id を取り出す。空・不正は null。 */
export function threadIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const id = params.get(THREAD_PANE_PARAM);
  return id && id.trim() ? id : null;
}

/**
 * URL からペインの相手を決める。**thread を先に見る**(同時に載っていたらスレ直開きが勝つ。
 * 開く側は必ず片方だけを書くので、両方載るのは手で URL を組んだ時だけ)。
 */
export function paneTargetFromSearch(search: string): PaneTarget | null {
  const thread = threadIdFromSearch(search);
  if (thread) return { kind: "thread", id: thread };
  const card = cardIdFromSearch(search);
  if (card) return { kind: "card", id: card };
  return null;
}

/**
 * `search` の card / thread を差し替える(undefined = 触らない、null = 消す)。他のクエリは残す。
 * ペインは同時に1つなので、開く側は必ず `{card, thread}` の両方を渡して片方を消すこと。
 */
export function searchWithPane(
  search: string,
  pane: { card?: string | null; thread?: string | null },
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const put = (name: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value && value.trim()) params.set(name, value);
    else params.delete(name);
  };
  put(CARD_PANE_PARAM, pane.card);
  put(THREAD_PANE_PARAM, pane.thread);
  const out = params.toString();
  return out ? `?${out}` : "";
}

/** `search` の card だけを差し替える(id=null で削除)。他のクエリはそのまま残す。 */
export function searchWithCard(search: string, id: string | null): string {
  return searchWithPane(search, { card: id });
}

// ---------------------------------------------------------------- スレの生死(純関数)

/**
 * ペインで会話できるか。`access` は `server/thread-liveness.ts` の `threadAccessById` が返す印
 * (null=不明。**不明を「閉じている」と言い換えない**)。
 * 閉じている時の文言は1つにする(2026-10-23 ユーザー指示の推奨仮):「投函元が閉じています」。
 * 優先順位の行(担当スレ)では投函元ではないので別の語にする。
 */
export function threadUnavailableReason(
  access: ThreadAccess | null,
  kind: "card" | "thread",
): string | null {
  if (access !== "thread-archived" && access !== "workspace-archived") return null;
  if (kind === "thread") return "担当スレが閉じています";
  if (access === "workspace-archived")
    return "投函元が閉じています(ワークスペースがアーカイブ済み)";
  return "投函元が閉じています";
}
