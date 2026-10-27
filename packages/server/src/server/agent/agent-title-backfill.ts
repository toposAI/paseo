import type { Logger } from "pino";
import {
  AGENT_TITLE_RETITLE_LABEL,
  AGENT_TITLE_SOURCE_LABEL,
  AGENT_TITLE_SOURCE_USER,
} from "@getpaseo/protocol/agent-title-limits";
import type { StoredAgentRecord } from "./agent-storage.js";

/** 既存スレの一括付け直しの合図に使うラベル(protocol が正本)。 */
export const TITLE_RETITLE_LABEL = AGENT_TITLE_RETITLE_LABEL;
/** 付け直しが済んだ印。`1` のまま残すと次の起動でまた走るため、必ず書き換える。 */
export const TITLE_RETITLE_DONE = "done";
/** 読み込み・閉じるが返ってこないときに一括処理ごと止まらないための上限。 */
export const TITLE_BACKFILL_IO_TIMEOUT_MS = 30_000;

export interface TitleBackfillDeps {
  listStored(): Promise<StoredAgentRecord[]>;
  /** すでにメモリに載っているか(載っていないものだけ、こちらで読み込んで閉じる)。 */
  isLoaded(agentId: string): boolean;
  /** 実行中のターンがあるか(あるスレは閉じない・触れるなら触らない)。 */
  isBusy(agentId: string): boolean;
  /** 履歴を読める状態にする(セッションを復元する)。 */
  ensureLoaded(agentId: string): Promise<void>;
  /** こちらで読み込んだものだけ閉じる(元から開いていたスレには触らない)。 */
  close(agentId: string): Promise<void>;
  /** 題名を付け直す。人が固定した題名(`user`)は触らない。書き換えたら true。 */
  retitle(agentId: string): Promise<boolean>;
  /** 付け直しの合図を落とす(`1` -> `done`)。 */
  markDone(agentId: string): Promise<void>;
  logger: Logger;
  ioTimeoutMs?: number;
}

export interface TitleBackfillResult {
  /** 合図が立っていたスレ(アーカイブ済み・内部用は数えない)。 */
  marked: number;
  /** 題名を書き換えたスレ。 */
  retitled: number;
  /** 読み込み・生成に失敗したスレ(題名は元のまま)。 */
  failed: number;
  /** 材料(最初のユーザー発言)が無くて付け直せなかったスレ。 */
  skipped: number;
  /** 実行中だったので触らず、合図も残したままにしたスレ(次の起動で再挑戦する)。 */
  busy: number;
  /** すでにアーカイブ済み・内部用だったので対象から外したスレ(合図は残す)。 */
  excluded: number;
}

/**
 * 合図(`paseo.title-retitle=1`)が立っているスレを対象に絞る。
 *
 * 常駐の役スレ(窓口B・裏方 など)は題名そのものが識別子になっている
 * (起動スクリプトと通知デーモンが名前で探す)。人が固定した題名は触らない。
 * 除外したものは合図を残す(役スレは合図の付与時点で判定しているので、後から
 * 対象化しない。アーカイブ済みはアーカイブ経路で扱う)。
 */
export function selectTitleBackfillTargets(records: readonly StoredAgentRecord[]): {
  targets: StoredAgentRecord[];
  excluded: number;
} {
  const isExcluded = (record: StoredAgentRecord) =>
    Boolean(record.archivedAt) ||
    Boolean(record.internal) ||
    record.labels?.[AGENT_TITLE_SOURCE_LABEL] === AGENT_TITLE_SOURCE_USER;
  const marked = records.filter((record) => record.labels?.[TITLE_RETITLE_LABEL] === "1");
  return {
    targets: marked.filter((record) => !isExcluded(record)),
    excluded: marked.filter(isExcluded).length,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`title backfill I/O timed out after ${ms}ms`)), ms);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 既存スレの題名を**一度だけ**LLMで付け直す。`paseo.title-retitle=1` を立てたスレだけが対象。
 *
 * なぜ起動時にやるか: 閉じているスレは履歴がメモリに無く、題名の材料(最初のユーザー発言)が
 * 取れない。デーモン起動直後に1本ずつ読み込み → 付け直し → 閉じる、を直列で行う。
 * 合図は成否にかかわらず `done` にする(失敗したスレで毎回やり直さない = 「1回だけ」)。
 * ただし実行中のスレには触らない(閉じるとターンを中断してしまう)。合図も残し、次の起動で拾い直す。
 *
 * 処理するのは**書き込みや返事の遅いスレから**。閉じているスレを1本復元するたびにターンが
 * 始まるので、最近まで動いていたスレの復元待ちで列の後ろが止まり、20分近く何も終わらないことが
 * あった(2026-10-27)。直列であること自体は変えない。
 */
