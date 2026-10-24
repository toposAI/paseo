/**
 * `agents.list()` を**全ページ**辿る(サイドバーの行の取り込みと、見出しの親を開けるかの判定に使う)。
 *
 * なぜ要るか: 1回の呼び出しは既定で200件・**新しい順**しか返さない(`session.ts` の `limit ?? 200` /
 * `updated_at desc`)。1ページ目だけを見ると、後から建てたスレほど「一覧に無い」=見出しを押しても
 * 開けない、に落ちる(出口レビュー round2 指摘1)。スレは増え続けるので全ページを辿る。
 *
 * 呼び出し元(index.server.ts)から切り離してあるのは、縮退の経路(背景込みを断られたとき・途中の頁で
 * 失敗したとき)を偽の pager で単体テストするため(出口レビュー round3 指摘2b)。
 *
 * 辿る範囲の決め方(round3 指摘1):
 * - **アーカイブ済みは含めない**。親の判定は `markOpenableParents` が `archivedAt` で落とすので要らない。
 *   アーカイブ済みは増える一方なので、含めると頁数の上限で縮退し、症状(開けない見出し)が戻る。
 * - 背景のスレは含める(既定では返らないが、背景の中で建てた子スレの親になりうる)。
 *   ホストが背景ワークスペース非対応だと**同期的に throw** するので、そのときは背景無しで引き直す
 *   (`backgroundDropped = true`。背景のスレが親なら「一覧に無い」に見える=開閉のみ)。
 */
import type { ListedAgentLike } from "./unregistered-threads.js";

/** 1ページの上限(プロトコルの既定)と、辿るページ数の上限。 */
export const AGENT_PAGE_SIZE = 200;
export const AGENT_PAGE_LIMIT = 20;

export interface AgentPageQuery {
  filter?: { includeBackground?: boolean };
  page?: { limit: number; cursor?: string };
}

export interface AgentPage {
  entries: { agent: ListedAgentLike }[];
  pageInfo?: { nextCursor?: string | null } | null;
}

/** `ctx.paseo.agents` の読む所だけ(テストで差し替えられるようにする)。 */
export interface AgentPager {
  list(query?: AgentPageQuery): Promise<AgentPage>;
}

export interface ListAllAgentsResult {
  agents: ListedAgentLike[];
  /** 背景込みの一覧を断られ、背景無しで引き直した(=背景のスレが欠けうる)。 */
  backgroundDropped: boolean;
  /** 全ページを辿れなかった(途中の頁の失敗・頁数の上限)。`agents` はそこまで集めた分。 */
  truncated: boolean;
}

/**
 * 全ページを辿る。**全経路が失敗したときだけ throw する**(一覧そのものが引けない。呼び出し元が縮退する)。
 * 2ページ目以降の失敗と頁数の上限は `truncated: true` で返す(集めた分は使える)。
 */
export async function listAllAgents(
  pager: AgentPager,
  opts: { includeBackground?: boolean } = {},
): Promise<ListAllAgentsResult> {
  if (opts.includeBackground !== true) return await walk(pager, false);
  try {
    return await walk(pager, true);
  } catch {
    // 背景込みを断られた(古いホスト)。背景無しで最初から引き直す。
    const res = await walk(pager, false);
    return { ...res, backgroundDropped: true };
  }
}

async function walk(pager: AgentPager, background: boolean): Promise<ListAllAgentsResult> {
  const agents: ListedAgentLike[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < AGENT_PAGE_LIMIT; pageNo += 1) {
    let res: AgentPage;
    try {
      res = await pager.list({
        ...(background ? { filter: { includeBackground: true } } : {}),
        page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
    } catch (err) {
      // 1ページ目の失敗はここで throw する。背景込みを断られた場合は高階で背景無しにやり直す
      // (`requireBackgroundWorkspaces` は送信前に同期で throw するので、1ページ目で区別できる)。
      if (pageNo === 0) throw err;
      // 途中で切れた。ここまでに集めた分で判定する(足りない分は「一覧に無い」と同じ扱い)。
      return { agents, backgroundDropped: false, truncated: true };
    }
    for (const entry of res.entries) agents.push(entry.agent);
    cursor = res.pageInfo?.nextCursor ?? undefined;
    if (!cursor) return { agents, backgroundDropped: false, truncated: false };
  }
  // 頁数の上限に達した。ここまでで打ち切る(集めた分は使う)。
  return { agents, backgroundDropped: false, truncated: true };
}
