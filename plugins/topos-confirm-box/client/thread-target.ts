/**
 * 「スレを開く」で開くスレを決める。
 *
 * 2026-10-27: 本番で右カラムが開かなかった原因は、カードの宛先が**アーカイブ済みの旧総司令塔**を指していたこと
 * (Vault 由来カードの `thread_ref` に、交代前の司令塔のIDが残っている)。アプリのスレ一覧
 * (session store)に居ないIDは右カラムの置き場所を決められず、確認箱ごと全画面で入れ替わる。
 * そこで開く前に、宛先が今の一覧に居るかを確かめ、居なければ持ち主のスレ(題名から分かる管轄の
 * 司令塔 → このカードに答えるスレ(親)→ 起こしデーモンが指す総司令塔)で振り替える。どれも見つからなければ
 * 従来どおり全画面で開き、理由を1行出す(黙って入れ替えない)。
 */

/** 宛先を決めた理由。`resolved` 以外は「振り替えた」または「振り替え先が無い」。 */
export type ThreadTargetReason =
  /** 宛先が一覧に居る(そのまま開く)。 */
  | "resolved"
  /** 宛先が一覧に無く、題名から分かる管轄の司令塔に振り替えた。 */
  | "domain-coordinator"
  /** 宛先が一覧に無く、起こしデーモンが指す総司令塔に振り替えた。 */
  | "general-coordinator"
  /** 宛先(投函元)が閉じているので、この欄に答えるスレ(親)へ戻した(2026-10-27 あとから追加)。 */
  | "destination"
  /** 宛先が一覧に無く、振り替え先も無い(全画面で開く)。 */
  | "no-live-thread";

/** `PaseoApi.agents.list()` で見つけたスレ(読む所だけ緩く持つ)。 */
export interface DirectoryAgent {
  id: string;
  archivedAt?: unknown;
  status?: unknown;
}

export interface ThreadTargetInput {
  /** 開くスレ(投函の `thread_id`。無ければサーバが決めた `threadRef`)。`resolveOpenThreadId` の結果。 */
  target: string | null;
  /** 開くスレが閉じていて代わりが決まらないときの次点(この欄に答えるスレ=親)。 */
  destination?: string | null;
  /** 開くカードの題名(領域の推測に使う。無ければ推測しない)。 */
  title?: string | null;
  /** サーバが返す総司令塔のID(起こしデーモンの正本。古いことがある)。 */
  coordinatorId?: string | null;
  /** ハブ(総司令塔・子司令塔)のID一覧。 */
  hubIds?: readonly string[];
  /** Paseo のスレ一覧(アーカイブ済み込み。開けるかはここで判定する)。 */
  directory: readonly DirectoryAgent[];
  /** 題名・スレIDの管轄領域(`/f-?80/i` → "f80" 等)。推測できなければ null。 */
  inferDomain?: (text: string) => string | null;
  /** 領域名 → 司令塔のID。 */
  domainCoordinators?: Readonly<Record<string, string>>;
}

export interface ThreadTargetResult {
  /** 開くスレのID。null = 開くスレが決まらない(`target` も無い)。 */
  agentId: string | null;
  reason: ThreadTargetReason;
  /** 振り替えた/開けないときの説明(1行)。そのまま開く場合は null。 */
  notice: string | null;
}

/**
 * 開けるスレか。アーカイブ済みは開かない。`closed` も外す — デーモン再起動で閉じただけのスレは
 * 送れば再開するが、開いた直後の右カラムは空に見えるため、可能なら動いているスレを選ぶ。
 */
function isOpen(agent: DirectoryAgent | undefined): agent is DirectoryAgent {
  return agent !== undefined && agent.archivedAt == null && agent.status !== "closed";
}

function noticeFor(reason: ThreadTargetReason, agentId: string | null): string | null {
  const who = agentId ? agentId.slice(0, 8) : "";
  switch (reason) {
    case "domain-coordinator":
      return `カードのスレが一覧に無いので、この話題の司令塔(${who})を開きます`;
    case "destination":
      return `カードのスレが閉じているので、このカードに答えるスレ(${who})を開きます`;
    case "general-coordinator":
      return `カードのスレが一覧に無いので、総司令塔(${who})を開きます`;
    case "no-live-thread":
      return "カードのスレが一覧に無く、代わりのスレも見つからないので全画面で開きます";
    default:
      return null;
  }
}

function pick(agentId: string, reason: ThreadTargetReason): ThreadTargetResult {
  return { agentId, reason, notice: noticeFor(reason, agentId) };
}

