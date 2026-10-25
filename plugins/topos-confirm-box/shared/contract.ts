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

/**
 * 承認待ちが「質問」(Claude の AskUserQuestion / opencode の question)の時の選択肢。
 * `options` ボタン(許可/拒否)では答えられないので、質問そのものを画面へ渡す。
 * 読み替えは `shared/questions.ts`(`parseQuestions`)が行う。
 */
export const ConfirmBoxQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().nullable(),
});
export type ConfirmBoxQuestionOption = z.infer<typeof ConfirmBoxQuestionOptionSchema>;

export const ConfirmBoxQuestionSchema = z.object({
  header: z.string(),
  question: z.string(),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
  allowEmpty: z.boolean(),
  options: z.array(ConfirmBoxQuestionOptionSchema),
  /** 上限で切り詰めた/落とした質問・選択肢がある。true ならフォームを出さない。 */
  truncated: z.boolean().default(true),
});
export type ConfirmBoxQuestion = z.infer<typeof ConfirmBoxQuestionSchema>;

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
  /** 「この欄に答えるスレ」の表示(短ID+題名。未登録の投函元は明示)。判断ノート由来のカードだけ入る。 */
  answerLabel: z.string().optional(),
  stoppedCount: z.number().int(),
  /** 新着バグ報告などの報告者表示名(投函側が `reporter` に入れた場合のみ)。 */
  reporter: z.string().optional(),
  options: z.array(ConfirmBoxOptionSchema),
  recommended: z.string().nullable(),
  /** 箱の項目のみ意味を持つ(`new`/`read`/`approved`)。他は常に `new`。 */
  state: ConfirmBoxStateSchema,
  /** 緊急(push対象)。並び順には使わない。 */
  urgency: z.enum(["urgent", "normal"]),
  /**
   * 判断印(許可リスト方式)。投函側が `kind="judgment"` で投函した項目にだけ `"judgment": true` が付く
   * (箱の行・中間形式の行のどちらも同じフィールド名)。**選択肢の有無では判断と判定しない**。
   * 出所の軸の `kind`(`"box"`/`"pending"`/`"permit"`)とは別物なので名前を分けている。
   */
  judgment: z.boolean().default(false),
  /** 中間形式の `key`(決定を書き戻すときの突き合わせ)。無ければ null。 */
  key: z.string().nullable(),
  /** permit のみ: 承認待ちの主体。 */
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** permit かつ質問の時だけ入る(選択肢ボタンの代わりに質問フォームを描く)。 */
  questions: z.array(ConfirmBoxQuestionSchema).optional(),
  /** 通知の束ね: 同一source+同一内容の未読をまとめた件数(2件以上のときだけ入る)。 */
  dupCount: z.number().int().optional(),
  /** 束ねた全項目の id(代表を含む)。既読にするときは全部に ack する。 */
  memberIds: z.array(z.string()).optional(),
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

// ---------------------------------------------------------------- RPC: 変更の合図(即時反映用)

/** 箱の書き手(Python)が投函・取り下げ・再投函の直後に書く合図ファイルの最終更新時刻(ms)。
 * 画面はこの値が進んだ時だけ一覧とバッジを取り直す(30秒の定期取得を待たない。2026-10-24)。 */
export const boxSignalRpc = defineRpc({
  name: "topos.confirmbox.signal",
  input: z.object({}),
  output: z.object({
    /** box.signal.jsonl(項目の投函・取り下げ)。無ければ 0。 */
    box: z.number(),
    /** child_threads.signal.jsonl(子スレの完了・取り下げ・再投函)。無ければ 0。 */
    child_threads: z.number(),
  }),
});
export type BoxSignalOutput = z.infer<typeof boxSignalRpc.output>;

// ---------------------------------------------------------------- RPC: 件数(バッジ用)

