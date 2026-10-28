/**
 * 窓口Bの右側に出す「ユーザーが振ったタスクの台帳」(2026-10-28 ユーザー指示
 * 「やっぱり僕が降ったタスクの一覧を僕も見たいな…あとはこの窓口Bの右側にその台帳をつくってほしい。
 *   スワイプでその台帳に移動できるように…opus裏方に受付されたら台帳に追加で 子スレに仕事を振ったかどうか
 *   子スレの進捗状況、完了したかどうかを表示…完了したものを表示にするモードと完了したものは非表示にするモード」)。
 *
 * 画面の決まりごと:
 * - 1行 = ユーザーが窓口Bに出した依頼の1項目(1件の依頼に複数の用件があれば項目ごとに1行)。
 * - 一番上が最新。並べ替えと「完了を隠す」の判定は `sortLedgerRows` / `filterLedgerRows` の1本だけを使う
 *   (画面ごとに別の数え方をしない)。
 * - 完了の判定は「項目の状態が完了」または「振った子スレが完了」のどちらか。子スレを振っていない項目
 *   (代理決定・投函・説明のみ)は振り先を書いた時点で片付いているものとして扱う(2026-10-28 裏方1の判断)。
 *
 * データの出所(すべて読み取り専用):
 * - `window_b_reply/window_b_items.json` … 裏方の子スレ(windowb-item-guard)が受付時に項目を作る台帳。
 *   形式の正は `antigravity/utils/window_b_request_items.py` の先頭。未マージの間は空。
 * - `coordinator_inbox.md` の `[窓口B→裏方]` … 受付の記録。台帳の項目が無い依頼・項目は本文の文で補う。
 * - `confirm_box/child_threads.json` … 子スレの自己申告の状態(進捗の表示)。
 * - `confirm_box/priority_ledger.json` … 開発プロジェクト(優先順位台帳)の名前。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** 振り先の種別。空文字は「まだ振っていない」。語彙は `window_b_request_items.classify_target` と同じ。 */
export const LedgerKindSchema = z.enum(["子スレ", "代理決定", "投函", "説明のみ", ""]);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/** 子スレの進捗。作業中 / 止まっている / ユーザー判断待ち / 完了 / 不明(一覧に居ない)。 */
export const LedgerProgressSchema = z.enum(["working", "stopped", "waiting", "done", "unknown"]);
export type LedgerProgress = z.infer<typeof LedgerProgressSchema>;

export const LedgerChildSchema = z.object({
  /** 振り先として書かれたID(短縮のことがある)。 */
  id: z.string(),
  title: z.string(),
  progress: LedgerProgressSchema,
  /** 自己申告の状態(`実装中` など)。一覧に居ないときは空。 */
  status: z.string(),
  /** 一覧に居ない(まだ上がってきていない・消えた)。 */
  missing: z.boolean(),
});
export type LedgerChild = z.infer<typeof LedgerChildSchema>;

