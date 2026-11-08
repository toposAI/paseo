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
 *
 * **投函元がたどれないカードも振り替える**(=総司令塔が引き取る)。2026-11-06 ユーザー逐語
 * 「投稿元たどれないなら、総司令塔が引き取るってなってるでしょ」。以前はここで送信不可に
 * していたが、引き取り先があるのに箱の中で閉じる結果になっていた。
 */
export function shouldFallbackToCoordinator(opts: {
  hasCard: boolean;
  agentId: string | null;
  closedText: string | null;
}): boolean {
  if (!opts.hasCard) return false;
  return !opts.agentId || opts.closedText !== null;
}

/**
 * 送り先として使える agent id か(完全な UUID だけ)。
 *
 * 投函に `thread_ref.id` として短縮ID(`1af1a9b` のような人が読む用の接頭辞)が入っていることがあり、
 * それを宛先にすると送信が必ず失敗する(2026-11-03 実データ: 確認箱の項目 `ceace31d68914a05` の
 * `thread_ref.id` が `1af1a9b`)。使えないIDは「投函元が無い」と同じ扱いにして総司令塔へ振り替える。
 */
export function isUsableAgentId(id: string | null | undefined): boolean {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
}

/** 振り替え先の候補を優先順に並べる(空・重複を落とす)。 */
export function coordinatorCandidates(
  primary: string | null | undefined,
  extra: readonly string[] = [],
): string[] {
  const out: string[] = [];
  for (const id of [primary ?? "", ...extra]) {
    const clean = id.trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * 振り替え先の候補の生死から、実際に送る1本を選ぶ。
 * `live`: true=生きている、false=閉じている(アーカイブ済み)、null=読めず不明。
 *
 * 生きている先を最優先し、無ければ**不明**を最後の手段にする(読めないだけで送信を止めない=
 * 従来の fail-open)。全部閉じていれば null(=送信不可。理由を画面に出す)。
 * 総司令塔が退役して閉じている時は、後継(裏方1)が生きていればそこへ送る。
 */
export function pickCoordinatorTarget(
  candidates: readonly { id: string; live: boolean | null }[],
): string | null {
  const alive = candidates.find((c) => c.live === true);
  if (alive) return alive.id;
  const unknown = candidates.find((c) => c.live === null);
  return unknown ? unknown.id : null;
}

// ---------------------------------------------------------------- 配送の解決順(投函元 → 復元 → 総司令塔)

/**
 * 候補を順に試し、**最初に成功した候補**を返す(全滅なら `delivered:null`)。
 * 「投函元でだめなら総司令塔」を、送信そのもの(例外の有無)で判定するための共通ループ。
 * 失敗した候補の後始末(質問記録の取り消しなど)は `attempt` の中で行う。
 */
export async function attemptDelivery<T>(
  targets: readonly T[],
  attempt: (target: T) => Promise<void>,
): Promise<{ delivered: T | null; errors: unknown[] }> {
  const errors: unknown[] = [];
  for (const target of targets) {
    try {
      await attempt(target);
      return { delivered: target, errors };
    } catch (e) {
      errors.push(e);
    }
  }
  return { delivered: null, errors };
}

/** 送る候補の1つ。`via` は「投函元」か「引き取り先(総司令塔)」かの印。 */
export interface DeliveryTarget {
  id: string;
  via: "origin" | "coordinator";
}

/**
 * 確認箱のコメントを届ける候補を優先順に並べる(2026-11-06 ユーザー逐語
 * 「投稿元たどれないなら、総司令塔が引き取るってなってるでしょ」「閉じていれば復元して届ける」)。
 *
 * 順番は **投函元 → 総司令塔**。窓口など別のスレへは流さない。配列が空なら**どこにも届かない**
 * =呼ぶ側はカードを閉じずに理由を出す(「届いていないのに完了」を作らない)。
 *
 * 「閉じていれば復元して届ける」を専用の復元APIでやらない理由: `agents.ref(id).send()` は
 * アーカイブ済みのスレでも解除して届ける(`client/agent-read.ts` の実測表)。`PaseoApi` に
 * 解除だけを行うAPIは無いので、「アーカイブ済みでも投函元へ送ってみる」が復元そのものになる。
 * 送れなかった時だけ次の候補(総司令塔)へ進む。
 */
export function deliveryTargets(opts: {
  /** 投函元スレの agent id(使えないIDは呼ぶ側で null にする)。 */
  originId: string | null;
  /** 引き取り先(総司令塔)。 */
  coordinatorId: string | null;
}): DeliveryTarget[] {
  const out: DeliveryTarget[] = [];
  const origin = opts.originId?.trim() ?? "";
  if (origin) out.push({ id: origin, via: "origin" });
  const coordinator = opts.coordinatorId?.trim() ?? "";
  if (coordinator && coordinator !== origin) out.push({ id: coordinator, via: "coordinator" });
  return out;
}

/**
 * カードの見出しと本文。見出しの文言と「[ユーザーの発言]」区切りは機械が読む目印
 * (antigravity/utils/judgment_answer_sweep.py が司令塔スレの発言ログから原文を切り出す)なので、
 * 溜める経路(`withSayInstructionUpFront`)と直接送る経路(`withCardHeader`)で同じものを使う。
 */
function cardHeader(card: { id: string; subject: string; background?: string | null }): {
  head: string;
  body: string;
} {
  return {
    head: `【確認箱カード】${card.subject}(ID: ${card.id})`,
    body: card.background ? `\n[カード本文]\n${card.background}` : "",
  };
}

/** 総司令塔へ送る発言の先頭にカード題名とIDを付ける(本文はそのまま後ろに残す)。 */
export function withCardHeader(
  text: string,
  card: { id: string; subject: string; background?: string | null },
): string {
  const { head, body } = cardHeader(card);
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

/** 返信IDと say コマンド(完成形)。付ける位置だけ経路で変える(中身は変えない)。 */
function sayInstructionBlock(opts: { replyId: string; cardId: string }): string {
  const eof = sayEof();
  return (
    `【確認箱ペインの質問・返信ID ${opts.replyId}】返事は普通の発言ではペインに出ません。次で書いてください:\n` +
    `python3 ${SAY_SCRIPT} say --id ${shellQuote(opts.cardId)} --re ${shellQuote(opts.replyId)}` +
    ` --by hub_thread --text-file - <<'${eof}'\n(返事)\n${eof}`
  );
}

/** 上位スレへ**直接**送る文に、返信IDと say コマンド(完成形)を末尾へ付ける。 */
export function withSayInstruction(
  text: string,
  opts: { replyId: string; cardId: string },
): string {
  return `${text}\n\n${sayInstructionBlock(opts)}`;
}

/**
 * 受け箱(通知まとめ)へ**溜める**経路の文面。say 指示をカード見出しの**直後**(長い背景より前)へ置く。
 *
 * 溜めた束は `notify_digest.digest_message` が1項目600字(`digest_inline_item_chars`)で切って載せる。
 * 背景付きのカードでは、ユーザーが何も書いていなくても本文が600字を超え、末尾の say 指示が
 * 切られていた(704件中156件。直接送信時代は全文が届いていた後退)。前に置けば、切られても
 * 返事の書き方が残る。直接送る経路(`withSayInstruction`)の文面は変えない。
 */
export function withSayInstructionUpFront(
  text: string,
  card: { id: string; subject: string; background?: string | null },
  opts: { replyId: string; cardId: string },
): string {
  const { head, body } = cardHeader(card);
  return `${head}\n\n${sayInstructionBlock(opts)}${body}\n\n[ユーザーの発言]\n${text}`;
}

/**
 * 画像への直接コメントに必ず付く目印(画像名に依存しない)。UI確認カードの画像ビューアが
 * 送る文の先頭に付ける。付いている文は**返事を求めない**ので、say の指示を付けず、
 * 催促の対象からも外す(2026-11-06 ユーザー指示「返事書かなくていい」)。カードを閉じる合図には
 * しない(2026-11-08 ユーザー指示「1枚の画像にコメントした直後にその確認箱終了にするのやめて、
 * 僕が全部の画像を確認した後に僕が手動で完了ボタンを押します」)。印は Python `confirm_box_reply.py` と同じ。
 */
export const IMAGE_COMMENT_TAG = "【画像への直接コメント】";

/** 画像への直接コメントか。画像名が長い・記号を含む場合でも取りこぼさない(固定の目印で見る)。 */
export function isImageComment(text: string): boolean {
  return text.includes(IMAGE_COMMENT_TAG);
}

/**
 * カードからの発言のうち**すぐ届けるべき**語。カードからの発言は受け箱に溜める(2026-11-08 ユーザー指示
 * 「一箇所に貯めておいて5分おきに確認するシステムに入れればいいじゃん」)が、故障・本番入れ替えの
 * ように5分待つと損をする報告だけは従来どおり即時に送る。
 * Python `notify_digest.py` の `inbox_immediate_markers` のうち、確認箱の文脈で誤検知しない語だけを持つ
 * (「確認箱」「判断待ち」はカードの見出しに必ず入るので入れない)。
 * 安全網(L0)・出口レビュー(Critique)のような「止まったら損」の語も入れる(2026-11-08 出口レビュー指摘)。
 */
export const URGENT_CARD_CHAT_MARKERS = [
  "故障",
  "異常",
  "壊れ",
  "動かない",
  "復旧",
  "再起動依頼",
  "本番入れ替え",
  "本番入替",
  "安全網",
  "データ消失",
  "消えた",
  "L0",
  "Critique",
  "collect-auditor",
  "検知",
] as const;

/** 発言の本文(見出しを付ける前)が「5分待たずに届けるべき」か。 */
export function isUrgentCardChat(text: string): boolean {
  return URGENT_CARD_CHAT_MARKERS.some((m) => text.includes(m));
}

/**
 * カードからの発言を「受け箱へ溜める」か(溜めずに今すぐ送るなら false)。
 *
 * - カードの項目が無い発言(雑談)は溜めない=従来どおり今すぐ送る。
 *   `hasItem=false` は「カードが無い」=topic も無い状態を兼ねる(topic は item から導出されるため)
 * - 画像ファイルの添付は受け箱が本文しか運べないので直接送る
 * - 故障・本番入れ替えなど5分待つと損をする語を含む発言は、画像コメントかどうかに関わらず即時に送る
 * - それ以外は溜める(画像への直接コメントも溜める。2026-11-08 ユーザー指示)
 * - 宛先が死んでいれば溜めない(溜めるとまとめ送りが永久に届かない)
 */
export function shouldQueueCardChat(input: {
  hasItem: boolean;
  attachedImages: number;
  /**
   * 宛先へ送る本文。**カードIDの見出しを付ける前**の文を渡す(見出しには件名が入り、
   * 件名の「故障」「異常」で全部が即時になってしまうため)。
   */
  text: string;
  targetLive: boolean;
}): boolean {
  if (!input.hasItem) return false;
  if (input.attachedImages > 0) return false;
  if (isUrgentCardChat(input.text)) return false;
  return input.targetLive;
}

/**
 * 画像ごとのコメント文。どの画像へのコメントかを投函元へ伝える印と、機械が見分ける固定の目印を付ける。
 * 画面ごとに書き方がぶれないよう、ここ1か所で作る(2026-11-06)。
 */
export function imageCommentText(label: string, text: string): string {
  return `${IMAGE_COMMENT_TAG}【${label}へのコメント】${text.trim()}`;
}

/** 画像への直接コメントを上位スレへ送る文に、返事が要らないことを明記する(say コマンドは付けない)。 */
export function withNoReplyInstruction(text: string): string {
  return (
    `${text}\n\n` +
    `【返事不要】これは画像への直接コメントです。返事は書かず、指摘された直しだけを進めてください。`
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