/** バッジ用の軽い件数。一覧を3箇所(画面・サイドバー・ヘッダ)から引くと重いので分ける。 */
export const confirmBoxCountRpc = defineRpc({
  name: "topos.confirmbox.count",
  input: z.object({}),
  output: z.object({
    /** 判断タブと同じ件数(判断印 `judgment: true` か permit の項目のうち承認済みを除く)。
     * 印の無い旧形式は数えない。通知・バグ報告・完了報告は数えない。 */
    open: z.number().int(),
    /** うち priority=blocking。 */
    blocking: z.number().int(),
    /** うち Paseo の承認待ち。 */
    permits: z.number().int(),
    /** 読めなかった出所の数(0 以外なら画面で知らせる)。 */
    failedSources: z.number().int(),
    /** 通知タブの未読(選択肢を持たないお知らせのうち state=new)。 */
    notifications: z.number().int().default(0),
    /** バグ報告タブの未対応(status=new)。 */
    bugs: z.number().int().default(0),
    /** 子スレ完了報告タブの未確認(完了かつまとめが未読)。 */
    childDone: z.number().int().default(0),
    generatedAt: z.number(),
  }),
});
export type ConfirmBoxCountOutput = z.infer<typeof confirmBoxCountRpc.output>;

// ---------------------------------------------------------------- RPC: 決定

/** 決定イベントの契約は `handoff_confirm_box_recommendation_feedback_kickoff.md` で固定。
 * ここはその**投函側**として書く(`matched` は機械計算)。 */
/** `decide` の `chosen` にこの値を渡すと「却下」(コメント必須)。選択肢 id と衝突しない予約語。 */
export const REJECT_CHOICE = "__reject";
/** Vault 判断ノート項目の key 接頭辞(server/vault-decisions.ts の VAULT_KEY_PREFIX と同値) */
export const REJECT_KEY_PREFIX = "vault:";

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

// ---------------------------------------------------------------- RPC: 既読/確認(通知・完了まとめ)

/**
 * 箱の項目を既読/承認にする。**ユーザーが画面で押した時だけ**呼ばれる
 * (自動既読はしない)。書くのは箱の `ack` イベント1行だけで、項目そのものは書き換えない。
 *
 * 完了まとめの確認は `approve`。`child_thread_registry.py` の定期 tick が
 * 「個別に ack された完了まとめ」をアーカイブする(アーカイブの実行経路は既存のまま1本)。
 */
