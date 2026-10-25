/** 右チャットペインの幅(ドラッグで可変・保存)。純粋関数だけ(保存先は呼び出し側)。 */
export const PANE_WIDTH_KEY = "topos-confirm-box.pane-width";
export const PANE_MIN = 280;
export const PANE_MAX_RATIO = 0.7;

/** 既定幅(従来式: 画面の36%を 320〜440 に収める)。 */
export function defaultPaneWidth(total: number): number {
  return Math.round(Math.min(440, Math.max(320, total * 0.36)));
}

/** 範囲に収める。最小は PANE_MIN、最大は全体の70%(一覧が潰れない)。 */
export function clampPaneWidth(width: number, total: number): number {
  const max = Math.max(PANE_MIN, Math.floor(total * PANE_MAX_RATIO));
  if (!Number.isFinite(width)) return defaultPaneWidth(total);
  return Math.round(Math.min(max, Math.max(PANE_MIN, width)));
}

/** 保存値の読み出し(壊れた値は null=既定へ)。 */
export function parseStoredPaneWidth(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