/**
 * 開くスレを決める。宛先が一覧に居ればそのまま(振り替えない)。居なければ:
 * 題名の管轄の領域司令塔 → このカードに答えるスレ(親) → 総司令塔(デーモンが指すID) → あきらめる。
 * 親を領域司令塔より後に置くのは、題名から管轄が分かるカードでは領域司令塔の方が近いため
 * (答えるスレは、司令塔が閉じていた時の振り替え先としてサーバが選んだもの)。
 * どれが持ち主か分からないときは推測しない(別の話題のスレへ飛ばさない)。特に「動いている司令塔が
 * 1本だけだからそこへ」はやめた — 2026-10-27 本番で、題名と無関係の裏方スレへ飛んだ。
 */
export function resolveThreadTarget(input: ThreadTargetInput): ThreadTargetResult {
  const byId = new Map(input.directory.map((a) => [a.id, a]));
  if (input.target && isOpen(byId.get(input.target))) {
    return { agentId: input.target, reason: "resolved", notice: null };
  }
  const domain = input.title ? (input.inferDomain?.(input.title) ?? null) : null;
  const domainId = domain ? input.domainCoordinators?.[domain] : undefined;
  if (domainId && isOpen(byId.get(domainId))) return pick(domainId, "domain-coordinator");
  const destination = input.destination ?? null;
  if (destination && destination !== input.target && isOpen(byId.get(destination))) {
    return pick(destination, "destination");
  }
  if (input.coordinatorId && isOpen(byId.get(input.coordinatorId))) {
    return pick(input.coordinatorId, "general-coordinator");
  }
  // 振り替え先が無い(宛先が閉じていて、領域司令塔・親・総司令塔も開けない)、または宛先自体が無い。
  return {
    agentId: input.target,
    reason: "no-live-thread",
    notice: noticeFor("no-live-thread", input.target),
  };
}

/** 投函データから読む分だけ緩く持つ(`ConfirmBoxItem` と生の行のどちらでも渡せる)。 */
export interface ThreadIdLike {
  threadRef?: { kind?: string | null; id?: string | null } | null;
  /** 投函した側が名指ししたスレ(サーバの `ConfirmBoxItem.threadId`)。 */
  threadId?: string | null;
  /** 承認待ち項目のエージェント。 */
  agentId?: string | null;
  /** 判断ノートの `threads:`(解釈はサーバ側。宛先決定には使わない)。 */
  threadCandidates?: readonly string[] | null;
}

const trimmed = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * 「スレを開く」の宛先用のスレID。**投函に `thread_id` があればそれをそのまま使う**
 * (2026-10-27: 従来は `thread_ref` しか見ておらず、サーバが登録簿 `child_threads.json` から
 * 「投函元の親」を組み立てた `thread_ref` を開いていた。親がアーカイブ済みだと開けなかった)。
 * 無いときは従来どおり `thread_ref`(paseo_agent)→ 承認待ちの `agentId`。
 *
 * `threadId` はサーバが入れる(箱の行・中間形式の `thread_id`、判断ノートの `thread_id:`/`threads:` の
 * 1本目。判断ノート側の解釈の正本は `server/notes.ts` の `threadIdCandidates` と `vault-decisions.ts`)。
 * クライアントはここで推測を足さない。
 */
export function resolveOpenThreadId(item: ThreadIdLike | null | undefined): string | null {
  if (!item) return null;
  // `threadCandidates[0]` は使わない: 「先頭=投函元」の解釈はサーバ(`vault-decisions.ts`)の1箇所に置く。
  // ここでも同じ推測を繰り返すと、別の書き手の `threads:` で無関係なスレを通知なしに開きうる(round1 F4)。
  const direct = trimmed(item.threadId);
  if (direct) return direct;
  if (item.threadRef?.kind === "paseo_agent") return trimmed(item.threadRef.id);
  return trimmed(item.agentId);
}

/** 決まった宛先を開く。振り替えた/開けないときは理由を1行だけコンソールにも残す(実画面の切り分け用)。 */
export function reportThreadTarget(result: ThreadTargetResult): void {
  // `resolved` でも残す: 一覧には居るがアプリが置き場所を決められず全画面へ落ちる経路(2026-10-27 実測)の
  // 切り分けに「宛先が解決された」こと自体が要る。
  if (result.reason === "resolved") {
    console.info("[Plugins] Confirm box thread target: resolved");
    return;
  }
  console.warn(`[Plugins] Confirm box thread target: ${result.reason}`);
}
