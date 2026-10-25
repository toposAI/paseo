/**
 * 報告の進捗を、既にある成果物から**導出**する(読むだけ・新しい状態ストアを作らない)。
 *
 * 材料: 報告JSON の status / 取込台帳(`feedback_intake_ledger.json`)/ 承認台帳(`feedback_approval_ledger.json`)/
 * 確認箱の項目(source=feedback_auto)。設計: `.claude-memory/design_family_feedback_progress_and_archive_20261022.md` §2。
 *
 * 台帳が読めない・壊れているときは「空」として扱い**受付に倒す**(表示が消えるより未処理に見える方が安全)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfirmBoxItem } from "../shared/contract.js";
import type { FeedbackProgress, FeedbackReport } from "../shared/feedback.js";

export const DEFAULT_LEDGER_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "toposai",
  "coordinator_wakeup_daemon",
);
/** 受付(または調査開始)から進展が無いまま、この時間を超えたら放置の疑い。 */
export const STALE_MS = 24 * 3600 * 1000;

interface IntakeEntry {
  state?: string;
  agent_id?: string;
  /** 秒(Python の time.time())。 */
  at?: number;
}
interface StepEntry {
  state?: string;
}
export interface ProgressContext {
  intake: Record<string, IntakeEntry>;
  approvalItems: Record<string, { steps?: Record<string, StepEntry> }>;
  /** source=feedback_auto の確認箱項目。 */
  boxItems: readonly ConfirmBoxItem[];
  now: number;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asRecord<T>(v: unknown): Record<string, T> {
  return v && typeof v === "object" ? (v as Record<string, T>) : {};
}

export function loadProgressContext(
  boxItems: readonly ConfirmBoxItem[],
  now: number = Date.now(),
  ledgerDir: string = process.env.TOPOS_FEEDBACK_LEDGER_DIR || DEFAULT_LEDGER_DIR,
): ProgressContext {
  return {
    intake: asRecord<IntakeEntry>(
      readJson(path.join(ledgerDir, "feedback_intake_ledger.json")).reports,
    ),
    approvalItems: asRecord<{ steps?: Record<string, StepEntry> }>(
      readJson(path.join(ledgerDir, "feedback_approval_ledger.json")).items,
    ),
    boxItems: boxItems.filter((i) => i.source === "feedback_auto"),
    now,
  };
}

/** 項目の key は `fb-<報告ID>` または報告ID そのもの(投函側で揺れている)。末尾一致で引く。 */
function findItem(reportId: string, items: readonly ConfirmBoxItem[]): ConfirmBoxItem | null {
  return items.find((i) => i.key !== null && i.key.endsWith(reportId)) ?? null;
}

const make = (
  stage: FeedbackProgress["stage"],
  detail: string,
  extra: Partial<FeedbackProgress> = {},
): FeedbackProgress => ({ stage, detail, threadId: null, itemId: null, archived: false, ...extra });

/** 確認箱に項目がある報告の進捗(判断待ち → 反映中 → 完了、止まれば放置)。 */
function progressForItem(
  item: ConfirmBoxItem,
  ctx: ProgressContext,
  threadId: string | null,
  replied: string,
): FeedbackProgress {
  const steps = Object.values(ctx.approvalItems[item.id]?.steps ?? {});
  const at = { threadId, itemId: item.id };
  if (item.state !== "approved") return make("awaiting_decision", `あなたの判断待ち${replied}`, at);
  if (steps.some((s) => s.state === "returned")) {
    return make("stale", "承認後の処理が止まりました。確認箱の【要確認】を見てください", at);
  }
  if (steps.length > 0 && steps.every((s) => s.state === "done")) {
    return make("done", `処理完了(状態の書き戻し待ち)${replied}`, at);
  }
  return make("applying", `承認済み・反映と返信を処理中${replied}`, at);
}

/** 確認箱にまだ項目が無い報告の進捗(受付 → 調査中。24時間進展が無ければ放置)。 */
function progressForIntake(
  report: Pick<FeedbackReport, "id" | "ts">,
  ctx: ProgressContext,
  threadId: string | null,
): FeedbackProgress {
  const ent = ctx.intake[report.id];
  if (ent?.state === "gave_up")
    return make("stale", "自動受付が断念しました(要手動対応)", { threadId });
  const since = typeof ent?.at === "number" ? ent.at * 1000 : report.ts;
  const stale = since > 0 && ctx.now - since > STALE_MS;
  if (ent?.state === "spawned" || ent?.state === "attached") {
    return stale
      ? make("stale", "調査を始めて24時間たっても確認箱に出ていません", { threadId })
      : make("investigating", "子スレが調査・修正中", { threadId });
  }
  return stale
    ? make("stale", "受付から24時間、着手の記録がありません")
    : make("received", "受付済み(着手待ち)");
}

export function deriveProgress(
  report: Pick<FeedbackReport, "id" | "status" | "ts" | "reply">,
  ctx: ProgressContext,
): FeedbackProgress {
  const replied = report.reply ? "・返信済み" : "";
  if (report.status === "done") return make("done", `対応済み${replied}`, { archived: true });
  if (report.status === "rejected") return make("done", `見送り${replied}`, { archived: true });
  const agentId = ctx.intake[report.id]?.agent_id;
  const threadId = typeof agentId === "string" ? agentId : null;
  const item = findItem(report.id, ctx.boxItems);
  return item
    ? progressForItem(item, ctx, threadId, replied)
    : progressForIntake(report, ctx, threadId);
}
