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

// ---------------------------------------------------------------- 投函元が無い/閉じているカードの送信先

// 総司令塔スレの agent ID は直書きしない。起こしデーモンの実行時の正本
// (`domains/general/coordinator_id`)をサーバが読み、RPC `topos.confirmbox.coordinator` で渡す。

/** 送信先を総司令塔へ切り替えた時に入力欄の下へ出す説明。 */
export const COORDINATOR_FALLBACK_NOTICE =
  "元スレが無いので総司令塔に送ります。カードの題名と本文を付けて送信されます";

/**
 * 総司令塔へ振り替えるか。**カードの時だけ**(スレ直接=優先順位の行は対象外)。
 * 投函元の参照が無い(`agentId` 無し)か、閉じていると分かった(`closedText` あり)時。
 * 不明(生死が引けない)は振り替えない(不明を「閉じている」と言い換えない)。
 */
export function shouldFallbackToCoordinator(opts: {
  hasCard: boolean;
  agentId: string | null;
  closedText: string | null;
}): boolean {
  if (!opts.hasCard) return false;
  return !opts.agentId || opts.closedText !== null;
}

/** 総司令塔へ送る発言の先頭にカード題名とIDを付ける(本文はそのまま後ろに残す)。 */
export function withCardHeader(
  text: string,
  card: { id: string; subject: string; background?: string | null },
): string {
  const head = `【確認箱カード】${card.subject}(ID: ${card.id})`;
  const body = card.background ? `\n[カード本文]\n${card.background}` : "";
  // 「[ユーザーの発言]」区切りは機械が原文を切り出す目印(antigravity/utils/judgment_answer_sweep.py が
  // 司令塔スレの発言ログから読み、回答済みにする)。文言を変えるなら両方を揃えること。
  return `${head}${body}\n\n[ユーザーの発言]\n${text}`;
}

/**
 * カード本体のタップでペインの相手を切り替えるか。**ペインが既に開いている時だけ**(閉じている時は
 * 開かない=従来動作)、かつそのカードが既に出ているカードでない時。開くのは「💬 会話」ボタンの役目。
 */
export function shouldSwitchPaneOnCardPress(anyPaneOpen: boolean, thisCardShown: boolean): boolean {
  return anyPaneOpen && !thisCardShown;
}

/**
 * 題名・キーから管轄領域を推測する(サーバの宛先判定 `server/card-destination.ts` と同じ語)。
 * 確認箱の「スレを開く」が、宛先のスレを一覧から引けないときに開くスレを決めるために使う。
 * 語を増やすときは両方を揃えること。
 */
const DOMAIN_HINTS: readonly (readonly [string, RegExp])[] = [
  ["f80", /f-?80/i],
  ["topos_dev", /topos[-_ ]?dev/i],
  ["paseo_ui", /paseo|確認箱|サイドバー/i],
];

export function inferDomain(hint: string): string | null {
  for (const [domain, re] of DOMAIN_HINTS) if (re.test(hint)) return domain;
  return null;
}

// ---------------------------------------------------------------- 優先順位ページの吹き出し(ChatDock)の宛先

/** 吹き出し会話が総司令塔へ落ちた時に送信文の先頭へ付ける目印(総司令塔が出どころを判別できるように)。 */
export const DOCK_FALLBACK_CONTEXT =
  "【確認箱 優先順位ページの吹き出し】(常駐会話スレが閉じているため総司令塔に届いています)";

/**
 * 吹き出し会話の送り先。固定の常駐会話スレが生きていればそれ、閉じている/存在しないなら総司令塔。
 * `fixedAlive`: true=生きている、false=閉じている/無い、null=まだ確認中(確認中は送り先を決めない)。
 * 総司令塔のIDも無ければ null(送信不可の理由を出す)。
 */
export function pickDockTarget(opts: {
  fixedId: string | null;
  fixedAlive: boolean | null;
  coordinatorId: string | null | undefined;
}): { agentId: string | null; viaCoordinator: boolean; pending: boolean } {
  if (opts.fixedId && opts.fixedAlive === true)
    return { agentId: opts.fixedId, viaCoordinator: false, pending: false };
  if (opts.fixedId && opts.fixedAlive === null)
    return { agentId: null, viaCoordinator: false, pending: true };
  if (opts.coordinatorId === undefined)
    return { agentId: null, viaCoordinator: true, pending: true };
  return { agentId: opts.coordinatorId, viaCoordinator: true, pending: false };
}

// ---------------------------------------------------------------- 「この話題だけ」(方式a)

/** Python `confirm_box_reply.SAY_SCRIPT` と同じ。上位スレがそのまま貼って実行する。 */
export const SAY_SCRIPT =
  "/Users/user/repos/ToposAI-Mini-Project/antigravity/utils/confirm_box_reply.py";

/** heredoc の終端語。返事本文に同名の行があると途中で閉じ、残りがシェル実行されるので毎回ランダムにする。 */
export function sayEof(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `REPLY_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** シェルのシングルクォート(Python `_q` の写し)。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * ハブ宛(総司令塔・子司令塔、または総司令塔へ振り替え)か。ハブは複数話題を同じスレで扱うので、
 * 会話を「そのカードの話題だけ」(台帳の chat/reply)に絞る。非ハブの単一話題の子スレは従来のライブ表示。
 */
export function isHubTarget(opts: {
  fallback: boolean;
  agentId: string | null;
  hubIds: readonly string[];
}): boolean {
  if (opts.fallback) return true;
  return opts.agentId !== null && opts.hubIds.includes(opts.agentId);
}

/** 上位スレへ送る文に、返信IDと say コマンド(完成形)を付ける。 */
export function withSayInstruction(
  text: string,
  opts: { replyId: string; cardId: string },
): string {
  const eof = sayEof();
  return (
    `${text}\n\n` +
    `【確認箱ペインの質問・返信ID ${opts.replyId}】返事は普通の発言ではペインに出ません。次で書いてください:\n` +
    `python3 ${SAY_SCRIPT} say --id ${shellQuote(opts.cardId)} --re ${shellQuote(opts.replyId)}` +
    ` --by hub_thread --text-file - <<'${eof}'\n(返事)\n${eof}`
  );
}

/** 返事待ちの目印。3分以内=「返事待ち」、超過=「返事待ち(sayなし)」。 */
export function pendingLabel(state: "waiting" | "overdue", nudges: number): string {
  if (state === "waiting") return "返事待ち";
  return nudges > 0 ? `返事待ち(sayなし・催促${nudges}回)` : "返事待ち(sayなし)";
}

/**
 * Enter キーで送信するか。Web かつ非compact(PC幅)だけ。IME変換中(isComposing / keyCode 229)と
 * Shift+Enter(改行)は送らない。iPhone(compact)は Enter=改行のまま。
 */
export function shouldSubmitOnEnter(ev: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  isWeb: boolean;
  compact: boolean;
}): boolean {
  if (!ev.isWeb || ev.compact) return false;
  if (ev.key !== "Enter" || ev.shiftKey) return false;
  if (ev.isComposing || ev.keyCode === 229) return false;
  return true;
}
