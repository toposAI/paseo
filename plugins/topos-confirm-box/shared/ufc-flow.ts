/**
 * 「UIの最終チェック」カードを順に片付ける流れ(純関数。画面からも試験からも使う)。
 *
 * - 見ているカード(current)は1枚だけ。OK するとそのカードは一覧から消え、次の未回答カードが出る。
 * - 「直してほしい」を投函元へ送ったカードは「返事待ち」(waiting)として残し、すぐ次の未回答カードへ進む。
 * - 返事待ちのカードに投函元の返事が届いたら未読(unread)の印を付ける。見ているカードは勝手に切り替えない。
 *   見ているカードへ返事が届いたときは、すでに見えているので印は付けない。
 */
export interface UfcFlow {
  current: string | null;
  waiting: string[];
  unread: string[];
}

export const UFC_FLOW_EMPTY: UfcFlow = { current: null, waiting: [], unread: [] };

export type UfcStatus = "open" | "waiting" | "unread";

export function ufcStatus(flow: UfcFlow, id: string): UfcStatus {
  if (flow.unread.includes(id)) return "unread";
  if (flow.waiting.includes(id)) return "waiting";
  return "open";
}

/** from の次(巡回)で、返事待ちでない最初のカード。無ければ null。 */
export function nextOpen(ids: readonly string[], from: string | null, waiting: readonly string[]) {
  if (ids.length === 0) return null;
  const start = from === null ? -1 : ids.indexOf(from);
  for (let step = 1; step <= ids.length; step += 1) {
    const id = ids[(start + step + ids.length) % ids.length];
    if (id !== undefined && id !== from && !waiting.includes(id)) return id;
  }
  return null;
}

export interface UfcCounts {
  /** まだ自分が見るべき数(返事待ちを除く)。 */
  remaining: number;
  waiting: number;
  unread: number;
}

export function ufcCounts(ids: readonly string[], flow: UfcFlow): UfcCounts {
  const waiting = ids.filter((id) => flow.waiting.includes(id));
  return {
    remaining: ids.length - waiting.length,
    waiting: waiting.length,
    unread: ids.filter((id) => flow.unread.includes(id)).length,
  };
}

/** 投函元へ送った: そのカードを返事待ちにして、次の未回答カードへ進む(無ければそのまま)。 */
export function afterSent(flow: UfcFlow, ids: readonly string[], id: string): UfcFlow {
  const waiting = flow.waiting.includes(id) ? flow.waiting : [...flow.waiting, id];
  const next = nextOpen(ids, id, waiting);
  const current = flow.current === id ? (next ?? id) : flow.current;
  // 進んだ先のカードは見えているので、未読の印は外す。
  const unread = flow.unread.filter((x) => x !== id && x !== current);
  return { current, waiting, unread };
}

/** 返事が届いた: 見ているカードなら印なし、見ていなければ未読の印。返事待ちは解く。 */
export function afterReply(flow: UfcFlow, id: string): UfcFlow {
  if (!flow.waiting.includes(id)) return flow;
  const waiting = flow.waiting.filter((x) => x !== id);
  const unread =
    flow.current === id || flow.unread.includes(id) ? flow.unread : [...flow.unread, id];
  return { ...flow, waiting, unread };
}

/** カードを選んだ(一覧・未読の印から戻る/後回し)。未読の印は外す。 */
export function select(flow: UfcFlow, id: string): UfcFlow {
  return { ...flow, current: id, unread: flow.unread.filter((x) => x !== id) };
}

/** 「次へ」: 見ているカードは残したまま、次の未回答カードへ。 */
export function skipToNext(flow: UfcFlow, ids: readonly string[]): UfcFlow {
  const next = nextOpen(ids, flow.current, flow.waiting);
  return next === null ? flow : select(flow, next);
}

/** 一覧が変わった(OK で消えた・新着)。消えたカードの印を落とし、見ているカードが消えたら次へ。 */
export function reconcile(
  flow: UfcFlow,
  prevIds: readonly string[],
  ids: readonly string[],
): UfcFlow {
  const waiting = flow.waiting.filter((x) => ids.includes(x));
  let current = flow.current;
  if (current === null || !ids.includes(current)) {
    // 消えたカードの直後(前の並びでの次)を優先する。
    const at = current === null ? -1 : prevIds.indexOf(current);
    const after = at < 0 ? [] : prevIds.slice(at + 1).filter((x) => ids.includes(x));
    current =
      after.find((x) => !waiting.includes(x)) ?? nextOpen(ids, null, waiting) ?? ids[0] ?? null;
  }
  const unread = flow.unread.filter((x) => ids.includes(x) && x !== current);
  if (
    current === flow.current &&
    waiting.length === flow.waiting.length &&
    unread.length === flow.unread.length
  ) {
    return flow;
  }
  return { current, waiting, unread };
}
