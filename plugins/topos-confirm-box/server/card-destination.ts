/**
 * 確認箱カードのチャット宛先(=この欄に答えるスレ)を決める純関数。
 *
 * 2026-10-25 ユーザー決定: 宛先は「投函元の**上のスレ**」(登録簿 `child_threads.json` の
 * `parent_agent_id`)。上が無ければ投函元本人。上が閉じていれば領域司令塔(F-80/topos開発/Paseo UI)、
 * それも無ければ総司令塔。登録簿に無い投函元は「未登録」と明示し、ノートの題名・key から領域を推定して
 * 領域司令塔へ送る(推定できなければ総司令塔)。
 *
 * 上のスレが司令塔とは限らない(だから「司令塔を探す」のでなく「登録簿の親を引く」)。
 * 直接の親だけを引き、祖父母には上がらない(親が閉じた時の次点は領域司令塔→総司令塔)。
 */

export interface RegistryEntry {
  agentId: string;
  title: string;
  parentAgentId: string | null;
  parentTitle: string | null;
  /** 登録簿で `archived: true`(閉じて宛先にできない)。 */
  archived: boolean;
}

/** 起こしデーモンの領域名 → 司令塔の agent id(`domains/<領域>/coordinator_id`)。 */
export type DomainCoordinators = Readonly<Record<string, string>>;

export interface RoutingContext {
  registry: readonly RegistryEntry[];
  domainCoordinators: DomainCoordinators;
}

export const EMPTY_ROUTING: RoutingContext = { registry: [], domainCoordinators: {} };

export type DestinationReason = "parent" | "self" | "domain" | "general" | "unresolved";

export interface CardDestination {
  /** チャットを送る agent id。誰も決められなければ null(UI が従来どおり総司令塔へ振り替える)。 */
  id: string | null;
  /** 「この欄に答えるスレ」として画面に出す文字列(短ID+題名、未登録なら明示)。 */
  label: string;
  reason: DestinationReason;
  /** 投函元が登録簿に載っていたか。 */
  registered: boolean;
}

export const DOMAIN_LABEL: Readonly<Record<string, string>> = {
  f80: "F-80司令塔",
  topos_dev: "topos開発",
  paseo_ui: "Paseo UI",
  general: "総司令塔",
};

/** 登録簿に無い投函元の領域推定(ノートの id・題名・legacy key に含まれる語)。判定できなければ null。 */
const DOMAIN_HINTS: readonly (readonly [string, RegExp])[] = [
  ["f80", /f-?80/i],
  ["topos_dev", /topos[-_ ]?dev/i],
  ["paseo_ui", /paseo|確認箱|サイドバー/i],
];

export function inferDomain(hint: string): string | null {
  for (const [domain, re] of DOMAIN_HINTS) if (re.test(hint)) return domain;
  return null;
}

const shortId = (id: string): string => id.slice(0, 7);

function matchId(candidate: string, id: string): boolean {
  return candidate === id || (candidate.length >= 6 && id.startsWith(candidate));
}

function findRegistry(registry: readonly RegistryEntry[], thread: string): RegistryEntry | null {
  return registry.find((r) => matchId(thread, r.agentId)) ?? null;
}

function domainOfCoordinator(domains: DomainCoordinators, id: string): string | null {
  return Object.keys(domains).find((d) => domains[d] === id) ?? null;
}

function labelFor(id: string, title: string | null, domains: DomainCoordinators): string {
  const domain = domainOfCoordinator(domains, id);
  const name = (domain && DOMAIN_LABEL[domain]) || title || "";
  return name ? `${shortId(id)} ${name}` : shortId(id);
}

/**
 * @param threads ノート frontmatter の `threads:`(短ID可)
 * @param hint 領域推定に使う文字列(ノート id・題名・legacy key をつないだもの)
 */
export function resolveCardDestination(
  threads: readonly string[],
  hint: string,
  ctx: RoutingContext,
): CardDestination {
  const { registry, domainCoordinators: domains } = ctx;
  const poster = threads.map((t) => findRegistry(registry, t)).find((r) => r !== null) ?? null;
  const alive = (id: string): boolean => {
    const r = registry.find((e) => e.agentId === id);
    return !r || !r.archived; // 登録簿に居ない親(ユーザー直下スレ・司令塔)は、閉じているか分からないので生きている側に倒す(受容した残差)
  };
  const title = (id: string, fallback: string | null): string | null =>
    registry.find((e) => e.agentId === id)?.title ?? fallback;

  const generalId = domains.general ?? null;
  const domainPick = (domain: string | null): string | null => {
    const id = domain ? (domains[domain] ?? null) : null;
    return id && alive(id) ? id : null;
  };

  if (poster) {
    const upper = poster.parentAgentId;
    if (upper && alive(upper)) {
      return {
        id: upper,
        label: labelFor(upper, title(upper, poster.parentTitle), domains),
        reason: "parent",
        registered: true,
      };
    }
    if (!upper && !poster.archived) {
      return {
        id: poster.agentId,
        label: labelFor(poster.agentId, poster.title, domains),
        reason: "self",
        registered: true,
      };
    }
    // 上(または本人)が閉じている → 領域司令塔 → 総司令塔
    const topDomain = upper ? domainOfCoordinator(domains, upper) : null;
    const domain = topDomain ?? inferDomain(hint);
    const d = domainPick(domain);
    if (d) {
      return { id: d, label: labelFor(d, null, domains), reason: "domain", registered: true };
    }
  } else {
    // 司令塔自身が投函した(threads に司令塔のID)なら、その司令塔が答える
    const self = threads
      .flatMap((t) => Object.values(domains).filter((c) => matchId(t, c)))
      .find((c) => alive(c));
    if (self) {
      return { id: self, label: labelFor(self, null, domains), reason: "self", registered: false };
    }
    const d = domainPick(inferDomain(hint));
    if (d) {
      return {
        id: d,
        label: `未登録の投函元 → ${labelFor(d, null, domains)}`,
        reason: "domain",
        registered: false,
      };
    }
    if (generalId) {
      return {
        id: generalId,
        label: `未登録の投函元 → ${labelFor(generalId, null, domains)}`,
        reason: "general",
        registered: false,
      };
    }
    return {
      id: null,
      label: "未登録の投函元(答えるスレを決められません)",
      reason: "unresolved",
      registered: false,
    };
  }
  if (generalId) {
    return {
      id: generalId,
      label: labelFor(generalId, null, domains),
      reason: "general",
      registered: poster !== null,
    };
  }
  return {
    id: null,
    label: "答えるスレを決められません",
    reason: "unresolved",
    registered: poster !== null,
  };
}
