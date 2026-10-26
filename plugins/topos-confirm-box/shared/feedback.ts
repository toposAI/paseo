/**
 * 家族版/試用版 Topos の「バグ・要望報告」一覧の RPC 契約。
 *
 * データの正本は家族版の報告ファイル `<data_dir>/_feedback/reports/fb-<日付>-<時刻>-<hash>.json`
 * (家族版 `services/feedback.py` が1件1JSONで書く)。ここは**読み手の写し**で、書き換えない。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const FEEDBACK_KINDS = ["bug", "request"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: "バグ",
  request: "要望",
};

/** 進捗の段階(`server/feedback-progress.ts` が台帳と確認箱から導く。報告ファイルには書かない)。 */
export const FEEDBACK_PROGRESS_STAGES = [
  "received",
  "investigating",
  "awaiting_decision",
  "applying",
  "done",
  "stale",
] as const;
export type FeedbackProgressStage = (typeof FEEDBACK_PROGRESS_STAGES)[number];

export const FEEDBACK_PROGRESS_LABEL: Record<FeedbackProgressStage, string> = {
  received: "受付",
  investigating: "調査中",
  awaiting_decision: "判断待ち(修正済み・確認待ち)",
  applying: "反映中",
  done: "完了",
  stale: "⚠放置の疑い",
};

export const FeedbackProgressSchema = z.object({
  stage: z.enum(FEEDBACK_PROGRESS_STAGES),
  /** 1行の補足(日本語)。 */
  detail: z.string(),
  /** 調査中の子スレ id(あれば)。 */
  threadId: z.string().nullable(),
  /** 判断待ちの確認箱項目 id(あれば)。 */
  itemId: z.string().nullable(),
  /** 完了(done/rejected)。画面は既定で隠す。 */
  archived: z.boolean(),
});
export type FeedbackProgress = z.infer<typeof FeedbackProgressSchema>;

export const FeedbackReportSchema = z.object({
  /** `fb-YYYYMMDD-HHMMSS-xxxx`。ファイル名と一致する(契約)。 */
  id: z.string(),
  kind: z.enum(FEEDBACK_KINDS),
  title: z.string(),
  /** 本文。長すぎるものは読み手側で切る(画面が壊れないように)。 */
  text: z.string(),
  /** 家族版の `STATUSES`(new / will_do / hold / rejected / done)。未知も文字列のまま出す。 */
  status: z.string(),
  urgent: z.boolean(),
  /** 受付日時(ISO8601・文字列のまま。表示側で整形する)。 */
  createdAt: z.string(),
  /** 並べ替え用(ms)。日時が読めない報告は 0。 */
  ts: z.number(),
  /** 表示名(妻・妹など)。引けなければ報告元の id のまま。 */
  reporter: z.string(),
  /** 報告時に開いていた画面名。空なら非表示。 */
  screen: z.string(),
  appVersion: z.string(),
  /** 返信本文。未返信は null。 */
  reply: z.string().nullable(),
  /** 返信を報告者が見たか。 */
  replySeen: z.boolean(),
  hasScreenshot: z.boolean(),
  /** どのディレクトリの報告か(家族版/試用版の区別)。 */
  origin: z.string(),
  /** 進捗(台帳から導出)。古いサーバー応答には無いので optional。 */
  progress: FeedbackProgressSchema.optional(),
});
export type FeedbackReport = z.infer<typeof FeedbackReportSchema>;

/** 出所ごとの状態。空の一覧を「故障」と誤読しないために画面へ出す(確認箱本体と同じ作法)。 */
export const FeedbackSourceStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  count: z.number().int(),
});
export type FeedbackSourceStatus = z.infer<typeof FeedbackSourceStatusSchema>;

export const feedbackReportsListRpc = defineRpc({
  name: "topos.feedback.reports.list",
  input: z.object({}),
  output: z.object({
    reports: z.array(FeedbackReportSchema),
    sources: z.array(FeedbackSourceStatusSchema),
    generatedAt: z.number(),
  }),
});
export type FeedbackReportsListOutput = z.infer<typeof feedbackReportsListRpc.output>;

/** 一覧に出す上限(古い報告で画面と通信を膨らませない)。新しい順に切る。 */
export const FEEDBACK_REPORT_LIMIT = 300;
export const FEEDBACK_TEXT_MAX = 4000;
export const FEEDBACK_TITLE_MAX = 200;
export const FEEDBACK_REPLY_MAX = 2000;

/** 未対応(=まだ誰も着手していない)報告の件数。一覧の見出し(「うち受付N件」)に使う。 */
export function countNewReports(reports: readonly FeedbackReport[]): number {
  return reports.filter((r) => r.status === "new").length;
}

/** 家族版の報告ステータスのうち「終わった」もの(`archived` と同じ意味)。 */
export const FEEDBACK_DONE_STATUSES = ["done", "rejected"] as const;

/**
 * その報告が終わっているか。`progress`(サーバーが台帳から導出)を正とし、
 * 台帳が無い古い応答だけ status で代用する。
 */
export function isReportComplete(r: FeedbackReport): boolean {
  if (r.progress) return r.progress.archived;
  return (FEEDBACK_DONE_STATUSES as readonly string[]).includes(r.status);
}

/**
 * バッジ=**まだ終わっていない**報告の数(2026-10-26 ユーザー判断
 * 「完了してないバグ報告の数を表示して」)。完了(対応済み・見送り)は数えない。
 * 一覧は「完了だが家族が返信をまだ読んでいない」行だけ既定でも残すが、それは
 * 管理者の仕事が残っているわけではないのでバッジには数えない(数えるのは未完了だけ)。
 */
export function countOpenReports(reports: readonly FeedbackReport[]): number {
  return reports.filter((r) => !isReportComplete(r)).length;
}
