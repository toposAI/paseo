/**
 * 確認箱の「スレを開く」の実行。開くスレを決め(`resolveThreadTarget`)、PC幅なら右カラム
 * (`placement: "right"`)で、狭い幅なら従来どおり遷移で開く。
 *
 * 2026-10-27: 宛先のスレが開けなくなるとアプリは右カラムに置けず、確認箱ごと全画面で入れ替わっていた。
 * 開く前に「宛先のスレが一覧に居るか(アーカイブ済みでないか)」を1件だけ引いて確かめ、居なければ
 * 持ち主のスレへ振り替える(振り替えた/開けないときは理由を1行出す)。
 */
import { getPaseoClient } from "@getpaseo/plugin/client";
import { inferDomain } from "../shared/card-pane.js";
import type { DirectoryAgent, ThreadTargetResult } from "./thread-target.js";
import { reportThreadTarget, resolveThreadTarget } from "./thread-target.js";

/** スレを引く間の上限。引けなくても開くこと自体は止めない(全画面へ落とすだけ)。 */
const LIST_TIMEOUT_MS = 3_000;
export const READ_FAILED_NOTICE =
  "スレの状態を引けなかったので、全画面で開きました";

/** 引いて確かめるスレ1件の状態。`archivedAt` が空なら開ける。 */
export type AgentRead = DirectoryAgent | null;

/**
 * スレを1件引く。引けなければ null(=確かめられない)。アーカイブ済みでも状態つきで返る。
 *
 * **一覧(`agents.list`)は引かない**(2026-10-27 出口レビュー round2 指摘1): アーカイブ済み込みの全件を
 * 返すので、この環境(実測 2,426 件)では3秒を待っても返らない。宛先の生死を見るには1件で足りる。
 */
