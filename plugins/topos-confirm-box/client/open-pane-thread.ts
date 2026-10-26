/**
 * 確認箱の「スレを開く」の実行。開くスレを決め(`resolveThreadTarget`)、PC幅なら右カラム
 * (`placement: "right"`)で、狭い幅なら従来どおり遷移で開く。
 *
 * 2026-10-27: 宛先のスレが一覧に無いとアプリは右カラムに置けず、確認箱ごと全画面で入れ替わっていた。
 * 開く前に一覧で確かめ、持ち主のスレへ振り替える(振り替えた/開けないときは理由を1行出す)。
 */
import { getPaseoClient } from "@getpaseo/plugin/client";
import { inferDomain } from "../shared/card-pane.js";
import type { DirectoryAgent, ThreadTargetResult } from "./thread-target.js";
import { reportThreadTarget, resolveThreadTarget } from "./thread-target.js";

/** スレ一覧を引く間の上限。引けなくても開くこと自体は止めない(全画面へ落とすだけ)。 */
const LIST_TIMEOUT_MS = 3_000;
/** 一覧の回数上限(1ページ200件。通常は1回で足りる)。 */
const LIST_MAX_PAGES = 5;
export const LIST_FAILED_NOTICE = "スレの一覧を引けなかったので、全画面で開きました";

export interface OpenThreadContext {
  /** 右カラムで開く配置(PC幅で「スレを開く」を押したとき)。無ければ従来どおり遷移。 */
  placement?: "right";
  /**
   * 確認箱自身のペインに今出ている相手(`?card=`/`?thread=`)。開くスレと同じなら、右カラムへもう1枚
   * 並べずに**確認箱のペインを外して主ペインにする**(同じ相手が2枚並ぶのを防ぐ。2026-10-27)。
   * カードの `answerId` は「そのカードが今出している相手」。分からない(null)なら畳まない。
   */
  currentPane?: { kind: "card" | "thread"; id: string; answerId?: string | null } | null;
  /** 開くカードの題名(管轄の推測に使う)。 */
  title?: string | null;
  /** サーバが返す総司令塔のID(取得前・失敗は undefined)。 */
  coordinatorId?: string | null;
  hubIds?: readonly string[] | undefined;
  /** 領域名 → 司令塔のID。取得前・失敗は undefined(振り替えの候補に使わない)。 */
  domainCoordinators?: Readonly<Record<string, string>> | undefined;
  /** URL から直接開いた(カードの投函元が分からない)ペインか。そのときはカードの周辺の取得をしない。 */
  direct?: boolean;
}

/**
 * Paseo に載っているスレ(アーカイブ済み込み)。引けなければ null(=確かめられない)。
 * ただし `null` は「一覧に無い」とは言い換えない — 引けなかっただけなので、右カラムは諦めるが
 * 宛先はそのまま開く(理由は別の文言で出す)。
 */
export async function listDirectory(serverId: string): Promise<DirectoryAgent[] | null> {
  const client = getPaseoClient(serverId);
  const out: DirectoryAgent[] = [];
  let cursor: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), LIST_TIMEOUT_MS);
  });
  try {
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const res = await Promise.race([
        client.agents.list({
          filter: { includeArchived: true },
          ...(cursor ? { page: { limit: 200, cursor } } : { page: { limit: 200 } }),
        } as Parameters<typeof client.agents.list>[0]),
        deadline,
      ]);
      for (const entry of res.entries) {
        const agent = entry.agent as {
          id?: unknown;
          archivedAt?: unknown;
          status?: unknown;
        };
        if (typeof agent.id === "string") {
          out.push({
            id: agent.id,
            archivedAt: agent.archivedAt ?? null,
            status: agent.status ?? null,
          });
        }
      }
      const next: string | null | undefined = res.pageInfo.nextCursor;
      if (!res.pageInfo.hasMore || !next) return out;
      cursor = next;
    }
    // 上限まで読んでも終わらない=一覧を確かめられない。**部分的に読めた一覧を「全部」と取り違えない**
    // (入っていないスレを「一覧に無い=閉じている」と扱って振り替えない。2026-10-27 round1 F3)。
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 確認箱のペインに今出ている相手が `agentId` と同じか。カードは「そこに出す相手」=`answerId` で判定する
 * (`?card=` はカードIDなので、同じカードでも答えの宛先が別スレなら同じではない)。
 */
export function showsSameThread(
  current: { kind: "card" | "thread"; id: string; answerId?: string | null } | null | undefined,
  agentId: string,
): boolean {
  if (!current) return false;
  if (current.kind === "thread") return current.id === agentId;
  // カードは「そこに今出している相手」で判定する。分からない(null)は畳まない(安全側=右に開く)。
  const shown = current.answerId ?? null;
  return shown !== null && agentId === shown;
}

/** 「スレを開く」を押したときの処理。決まった宛先を1回だけ開く。 */
export async function openThreadInPane(input: {
  serverId: string;
  /** 開くスレ(投函の `thread_id`)。null なら `destination` を開く。 */
  target: string | null;
  /** 開くスレが閉じているときの次点(この欄に答えるスレ)。 */
  destination?: string | null;
  context: OpenThreadContext;
  open: (input: { agentId: string; placement?: "right" }) => Promise<void>;
  /** 確認箱のペインを外す(内側のカードチャットを畳む)。主ペイン化するときに呼ぶ。 */
  onFold?: () => void;
  /** 振り替え/開けない理由の表示先(画面の1行)。 */
  onNotice?: (notice: string) => void;
}): Promise<ThreadTargetResult | null> {
  const { serverId, context, open, onFold, onNotice } = input;

  /** 決まった宛先を開く。確認箱のペインが同じ相手を出しているなら主ペイン化する。 */
  const openThread = async (agentId: string) => {
    // 右に同じ相手が2枚並ばないよう、確認箱のペインを外して主ペインで開く(2026-10-27)。
    const samePane = showsSameThread(context.currentPane, agentId);
    if (context.placement && samePane) {
      onFold?.();
      await open({ agentId });
      return;
    }
    await open({
      agentId,
      ...(context.placement ? { placement: context.placement } : {}),
    });
  };

  const target = input.target ?? input.destination ?? null;
  const destination = input.destination ?? null;
  if (!target) return null;
  if (!serverId) {
    // 接続先が分からない。確認はできないので従来どおり開く(理由だけ出す)。
    onNotice?.(LIST_FAILED_NOTICE);
    console.warn("[Plugins] Confirm box thread target: host-unavailable");
    await openThread(target);
    return {
      agentId: target,
      reason: "no-live-thread",
      notice: LIST_FAILED_NOTICE,
    };
  }
  const directory = await listDirectory(serverId);
  const result: ThreadTargetResult =
    directory === null
      ? {
          agentId: target,
          reason: "no-live-thread",
          notice: LIST_FAILED_NOTICE,
        }
      : resolveThreadTarget({
          target,
          destination,
          title: context.direct === true ? null : (context.title ?? null),
          coordinatorId: context.coordinatorId,
          hubIds: context.hubIds,
          directory,
          inferDomain,
          domainCoordinators: context.domainCoordinators,
        });
  reportThreadTarget(result);
  if (result.notice) onNotice?.(result.notice);
  if (!result.agentId) return result;
  await openThread(result.agentId);
  return result;
}
