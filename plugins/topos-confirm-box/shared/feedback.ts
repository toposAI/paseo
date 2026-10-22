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

export const FeedbackReportSchema = z.object({
  /** `fb-YYYYMMDD-HHMMSS-xxxx`。ファイル名と一致する(契約)。 */
  id: z.string(),
  kind: z.enum(FEEDBACK_KINDS),
  title: z.string(),
  /** 本文。長すぎるものは読み手側で切る(画面が壊れないように)。 */
  text: z.string(),
  /** `new` / `doing` / `done` など家族版のパイプラインが進める値。未知も文字列のまま出す。 */
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

/** 未対応(=まだ誰も着手していない)報告の件数。バッジに使う。 */
export function countNewReports(reports: readonly FeedbackReport[]): number {
  return reports.filter((r) => r.status === "new").length;
}
