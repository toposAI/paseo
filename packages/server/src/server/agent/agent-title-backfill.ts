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

export interface TitleBackfillDeps {
  listStored(): Promise<StoredAgentRecord[]>;
  /** すでにメモリに載っているか(載っていないものだけ、こちらで読み込んで閉じる)。 */
  isLoaded(agentId: string): boolean;
  /** 履歴を読める状態にする(セッションを復元する)。 */
  ensureLoaded(agentId: string): Promise<void>;
  /** こちらで読み込んだものだけ閉じる(元から開いていたスレには触らない)。 */
  close(agentId: string): Promise<void>;
  /** 題名を付け直す。書き換えたら true。 */
  retitle(agentId: string): Promise<boolean>;
  /** 付け直しの合図を落とす(`1` -> `done`)。 */
  markDone(agentId: string): Promise<void>;
  logger: Logger;
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
}

/**
 * 既存スレの題名を**一度だけ**LLMで付け直す。`paseo.title-retitle=1` を立てたスレだけが対象。
 *
 * なぜ起動時にやるか: 閉じているスレは履歴がメモリに無く、題名の材料(最初のユーザー発言)が
 * 取れない。デーモン起動直後に1本ずつ読み込み → 付け直し → 閉じる、を直列で行う。
 * 合図は成否にかかわらず `done` にする(失敗したスレで毎回やり直さない = 「1回だけ」)。
 */
export async function runTitleBackfill(deps: TitleBackfillDeps): Promise<TitleBackfillResult> {
  const result: TitleBackfillResult = { marked: 0, retitled: 0, failed: 0, skipped: 0 };
  const stored = await deps.listStored();
  const targets = stored.filter(
    (record) =>
      record.labels?.[TITLE_RETITLE_LABEL] === "1" &&
      !record.archivedAt &&
      !record.internal &&
      // 常駐の役スレ(裏方・窓口B など)は題名そのものが識別子になっている
      // (起動スクリプトと通知デーモンが名前で探す)。人が固定した題名は触らない。
      record.labels?.[AGENT_TITLE_SOURCE_LABEL] !== AGENT_TITLE_SOURCE_USER,
  );
  result.marked = targets.length;
  if (targets.length === 0) return result;

  deps.logger.info({ count: targets.length }, "agent title backfill started");
  for (const record of targets) {
    const agentId = record.id;
    const wasLoaded = deps.isLoaded(agentId);
    try {
      if (!wasLoaded) await deps.ensureLoaded(agentId);
      const changed = await deps.retitle(agentId);
      if (changed) result.retitled += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      deps.logger.warn({ err: error, agentId }, "agent title backfill failed for agent");
    } finally {
      if (!wasLoaded) {
        await deps.close(agentId).catch((error) => {
          deps.logger.warn({ err: error, agentId }, "agent title backfill could not close agent");
        });
      }
      await deps.markDone(agentId).catch((error) => {
        deps.logger.warn({ err: error, agentId }, "agent title backfill could not clear the label");
      });
    }
  }
  deps.logger.info(result, "agent title backfill finished");
  return result;
}
