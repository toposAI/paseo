/**
 * 統合確認箱の RPC 契約。クライアント(app バンドル)とサーバー(デーモン内サブプロセス)の
 * 両方がこのファイルを import する。**Node/React のどちらのAPIも使わない**こと。
 *
 * データ契約の正本は2つあり、ここはその写し:
 * - 箱ストア `events-YYYYMM.jsonl`: `packages/server/src/server/confirm-box/store.ts`
 *   と `antigravity/utils/notify_box.py`(両者が同じディスク契約を共有する)
 * - 中間形式 `pending_user_decisions.jsonl`: `antigravity/utils/confirm_box_ingest.py`
 *   (投函側が書き、`ingest-pending` が箱へ流し込む。**この版では未実行の分も直接見せる**)
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

// ---------------------------------------------------------------- 語彙(SSOTは store.ts)

/** 並び順の軸。`urgency`(緊急・push対象)とは別物。 */
export const ConfirmBoxPrioritySchema = z.enum(["blocking", "design", "normal", "info"]);
export type ConfirmBoxPriority = z.infer<typeof ConfirmBoxPrioritySchema>;

export const PRIORITIES: readonly ConfirmBoxPriority[] = ["blocking", "design", "normal", "info"];
export const DEFAULT_PRIORITY: ConfirmBoxPriority = "normal";

/** SSOT は Python 側 `notify_box.sort_items()`。順序は priority → subrank → group → ts降順。 */
export const PRIORITY_RANK: Record<ConfirmBoxPriority, number> = {
  blocking: 0,
  design: 1,
  normal: 2,
  info: 3,
};

export const PRIORITY_LABEL: Record<ConfirmBoxPriority, string> = {
  blocking: "停止中",
  design: "設計",
  normal: "通常",
  info: "参考",
};

/** 決めた時点でどこまで開いていたか(浅い→深い)。指標は `chat` 到達率だけ。 */
export const ConfirmBoxDepthSchema = z.enum(["list", "expanded", "background", "chat"]);
export type ConfirmBoxDepth = z.infer<typeof ConfirmBoxDepthSchema>;
export const DEPTHS: readonly ConfirmBoxDepth[] = ["list", "expanded", "background", "chat"];

export const ConfirmBoxStateSchema = z.enum(["new", "read", "approved"]);
export type ConfirmBoxState = z.infer<typeof ConfirmBoxStateSchema>;

/** 項目がどこから来たか。UIの出所バッジと絞り込みに使う。 */
export const ConfirmBoxKindSchema = z.enum(["box", "pending", "permit"]);
export type ConfirmBoxKind = z.infer<typeof ConfirmBoxKindSchema>;

export const KIND_LABEL: Record<ConfirmBoxKind, string> = {
  box: "箱",
  pending: "未投函",
  permit: "Paseo承認待ち",
};

// ---------------------------------------------------------------- 項目

export const ConfirmBoxOptionSchema = z.object({ id: z.string(), label: z.string() });
export type ConfirmBoxOption = z.infer<typeof ConfirmBoxOptionSchema>;

export const ConfirmBoxThreadRefSchema = z.object({ kind: z.string(), id: z.string() });
export type ConfirmBoxThreadRef = z.infer<typeof ConfirmBoxThreadRefSchema>;

