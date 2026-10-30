/**
 * 窓口Bの右側の「ぼくの指示がいまどうなっているか」の**表示の決まり**(純粋な関数だけ)。
 *
 * どの指示がどの状態かは Python(`antigravity/utils/window_b_instruction_panel.py`)が決める。
 * ここが持つのは表示の規則だけ: 取れなかったときの扱い・並び・開く場所。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { WINDOW_B_KIND, type WindowBInstructionsOutput } from "./contract.js";

/** PC幅の下限(ホストの compact 境界と同じ720px)。 */
export const WIDE_MIN_WIDTH = 720;

/**
 * 画面に出す一覧を決める。
 * - 新しい取得が成功した → それを使う(error は消す)
 * - 失敗した → **前回取れた一覧を残し**、error だけ出す(取れない瞬間に「0件」へ戻すと、
 *   指示が消えたように見える)。まだ一度も取れていなければ null(= 空ではなく「取れない」)。
 */
export function keepLastOnFailure(
  previous: WindowBInstructionsOutput | null,
  next: { ok: true; data: WindowBInstructionsOutput } | { ok: false; error: string },
): { data: WindowBInstructionsOutput | null; error: string | null } {
  if (next.ok) return { data: next.data, error: null };
  return { data: previous, error: next.error };
}

/** 見出しに出す短い要約。「N件」だけだと赤の有無を読むのに一覧を目で数えることになる。 */
export function summarize(data: WindowBInstructionsOutput | null): string {
  if (!data) return "読み込めていません";
  const parts = [`${data.total}件`];
  if (data.alerts > 0) parts.push(`赤 ${data.alerts}`);
  if (data.warns > 0) parts.push(`未登録 ${data.warns}`);
  return parts.join(" / ");
}

/** 一覧の並び。赤 → 判断待ち → 未登録 → その他 → 完了。同じ群の中は Python の並びのまま(安定ソート)。 */
export function rowOrder<T extends { alert: string | null; warn: string | null; kind: string }>(
  rows: readonly T[],
): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** 並びの群(小さいほど上)。 */
function rank(row: { alert: string | null; warn: string | null; kind: string }): number {
  if (row.alert) return 0;
  if (row.kind === WINDOW_B_KIND.judgment) return 1;
  // 「届いたか」そのものが知りたいことなので、届いたか不明・返事なしは状態の順で後ろへ回さない。
  if (row.kind === WINDOW_B_KIND.unknown || row.kind === WINDOW_B_KIND.noReply) return 2;
  if (row.warn) return 3;
  if (row.kind === WINDOW_B_KIND.done) return 5;
  return 4;
}

/** 一覧のうち何件を出しているか。上限で切ったと分からないと「出ている範囲で赤が無い」と読み違える。 */
export function truncationNote(data: WindowBInstructionsOutput): string | null {
  if (data.total <= data.items.length) return null;
  return `表示は上位${data.items.length}件(全${data.total}件。赤と届いたか不明・返事なしは先に出しています)`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 「いつ時点の一覧か」。台帳の更新が止まると古い「作業中」がそのまま正常に見えるので、
 * 読み出した時刻と台帳の更新時刻を両方出す(台帳の更新時刻はミリ秒・0 は「まだ無い」)。
 */
export function freshnessText(data: WindowBInstructionsOutput): string {
  const at = `読み出し ${clock(data.generatedAt)}`;
  return data.ledgerUpdatedAt > 0
    ? `${at} / 台帳 ${clock(data.ledgerUpdatedAt)}`
    : `${at} / 台帳の更新時刻なし`;
}

/**
 * 一覧を開く場所。PC幅は右カラム、iPhone幅は主ペイン(全画面。戻るで閉じる)。
 */
export function paneLocation(width: number): "right" | "workspace" {
  return width >= WIDE_MIN_WIDTH ? "right" : "workspace";
}

/** これより古い読み出しは「古い表示」として目立たせる(2026-10-30 依頼「15分より古いとき」)。 */
export const STALE_AFTER_MS = 15 * 60_000;

/**
 * 「古い表示(HH:MM時点)」の一行。読み出した時刻が `now` より15分以上前なら出す(それ以外は null)。
 * 30秒ごとに引き直すので、普通はここに来ない。来るのは引き直しが止まったとき=古い「作業中」が
 * そのまま正常に見えてしまうときで、黙って出し続けない。
 */
export function staleNotice(data: WindowBInstructionsOutput, now: number): string | null {
  if (now - data.generatedAt < STALE_AFTER_MS) return null;
  return `古い表示(${clock(data.generatedAt)}時点)`;
}

/** 一覧の見せ方。active=完了を隠す(既定) / done=完了だけ(直近3日。Python が返す範囲)。 */
export type ListMode = "active" | "done";

/**
 * 見せ方に合わせて行を絞る。完了の判定は Python の状態の語(WINDOW_B_KIND.done)と一致させる。
 * 「完了だけ」の間も、判断待ち・赤・橙の行は隠さない(置きっぱなしで新しい判断待ちが見えなくなるのを防ぐ。
 * 2026-10-30 出口レビュー指摘7a)。
 */
export function filterByMode<
  T extends { kind: string; alert?: string | null; warn?: string | null },
>(rows: readonly T[], mode: ListMode): T[] {
  return rows.filter((r) => {
    const isDone = r.kind === WINDOW_B_KIND.done;
    if (mode === "active") return !isDone;
    return isDone || Boolean(r.alert) || Boolean(r.warn) || r.kind === WINDOW_B_KIND.judgment;
  });
}

/** 「完了だけ」ボタンの文字(件数つき)。 */
export function doneButtonText(mode: ListMode, doneCount: number): string {
  return mode === "done" ? "一覧にもどる" : `完了だけ(${doneCount})`;
}

/** 絞った結果が空のときの文。 */
export function emptyText(mode: ListMode): string {
  return mode === "done" ? "直近3日の完了はありません" : "進行中の指示はありません";
}
