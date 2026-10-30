/**
 * 窓口Bの右側の「ぼくの指示がいまどうなっているか」の**表示の決まり**(純粋な関数だけ)。
 *
 * どの指示がどの状態かは Python(`antigravity/utils/window_b_instruction_panel.py`)が決める。
 * ここが持つのは表示の規則だけ: 取れなかったときの扱い・並び・開く場所。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import type { WindowBInstructionsOutput } from "./contract.js";

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
  if (row.kind === "判断待ち(確認箱)") return 1;
  if (row.warn) return 2;
  if (row.kind === "完了") return 4;
  return 3;
}

/** 一覧を開く場所。PC幅は右カラム、iPhone幅は主ペイン(全画面。戻るで閉じる)。 */
export function paneLocation(width: number): "right" | "workspace" {
  return width >= WIDE_MIN_WIDTH ? "right" : "workspace";
}