export const ConfirmBoxItemSchema = z.object({
  /** 安定ID。箱は item id、中間形式は `pending:<key>`、permit は `permit:<agentId>:<permId>`。 */
  id: z.string(),
  kind: ConfirmBoxKindSchema,
  priority: ConfirmBoxPrioritySchema,
  subrank: z.number().int(),
  group: z.string().nullable(),
  subject: z.string(),
  summary: z.string(),
  background: z.string(),
  source: z.string(),
  threadRef: ConfirmBoxThreadRefSchema.nullable(),
  stoppedCount: z.number().int(),
  /** 新着バグ報告などの報告者表示名(投函側が `reporter` に入れた場合のみ)。 */
  reporter: z.string().optional(),
  options: z.array(ConfirmBoxOptionSchema),
  recommended: z.string().nullable(),
  /** 箱の項目のみ意味を持つ(`new`/`read`/`approved`)。他は常に `new`。 */
  state: ConfirmBoxStateSchema,
  /** 緊急(push対象)。並び順には使わない。 */
  urgency: z.enum(["urgent", "normal"]),
  /** 中間形式の `key`(決定を書き戻すときの突き合わせ)。無ければ null。 */
  key: z.string().nullable(),
  /** permit のみ: 承認待ちの主体。 */
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  ts: z.number(),
});
export type ConfirmBoxItem = z.infer<typeof ConfirmBoxItemSchema>;

/** 出所ごとの状態。**空の箱を「故障」と誤読しないため**に画面へ出す。 */
export const ConfirmBoxSourceStatusSchema = z.object({
  id: ConfirmBoxKindSchema,
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  count: z.number().int(),
});
export type ConfirmBoxSourceStatus = z.infer<typeof ConfirmBoxSourceStatusSchema>;

// ---------------------------------------------------------------- RPC: 一覧

export const confirmBoxListRpc = defineRpc({
  name: "topos.confirmbox.list",
  input: z.object({}),
  output: z.object({
    items: z.array(ConfirmBoxItemSchema),
    sources: z.array(ConfirmBoxSourceStatusSchema),
    /** 読み出し先(画面に出す。どこを見ているか分かるようにするため)。 */
    dir: z.string(),
    generatedAt: z.number(),
  }),
});
export type ConfirmBoxListOutput = z.infer<typeof confirmBoxListRpc.output>;

// ---------------------------------------------------------------- RPC: 件数(バッジ用)

/** バッジ用の軽い件数。一覧を3箇所(画面・サイドバー・ヘッダ)から引くと重いので分ける。 */
export const confirmBoxCountRpc = defineRpc({
  name: "topos.confirmbox.count",
  input: z.object({}),
  output: z.object({
    /** 要対応(承認済みを除く)。 */
    open: z.number().int(),
    /** うち priority=blocking。 */
    blocking: z.number().int(),
    /** うち Paseo の承認待ち。 */
    permits: z.number().int(),
    /** 読めなかった出所の数(0 以外なら画面で知らせる)。 */
    failedSources: z.number().int(),
    generatedAt: z.number(),
  }),
});
export type ConfirmBoxCountOutput = z.infer<typeof confirmBoxCountRpc.output>;

// ---------------------------------------------------------------- RPC: 決定

/** 決定イベントの契約は `handoff_confirm_box_recommendation_feedback_kickoff.md` で固定。
 * ここはその**投函側**として書く(`matched` は機械計算)。 */