export const confirmBoxAckRpc = defineRpc({
  name: "topos.confirmbox.ack",
  input: z.object({
    id: z.string(),
    action: z.enum(["read", "approve"]).default("read"),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
export type ConfirmBoxAckOutput = z.infer<typeof confirmBoxAckRpc.output>;

/** 通知をまとめて既読にする(`ackall`。`before` 以前の未読が対象=本体ストアと同じ意味)。 */
export const confirmBoxAckAllRpc = defineRpc({
  name: "topos.confirmbox.ackall",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

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
    /**
     * 質問(`kind:"question"`)への回答。キーは質問の header(空なら質問文)。
     * 値は選択肢のラベル(複数選択はカンマ区切り)か「その他」の自由記述。
     * サーバーが実物の質問と突き合わせて `updatedInput.answers` を組み立てる
     * (`shared/questions.ts` の `sanitizeAnswers`)。`actionId` より優先する。
     */
    answers: z.record(z.string(), z.string()).optional(),
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
  /**
   * 担当スレ(Paseo の agent ID)。未設定は null。
   * 台帳 (`priority_ledger.json`) が SSOT で、UI は行タップでこのスレを開くだけ
   * (題名の一致などで推測しない=誤ったスレを開くよりは「未設定」と言う)。
   */
  thread: z.string().nullable(),
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

/** どの項目への質問か。箱の項目は `key` を持たないことがあるので `id` を正とする
 * (2026-10-22: 返事を箱のイベント列 `t:"reply"` に出すようになり、id で突き合わせる)。 */
const cardChatTarget = { id: z.string(), key: z.string().nullable().optional() };

/** カード単位のチャット。質問を追記し、即時の受領返答を1行返す(プラグインUI経由の質問に限る)。
 * 本回答は別プロセス(応答ワーカー)が箱の `t:"reply"` 行として書く。 */
export const cardChatListRpc = defineRpc({
  name: "topos.confirmbox.cardchat.list",
  /** `topic: true` = 「この話題だけ」表示(受領ackを除く)。pending も同時に返す。 */
  input: z.object({ ...cardChatTarget, topic: z.boolean().optional() }),
  output: z.object({
    /** 箱にその項目が在るか。無い id(URL 手打ち・決定済み)への送信を止めるため(2026-10-22)。 */
    found: z.boolean(),
    messages: z.array(
      z.object({
        ts: z.number(),
        role: z.enum(["user", "reply"]),
        by: z.string(),
        text: z.string(),
      }),
    ),
    /** ペインから送って、まだ上位スレの say が無い質問(`topic: true` の時だけ入る)。 */
    pending: z
      .array(
        z.object({
          re: z.string(),
          ts: z.number(),
          state: z.enum(["waiting", "overdue"]),
          nudges: z.number(),
        }),
      )
      .optional(),
  }),
});
export type CardChatListOutput = z.infer<typeof cardChatListRpc.output>;

/** 総司令塔スレの agent ID(起こしデーモンの実行時の正本 `domains/general/coordinator_id`)。
 * 読めない/形が不正なら null。投函元が閉じているカードの質問の振り替え先。 */
export const coordinatorTargetRpc = defineRpc({
  name: "topos.confirmbox.coordinator",
  input: z.object({}),
  output: z.object({
    agentId: z.string().nullable(),
    /** ハブ(総司令塔・子司令塔)のスレID。宛先がこの中なら「この話題だけ」表示にする。 */
    hubIds: z.array(z.string()).optional(),
  }),
});

/** ペインからの質問。台帳へ `t:"chat"`(source:"pane", target=宛先スレ)を書き、返信IDを返す。
 * 返事は上位スレが `confirm_box_reply.py say --re <返信ID>` で書く(方式a)。 */
export const cardChatAskRpc = defineRpc({
  name: "topos.confirmbox.cardchat.ask",
  input: z.object({ ...cardChatTarget, text: z.string(), target: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string(), replyId: z.string().optional() }),
});

/** ペインの送信が失敗した質問を取り消す(待ち表示・催促・集計から外す)。 */
export const cardChatCancelRpc = defineRpc({
  name: "topos.confirmbox.cardchat.cancel",
  input: z.object({ ...cardChatTarget, replyId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

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

/**
 * 判断タブに流す項目。**許可リスト方式**: 明示の判断印 `judgment: true` を持つ項目だけ。
 *
 * - `permit`(Paseo の承認待ち)は、プラグインが Paseo 実物から作る別枠なので常に判断
 *   (回答なしの指定でも許可/拒否を選ぶ)。
 * - 箱・中間形式は `judgment === true` のものだけ。**選択肢の有無は見ない**。
 *   印の無い項目は、選択肢が付いていても判断タブには出ない(通知タブ/専用タブ側)。
 *   印を付けるのは投函側(`notify_box.deposit(judgment=True)` が `"judgment": true` を書く)。
 * - 印の無い旧形式の選択肢つき項目は `judgmentTabRows(..., { legacy: true })` でのみ見られる。
 */
/**
 * 「却下」ボタンを出す項目か。Vault の判断ノート由来(key が `vault:` 始まり・judgment 印あり)だけ。
 * 却下の伝達(superseded + rejected_at → 投函元の子スレ)はノート経由なので、ノートの無い項目には出さない。
 * 承認待ち(permit)には出さない(拒否ボタンが既にある)。key が無いと却下を記録できない。
 */
export function canRejectItem(item: ConfirmBoxItem): boolean {
  return (
    item.kind !== "permit" && item.judgment === true && !!item.key?.startsWith(REJECT_KEY_PREFIX)
  );
}

/** 却下コメントの検査。空白だけは不可(コメント必須)。通れば前後の空白を除いた本文を返す。 */
export function rejectComment(text: string): string | null {
  const t = text.trim();
  return t ? t : null;
}

export function isJudgmentItem(item: ConfirmBoxItem): boolean {
  if (item.kind === "permit") return true;
  return item.judgment === true;
}

/**
 * 印の無い旧形式の判断項目(判断印の導入前に投函された「選択肢つき」の行)。
 * 判断としては扱わない(許可リスト方式)が、`legacy` を指定した時だけ判断タブで見られる。
 */
export function isLegacyOptionItem(item: ConfirmBoxItem): boolean {
  return item.kind !== "permit" && item.judgment !== true && item.options.length > 0;
}

/**
 * 判断タブに並べる行。`ConfirmBoxView` の `visible` は必ずこれを通す(画面側で絞り込みを書き直さない。
 * 2026-10-22、判断タブが種別で絞っておらず通知が二重表示されたため、絞り込みをここで1本にした)。
 * 既定では判断印のある項目だけ。`legacy: true` の時だけ旧形式(`isLegacyOptionItem`)も加える。
 */
export function judgmentTabRows(
  items: readonly ConfirmBoxItem[],
  opts: {
    showDone: boolean;
    prio: ConfirmBoxPriority | null;
    newestFirst: boolean;
    /** 印の無い旧形式(選択肢あり・`judgment` なし・permit でない)も並べる。既定は false。 */
    legacy?: boolean;
  },
): ConfirmBoxItem[] {
  const rows = items.filter(
    (i) =>
      (isJudgmentItem(i) || (opts.legacy === true && isLegacyOptionItem(i))) &&
      (opts.showDone || i.state !== "approved") &&
      (opts.prio === null || i.priority === opts.prio),
  );
  return opts.newestFirst ? [...rows].sort((a, b) => b.ts - a.ts) : rows;
}

/** 画面に出す「要対応」件数。判断タブと同じ定義で、承認済みは数えない。 */
export function countOpen(items: readonly ConfirmBoxItem[]): number {
  return items.filter((i) => isJudgmentItem(i) && i.state !== "approved").length;
}

/** 子スレの完了まとめを投函する側の source(書き手は `child_thread_registry.py` の `SOURCE`)。 */
export const CHILD_THREAD_REPORT_SOURCE = "child_thread_report";

/**
 * 通知タブに流す項目。判断タブの補集合(判断でないもの)から、専用タブを持つ出所を除く。
 * 家族報告はバグ報告タブ、子スレの完了まとめは子スレ完了報告タブが受け持つ
 * (同じ内容を2箇所に出さない)。
 *
 * **印の無い旧形式の選択肢つき項目(`isLegacyOptionItem`)は通知タブに出さない**。
 * 出せば選択肢つきのお知らせが「判断」に見えるため(元の混入と同じ誤読)。
 * 旧形式は判断タブの「印なし(旧形式)」フィルタでのみ見られる。
 */
export const NOTIFICATION_EXCLUDED_SOURCES: readonly string[] = [
  "topos_feedback",
  CHILD_THREAD_REPORT_SOURCE,
];

export function isNotificationItem(item: ConfirmBoxItem): boolean {
  if (isJudgmentItem(item) || isLegacyOptionItem(item)) return false;
  return !NOTIFICATION_EXCLUDED_SOURCES.includes(item.source);
}

/** 通知タブの未読(緊急かどうかを問わない)。タブ内の見出し用で、バッジには使わない。 */
export function countUnreadNotifications(items: readonly ConfirmBoxItem[]): number {
  return items.filter((i) => isNotificationItem(i) && i.state === "new").length;
}

/**
 * 通知タブのバッジ=**緊急かつ未読**だけ(2026-10-26 ユーザー指示「バッジは緊急の件数だけ」)。
 * 通常の通知はバッジに数えない。0 のときは呼び出し側が非表示にする。
 */
export function countUrgentUnreadNotifications(items: readonly ConfirmBoxItem[]): number {
  return items.filter((i) => isNotificationItem(i) && i.state === "new" && i.urgency === "urgent")
    .length;
}

/**
 * 通知タブに並べる行。**緊急(urgency=urgent)を先**に、その後は新しい順。
 *
 * 判断タブから通知を外した結果、デーモン停止などの緊急通知はこのタブにしか出なくなった。
 * 時刻順だけだと新しい雑多な通知の下に埋もれるので、緊急だけ先頭へ寄せる
 * (`priority` は並び順の軸だが、通知は `blocking` を持たないことが多く当てにならない)。
 */
export function notificationTabRows(
  items: readonly ConfirmBoxItem[],
  showRead: boolean,
): ConfirmBoxItem[] {
  return items
    .filter((i) => isNotificationItem(i) && (showRead || i.state === "new"))
    .sort((a, b) => {
      const au = a.urgency === "urgent" ? 0 : 1;
      const bu = b.urgency === "urgent" ? 0 : 1;
      return au !== bu ? au - bu : b.ts - a.ts;
    });
}
