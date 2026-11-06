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
  /** 登録簿の状態(`待機`/`完了` など)。題名で司令塔を引くとき、旧スレ(完了)を外すのに使う。 */
  status?: string;
  /** 登録簿の更新時刻(ms)。同名が複数あるときの新しい方の判定に使う。 */
  updatedAt?: number;
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
  ["topos_dev", /topos[-_ ]?dev|topos|家族版|家族報告|家族から/i],
  ["paseo_ui", /paseo|確認箱|サイドバー/i],
];

export function inferDomain(hint: string): string | null {
  for (const [domain, re] of DOMAIN_HINTS) if (re.test(hint)) return domain;
  return null;
}

/**
 * Topos製品(家族報告・家族版/個人版Topos)のカードか。
 * 2026-11-06 ユーザー再指摘「Toposに関することは確認箱から総司令塔じゃなくて、Topos司令塔と
 * 話せるようにして」。投函元が登録簿に無い家族報告のカードは、これまで宛先なし=総司令塔へ
 * 振り替えられていた。題名・key がTopos製品を指すときだけ、登録簿の題名からTopos司令塔を引く。
 */
const TOPOS_HINT_RE = /(?<![A-Za-z])(?:topos(?![\s_-]?ai)|家族版|家族報告|家族から)/i;
const TOPOS_COMMANDER_TITLE = "Topos司令塔";

export function isToposHint(hint: string): boolean {
  return TOPOS_HINT_RE.test(hint);
}

/**
 * 登録簿から題名一致の**生きている**司令塔を引く(ハードコードしない=交代しても追随する)。
 * `archived` と状態「完了」の行は使わない。同名が複数なら更新時刻が新しい方。
 */
function commanderByTitle(registry: readonly RegistryEntry[], title: string): string | null {
  let best: RegistryEntry | null = null;
  for (const r of registry) {
    if (r.title.trim() !== title) continue;
    if (r.archived) continue;
    if (["完了", "done", "closed"].includes((r.status ?? "").trim())) continue;
    if (!best || (r.updatedAt ?? 0) >= (best.updatedAt ?? 0)) best = r;
  }
  return best?.agentId ?? null;
}

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
  return name || "名前のないスレ";
}

/** Topos製品のカードを Topos司令塔へ回す宛先(登録簿の題名から引く。引けなければ null)。 */
function toposDestination(
  registry: readonly RegistryEntry[],
  domains: DomainCoordinators,
): CardDestination | null {
  const topos = commanderByTitle(registry, TOPOS_COMMANDER_TITLE);
  if (!topos) return null;
  return {
    id: topos,
    label: labelFor(topos, TOPOS_COMMANDER_TITLE, domains),
    reason: "domain",
    registered: false,
  };
}

/** 投函元が登録簿に居ないとき(司令塔本人か、記録がまだ無い)の宛先。 */
function routeWithoutPoster(
  threads: readonly string[],
  hint: string,
  registry: readonly RegistryEntry[],
  domains: DomainCoordinators,
  generalId: string | null,
): CardDestination {
  const alive = (id: string): boolean => {
    const r = registry.find((e) => e.agentId === id);
    return !r || !r.archived;
  };
  const self = threads
    .flatMap((t) => Object.values(domains).filter((c) => matchId(t, c)))
    .find((c) => alive(c));
  if (self) {
    // 登録簿にまだ載っていない総司令塔が投函した Topos製品のカードも、本人ではなく Topos司令塔へ
    // (登録簿に行がある場合は poster 側で同じ判定をしている。2026-11-06 出口レビュー3巡目 指摘1)
    if (generalId && self === generalId && isToposHint(hint)) {
      const topos = toposDestination(registry, domains);
      if (topos) return topos;
    }
    return { id: self, label: labelFor(self, null, domains), reason: "self", registered: false };
  }
  // 投函元が分からない/登録簿に居ない。Topos製品のカード(家族報告など)だけは、登録簿の
  // 題名からTopos司令塔を引いて届ける(2026-11-06 ユーザー再指摘)。それ以外は従来どおり
  // 別のスレへ流さない(fail-closed)。
  if (isToposHint(hint)) {
    const topos = toposDestination(registry, domains);
    if (topos) return topos;
  }
  return {
    id: null,
    label: threads.length ? "投函元不明(登録簿にありません)" : "投函元不明",
    reason: "unresolved",
    registered: false,
  };
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
    // topos_dev は状態ファイルのIDが旧司令塔(退役)のまま残ることがある。題名で引き直せるなら
    // そちらを優先する(2026-11-06 実測: domains/topos_dev/coordinator_id は旧IDのまま)。
    if (domain === "topos_dev") {
      const byName = commanderByTitle(registry, TOPOS_COMMANDER_TITLE);
      if (byName) return byName;
    }
    const id = domain ? (domains[domain] ?? null) : null;
    return id && alive(id) ? id : null;
  };

  const toposRedirect = (): CardDestination | null => toposDestination(registry, domains);

  if (poster) {
    // 2026-11-06: 答えるのは投函元本人(子司令塔)。登録簿の親(窓口など)へは流さない。
    // 閉じているだけのスレは送れば再開する。アーカイブ済みのときだけ次点(親→領域→総司令塔)へ。
    if (!poster.archived) {
      // 投函元が総司令塔でも、Topos製品のカードは Topos司令塔と話す(2026-11-06 ユーザー逐語
      // 「総司令塔じゃなくて、Topos司令塔と話せるように」)。投函元が子スレ・子司令塔のときは
      // 文脈を持つ本人を優先する(従来どおり)。
      if (generalId && poster.agentId === generalId && isToposHint(hint)) {
        const topos = toposRedirect();
        if (topos) return topos;
      }
      return {
        id: poster.agentId,
        label: labelFor(poster.agentId, poster.title, domains),
        reason: "self",
        registered: true,
      };
    }
    const upper = poster.parentAgentId;
    if (upper && alive(upper)) {
      return {
        id: upper,
        label: labelFor(upper, title(upper, poster.parentTitle), domains),
        reason: "parent",
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
    return routeWithoutPoster(threads, hint, registry, domains, generalId);
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