export const confirmBoxDecideRpc = defineRpc({
  name: "topos.confirmbox.decide",
  input: z.object({
    key: z.string(),
    chosen: z.string().nullable(),
    recommended: z.string().nullable(),
    depth: ConfirmBoxDepthSchema,
    reason: z.string(),
    source: z.string(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
export type ConfirmBoxDecideOutput = z.infer<typeof confirmBoxDecideRpc.output>;

// ---------------------------------------------------------------- RPC: Paseo 承認待ちへの応答

/** Paseo の承認待ちに答える。**ユーザーが画面で押した時だけ**呼ばれる
 * (自動応答はしない。承認は本人の判断でしか動かさない)。 */
export const confirmBoxPermitRpc = defineRpc({
  name: "topos.confirmbox.permit",
  input: z.object({
    agentId: z.string(),
    requestId: z.string(),
    /**
     * 押された `options` の id。**サーバーが実物の `actions` と突き合わせて
     * `behavior` を決める**(クライアントに許可/拒否を名乗らせない)。
     * `null` は既定=許可。`actions` が無いプロバイダ向けの合成idは
     * `__allow` / `__deny`(`server/permits.ts` の `permitOptions()`)。
     */
    actionId: z.string().nullable(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
export type ConfirmBoxPermitOutput = z.infer<typeof confirmBoxPermitRpc.output>;

// ---------------------------------------------------------------- RPC: 開発の優先順位(台帳)

/** 台帳の1行。順位は配列の添字(先頭=1位)で持ち、`rank` フィールドは持たない(二重管理で食い違うため)。 */
export const PriorityProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  note: z.string(),
});
export type PriorityProject = z.infer<typeof PriorityProjectSchema>;

/** 自由記述に対する返答の1行。`by` は ack(即時の受領)/ worker(解釈した結果)/ fallback。 */
export const PriorityReplySchema = z.object({
  ts: z.number(),
  re: z.number(),
  by: z.string(),
  text: z.string(),
});
export type PriorityReply = z.infer<typeof PriorityReplySchema>;

export const priorityListRpc = defineRpc({
  name: "topos.confirmbox.priority.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(PriorityProjectSchema),
    replies: z.array(PriorityReplySchema),
    updatedTs: z.number(),
  }),
});
export type PriorityListOutput = z.infer<typeof priorityListRpc.output>;

/** ▲▼ や並べ替えで順位を直接変える。解釈(LLM)を介さないので誤解釈が起きない。 */
export const priorityMoveRpc = defineRpc({
  name: "topos.confirmbox.priority.move",
  input: z.object({ id: z.string(), toRank: z.number().int() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** 自由記述(「Xを上げて」)。要求を追記し、即時の受領返答を必ず1行返す。解釈と台帳更新は別プロセス。 */
export const prioritySayRpc = defineRpc({
  name: "topos.confirmbox.priority.say",
  input: z.object({ text: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** カード単位のチャット。質問を追記し、即時の受領返答を必ず1行返す。本回答は別プロセス(返信ワーカー)が replies に書く。 */
export const CardChatReplySchema = z.object({
  ts: z.number(),
  re: z.number(),
  by: z.string(),
  text: z.string(),
});
export type CardChatReply = z.infer<typeof CardChatReplySchema>;

/** どの項目への質問か。箱の項目は `key` を持たないことがあるので `id` を正とする
 * (2026-10-22: 返事を箱のイベント列 `t:"reply"` に出すようになり、id で突き合わせる)。 */
const cardChatTarget = { id: z.string(), key: z.string().nullable().optional() };

export const cardChatListRpc = defineRpc({
  name: "topos.confirmbox.cardchat.list",
  input: z.object(cardChatTarget),
  output: z.object({
    messages: z.array(
      z.object({
        ts: z.number(),
        role: z.enum(["user", "reply"]),
        by: z.string(),
        text: z.string(),
      }),
    ),
  }),
});
export type CardChatListOutput = z.infer<typeof cardChatListRpc.output>;

export const cardChatSayRpc = defineRpc({
  name: "topos.confirmbox.cardchat.say",
  input: z.object({ ...cardChatTarget, text: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// ---------------------------------------------------------------- 共有ヘルパ(純関数)

/** 並び順。SSOT(Python `notify_box.sort_items()` / TS `compareConfirmBoxItems()`)の写し。
 * `group` を挟むのは同じ背景を共有する判断を一覧で連続させるため。 */
export function compareConfirmBoxItems(a: ConfirmBoxItem, b: ConfirmBoxItem): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.subrank !== b.subrank) return a.subrank - b.subrank;
  const ag = a.group ?? "";
  const bg = b.group ?? "";
  if (ag !== bg) return ag < bg ? -1 : 1;
  return b.ts - a.ts;
}

/** 画面に出す「要対応」件数。承認済みは数えない。 */
export function countOpen(items: readonly ConfirmBoxItem[]): number {
  return items.filter((i) => i.state !== "approved").length;
}