export async function readAgent(
  serverId: string,
  agentId: string
): Promise<AgentRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), LIST_TIMEOUT_MS);
  });
  try {
    const snap = await Promise.race([
      getPaseoClient(serverId).agents.ref(agentId).refresh(),
      deadline,
    ]);
    const agent = snap?.agent as
      | { archivedAt?: unknown; status?: unknown }
      | undefined;
    if (!agent) return null;
    return {
      id: agentId,
      archivedAt: agent.archivedAt ?? null,
      status: agent.status ?? null,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface OpenThreadContext {
  /** 右カラムで開く配置(PC幅で「スレを開く」を押したとき)。無ければ従来どおり遷移。 */
  placement?: "right";
  /**
   * 確認箱自身のペインに今出ている相手(`?card=`/`?thread=`)。開くスレと同じなら、右カラムへもう1枚
   * 並べずに**確認箱のペインを外して主ペインにする**(同じ相手が2枚並ぶのを防ぐ。2026-10-27)。
   * カードの `answerId` は「そのカードが今出している相手」。分からない(null)なら畳まない。
   */
  currentPane?: {
    kind: "card" | "thread";
    id: string;
    answerId?: string | null;
  } | null;
  /** 開くカードの題名(管轄の推測に使う)。 */
  title?: string | null;
  /** サーバが返す総司令塔のID(取得前・失敗は undefined)。 */
  coordinatorId?: string | null;
  /** 領域名 → 司令塔のID。取得前・失敗は undefined(振り替えの候補に使わない)。 */
  domainCoordinators?: Readonly<Record<string, string>> | undefined;
  /** URL から直接開いた(カードの投函元が分からない)ペインか。そのときは題名から管轄を推測しない。 */
  direct?: boolean;
}

/**
 * 確認箱のペインに今出ている相手が `agentId` と同じか。カードは「そこに出す相手」=`answerId` で判定する
 * (`?card=` はカードIDなので、同じカードでも答えの宛先が別スレなら同じではない)。
 * 分からない(null)ときは畳まない — 「分からない」を「同じ」と取り違えると、右に並ぶはずの相手が消える。
 */
export function showsSameThread(
  current:
    | { kind: "card" | "thread"; id: string; answerId?: string | null }
    | null
    | undefined,
  agentId: string
): boolean {
  if (!current) return false;
  if (current.kind === "thread") return current.id === agentId;
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
  /** スレ1件の状態読み(テスト用)。既定は `readAgent`。 */
  readAgent?: (agentId: string) => Promise<AgentRead>;
}): Promise<ThreadTargetResult | null> {
  const { serverId, context, open, onFold, onNotice } = input;
  const read = input.readAgent ?? ((id: string) => readAgent(serverId, id));
  const placement = context.placement ? { placement: "right" as const } : {};

  const openAs = async (agentId: string, result: ThreadTargetResult) => {
    if (result.notice) onNotice?.(result.notice);
    reportThreadTarget(result);
    await open({ agentId, ...placement });
    return result;
  };

  /**
   * 宛先の決め手(`resolveThreadTarget`)に渡す「引いて確かめた一覧」。宛先・題名の管轄の司令塔・
   * この欄に答えるスレ(親)・総司令塔の4件だけを並行で引き、読めたものだけを入れる。
   * 振り替えの順番(領域司令塔→親→総司令塔)と推測しない規則は `resolveThreadTarget` の1箇所に任せる。
   */
  const verify = async (agentId: string): Promise<DirectoryAgent[]> => {
    const title = context.direct === true ? null : context.title ?? null;
    const domain = title ? inferDomain(title) : null;
    const ids = [
      agentId,
      domain ? context.domainCoordinators?.[domain] : null,
      input.destination,
      context.coordinatorId,
    ].filter((id): id is string => Boolean(id));
    const unique = [...new Set(ids)];
    const reads = await Promise.all(unique.map((id) => read(id)));
    return reads.filter((a): a is DirectoryAgent => a !== null);
  };

  /** 決まった宛先を、確認箱のペインと同じ相手なら主ペインで、そうでなければ右カラムで開く。 */
  const openThread = async (agentId: string): Promise<ThreadTargetResult> => {
    if (context.placement && showsSameThread(context.currentPane, agentId)) {
      // 主ペイン化は**確認箱のペインを外す**ので、「今そこに出ている相手」が本当に居るかを先に確かめる
      // (降りた購読で古いまま残っていないか。出口レビュー round2 指摘2)。引けない・閉じているなら畳まない。
      const live = await read(agentId);
      if (live !== null && live.archivedAt == null) {
        onFold?.();
        await open({ agentId });
        return { agentId, reason: "resolved", notice: null };
      }
    }
    const directory = await verify(agentId);
    if (!directory.some((a) => a.id === agentId)) {
      // 宛先を引けなかった=開けるか分からない。右カラムは諦め(全画面)、宛先はそのまま開く。
      return openAs(agentId, {
        agentId,
        reason: "no-live-thread",
        notice: READ_FAILED_NOTICE,
      });
    }
    const title = context.direct === true ? null : context.title ?? null;
    const result = resolveThreadTarget({
      target: agentId,
      destination: input.destination ?? null,
      title,
      coordinatorId: context.coordinatorId,
      directory,
      inferDomain,
      domainCoordinators: context.domainCoordinators,
    });
    if (result.agentId === null) {
      // 宛先も代わりも引けなかった。開くスレが決まらないので理由だけ出す。
      onNotice?.(result.notice ?? READ_FAILED_NOTICE);
      return result;
    }
    return openAs(result.agentId, result);
  };

  const target = input.target ?? input.destination ?? null;
  if (!target) return null;
  if (!serverId && !input.readAgent) {
    // 接続先が分からない。確かめられないので従来どおり開く(理由だけ出す)。
    console.warn("[Plugins] Confirm box thread target: host-unavailable");
    await open({ agentId: target });
    onNotice?.(READ_FAILED_NOTICE);
    return {
      agentId: target,
      reason: "no-live-thread",
      notice: READ_FAILED_NOTICE,
    };
  }
  return openThread(target);
}
