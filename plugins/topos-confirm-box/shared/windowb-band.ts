/**
 * 窓口Bの会話の上の細い帯の文言(純粋な関数だけ)。
 * 2026-10-30 ユーザー指示「窓口Bの会話の上に細い帯『指示 N件・赤1』を出し、タップで指示一覧を開く」。
 *
 * 件数・赤の数は一覧の取得結果(`windowBInstructionsRpc` の `total` / `alerts`。一覧の見出しの
 * `summarize` と同じ値)をそのまま使い、ここで数え直さない。
 */
import type { WindowBInstructionsOutput } from "./contract.js";

/** 取得できていない(未取得・失敗で一度も取れていない)ときは null=帯を出さない。 */
export function bandText(
  data: Pick<WindowBInstructionsOutput, "total" | "alerts"> | null,
): string | null {
  if (!data) return null;
  const head = `指示 ${data.total}件`;
  return data.alerts > 0 ? `${head}・赤${data.alerts}` : head;
}
