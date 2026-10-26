/**
 * 「スレを開く」で開くスレを決める。
 *
 * 2026-10-27: 本番で右カラムが開かなかった原因は、カードの宛先が**アーカイブ済みの旧総司令塔**を指していたこと
 * (Vault 由来カードの `thread_ref` に、交代前の司令塔のIDが残っている)。アプリのスレ一覧
 * (session store)に居ないIDは右カラムの置き場所を決められず、確認箱ごと全画面で入れ替わる。
 * そこで開く前に、宛先が今の一覧に居るかを確かめ、居なければ持ち主のスレ(題名から分かる管轄の
 * 司令塔 → 起こしデーモンが指す総司令塔 → 唯一のハブ)で振り替える。どれも見つからなければ
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
  /** 宛先が一覧に無く、開ける司令塔が1本だけだったそのスレに振り替えた。 */
  | "live-coordinator"
  /** 宛先が一覧に無く、振り替え先も無い(全画面で開く)。 */
  | "no-live-thread";

/** `PaseoApi.agents.list()` で見つけたスレ(読む所だけ緩く持つ)。 */
export interface DirectoryAgent {
  id: string;
  archivedAt?: unknown;
  status?: unknown;
}

export interface ThreadTargetInput {
  /** カードが指す宛先(`threadAgentId(item)` の結果)。 */
  target: string | null;
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
    case "general-coordinator":
      return `カードのスレが一覧に無いので、総司令塔(${who})を開きます`;
    case "live-coordinator":
      return `カードのスレが一覧に無いので、動いている司令塔(${who})を開きます`;
    case "no-live-thread":
      return "カードのスレが一覧に無く、代わりのスレも見つからないので全画面で開きます";
    default:
      return null;
  }
}

function pick(agentId: string, reason: ThreadTargetReason): ThreadTargetResult {
  return { agentId, reason, notice: noticeFor(reason, agentId) };
}

/** 開ける司令塔のID(重複は畳む。並びは ハブ → 総司令塔)。 */
function openCoordinators(
  input: ThreadTargetInput,
  byId: ReadonlyMap<string, DirectoryAgent>,
): string[] {
  const out: string[] = [];
  for (const id of [...(input.hubIds ?? []), input.coordinatorId ?? null]) {
    if (id && isOpen(byId.get(id)) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 開くスレを決める。宛先が一覧に居ればそのまま(振り替えない)。居なければ:
 * 題名の管轄の司令塔 → 総司令塔(デーモンが指すID) → 開ける司令塔が1本だけならそのスレ → あきらめる。
 * 2本以上あってどれが持ち主か分からないときは推測しない(別の話題のスレへ飛ばさない)。
 */
export function resolveThreadTarget(input: ThreadTargetInput): ThreadTargetResult {
  const byId = new Map(input.directory.map((a) => [a.id, a]));
  if (input.target && isOpen(byId.get(input.target))) {
    return { agentId: input.target, reason: "resolved", notice: null };
  }
  const domain = input.title ? (input.inferDomain?.(input.title) ?? null) : null;
  const domainId = domain ? input.domainCoordinators?.[domain] : undefined;
  if (domainId && isOpen(byId.get(domainId))) return pick(domainId, "domain-coordinator");
  if (input.coordinatorId && isOpen(byId.get(input.coordinatorId))) {
    return pick(input.coordinatorId, "general-coordinator");
  }
  const coordinators = openCoordinators(input, byId);
  if (coordinators.length === 1 && coordinators[0])
    return pick(coordinators[0], "live-coordinator");
  // 宛先が無い(投函元も thread_ref も無い)なら、開くスレは決まらない。
  return {
    agentId: input.target,
    reason: "no-live-thread",
    notice: noticeFor("no-live-thread", input.target),
  };
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