export async function runTitleBackfill(deps: TitleBackfillDeps): Promise<TitleBackfillResult> {
  const ioTimeoutMs = deps.ioTimeoutMs ?? TITLE_BACKFILL_IO_TIMEOUT_MS;
  const result: TitleBackfillResult = {
    marked: 0,
    retitled: 0,
    failed: 0,
    skipped: 0,
    busy: 0,
    excluded: 0,
  };
  const stored = await deps.listStored();
  const { targets: selected, excluded } = selectTitleBackfillTargets(stored);
  result.excluded = excluded;
  const targets = [...selected].sort(byLeastRecentlyUpdated);
  result.marked = targets.length;
  if (targets.length === 0) return result;

  deps.logger.info({ count: targets.length }, "agent title backfill started");
  for (const record of targets) {
    const agentId = record.id;
    // 冒頭で載っていなかったスレだけ、こちらで読み込んで閉じる。載っていたスレは閉じない。
    let openedByUs = false;
    try {
      if (deps.isBusy(agentId)) {
        result.busy += 1;
        continue;
      }
      if (!deps.isLoaded(agentId)) {
        await withTimeout(deps.ensureLoaded(agentId), ioTimeoutMs);
        openedByUs = true;
      }
      const changed = await deps.retitle(agentId);
      if (changed) result.retitled += 1;
      else result.skipped += 1;
      await deps.markDone(agentId);
    } catch (error) {
      result.failed += 1;
      deps.logger.warn({ err: error, agentId }, "agent title backfill failed for agent");
      await deps.markDone(agentId).catch((markError) => logMarkFailure(deps, markError, agentId));
    } finally {
      if (openedByUs) {
        await closeIfIdle(deps, agentId, ioTimeoutMs);
      }
    }
  }
  deps.logger.info(result, "agent title backfill finished");
  return result;
}

/** 最後に動いてから長い順(読み込みで起きるターンが短いものから処理する)。 */
function byLeastRecentlyUpdated(a: StoredAgentRecord, b: StoredAgentRecord): number {
  const timeOf = (record: StoredAgentRecord) => Date.parse(record.updatedAt ?? "");
  const timeA = timeOf(a);
  const timeB = timeOf(b);
  const knownA = Number.isFinite(timeA);
  const knownB = Number.isFinite(timeB);
  if (knownA && knownB) return timeA - timeB;
  return Number(knownA) - Number(knownB);
}

function logMarkFailure(deps: TitleBackfillDeps, error: unknown, agentId: string): void {
  deps.logger.warn({ err: error, agentId }, "agent title backfill could not clear the label");
}

/** 閉じる直前にもう一度見る: 処理中に誰かが送っていたら、ターンごと閉じてしまわないように残す。 */
async function closeIfIdle(
  deps: TitleBackfillDeps,
  agentId: string,
  ioTimeoutMs: number,
): Promise<void> {
  if (deps.isBusy(agentId)) {
    deps.logger.info({ agentId }, "agent title backfill left an agent open (it became busy)");
    return;
  }
  await withTimeout(deps.close(agentId), ioTimeoutMs).catch((error) => {
    deps.logger.warn({ err: error, agentId }, "agent title backfill could not close agent");
  });
}