export const LedgerRowSchema = z.object({
  /** 依頼の鍵 `MM/DD HH:MM#N`(画面の id)。 */
  id: z.string(),
  key: z.string(),
  itemNo: z.number().int(),
  itemCount: z.number().int(),
  /** 依頼の要約(台帳の要約。無ければ本文の最初の1文)。 */
  summary: z.string(),
  /** 項目の元の文。タップで全文を見せる。 */
  source: z.string(),
  /** 依頼の全文(受信箱の `[窓口B→裏方]` から)。 */
  fullText: z.string(),
  /** 受付の時刻(epoch 秒)。不明なら null(画面は鍵の時刻を出し、並びも鍵の時刻で決める)。 */
  receivedAt: z.number().nullable(),
  kind: LedgerKindSchema,
  target: z.string(),
  children: z.array(LedgerChildSchema),
  /** 子スレを振らずに片付けた(代理決定・投函・説明のみ)か。低い確度(推測)の行は false。 */
  settledWithoutChild: z.boolean(),
  /** 低い確度(受信箱から推測して補った行)か。画面で「推測」と出す。 */
  inferred: z.boolean(),
  /** 完了したか(`isLedgerDone`)。台帳が完了と書いている・振った子スレが全部完了・振らずに片付いた、のいずれか。 */
  done: z.boolean(),
  /** 振り先が書かれた時刻(epoch 秒)。 */
  targetSetAt: z.number().nullable(),
  /** 裏方から窓口Bへの返信の時刻(epoch 秒)。 */
  repliedAt: z.number().nullable(),
  owner: z.string(),
  /** 開発プロジェクト(優先順位台帳の id/name)。付いていなければ null。 */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

export const taskLedgerListRpc = defineRpc({
  name: "topos.confirmbox.taskledger.list",
  input: z.object({}),
  output: z.object({
    rows: z.array(LedgerRowSchema),
    /** 読めなかった出所(画面の上に小さく出す)。 */
    notes: z.array(z.string()),
    /** 台帳ファイル(項目)を読めたか。未マージの間は false が並ぶ。 */
    sources: z.object({
      items: z.boolean(),
      inbox: z.boolean(),
      childThreads: z.boolean(),
      priority: z.boolean(),
    }),
  }),
});
export type TaskLedgerListOutput = z.infer<typeof taskLedgerListRpc.output>;

/** 完了の表示モード。既定は「完了は隠す」。 */
export type LedgerMode = "hide-done" | "show-done";

/**
 * 完了か。台帳が完了と書いていれば完了。子スレを振った行は、振った子スレが全部完了したら完了。
 * 振っていない行(代理決定・投函・説明のみ)は `settledWithoutChild` のとおり。
 * 推測の行(受信箱から補っただけの行)は、子スレが終わっていても完了にしない
 * (台帳の正が確かめるまでは未完了として見せる。「完了は隠す」で黙って消さない)。
 */
export function isLedgerDone(row: LedgerRow): boolean {
  if (row.done) return true;
  if (row.kind === "子スレ") {
    if (row.inferred) return false;
    return row.children.length > 0 && row.children.every((c) => c.progress === "done");
  }
  return row.settledWithoutChild;
}

/**
 * 一番上が最新。鍵の時刻(MM/DD HH:MM#N)で並べ、同じ鍵の中は項目番号の順。
 * 年をまたぐときは月日の数字だけで比べる(今日から遡る台帳なので、年違いは並びに効かない)。
 */
export function sortLedgerRows(rows: readonly LedgerRow[]): LedgerRow[] {
  return [...rows].sort((a, b) => {
    const ka = keySortValue(b.key);
    const kb = keySortValue(a.key);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return b.itemNo - a.itemNo;
  });
}

/** 鍵の並べ替え用の値。`10/28 21:49#2` → "10282149.2"(`#N` が無ければ .1)。 */
export function keySortValue(key: string): string {
  const m = /^(?:(\d{2})\/(\d{2})\s+)?(\d{2}):(\d{2})(?:#(\d+))?$/.exec(key.trim());
  if (!m) return "000000000000.0";
  const [, md = "00", dd = "00", hh, mm, n = "1"] = m;
  return `${md}${dd}${hh}${mm}.${Number(n)}`;
}

export function filterLedgerRows(rows: readonly LedgerRow[], mode: LedgerMode): LedgerRow[] {
  const sorted = sortLedgerRows(rows);
  return mode === "show-done" ? sorted : sorted.filter((r) => !isLedgerDone(r));
}

/** 進捗の表示名と色の種類(画面とテストで同じ語彙を使う)。 */
export const LEDGER_PROGRESS_LABEL: Record<LedgerProgress, string> = {
  working: "作業中",
  stopped: "止まっている",
  waiting: "ユーザー判断待ち",
  done: "完了",
  unknown: "不明",
};

export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  子スレ: "子スレ",
  代理決定: "代理決定",
  投函: "確認箱へ投函",
  説明のみ: "説明のみ",
  "": "まだ振っていない",
};
