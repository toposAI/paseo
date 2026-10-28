/**
 * 判断一覧の並べ方(純関数)。
 *
 * PC幅(720px以上)は横の広さを使い、カードを複数列に並べる(2026-10-28 ユーザー決定:
 * 「通常時はPCの横幅を活かした全画面表示、コメントボタン押したら右に出すかな」)。
 * iPhone幅は今までどおり1列。
 *
 * 列数は**画面幅ではなく一覧の中身の入れ物そのものの実測幅**で決める。測るのは
 * 余白(左右12px)とスクロールバーの内側なので、その2つは自動的に差し引かれた値になる。
 * 右ペイン(会話)が開くと一覧の幅が狭くなるので、同じ式で自動的に列が減る
 * (=出ている間は一覧を詰める)。
 */

/** カード同士のすき間(px)。 */
export const LIST_GRID_GAP = 8;
/** 一覧の左右の余白(px)。ConfirmBoxView の `body` の padding と揃える(片方だけ変えない)。 */
export const LIST_GRID_PADDING = 12;
/** 列に並べるのに必要なカードの最小幅(px)。390px(iPhone)の1列より少し狭い程度。 */
export const CARD_MIN_WIDTH = 330;
/** PC幅でも3列まで(それ以上は目線が散る)。 */
export const MAX_COLUMNS = 3;

/**
 * 一覧の列数。`wide`=横に並べる幅があるか(720px以上)。狭い幅は常に1列。
 * 幅が読めない(0・NaN)ときも1列にして、潰れたカードを出さない。
 */
export function listColumns(listWidth: number, wide: boolean): number {
  if (!wide || !Number.isFinite(listWidth) || listWidth <= 0) return 1;
  const n = Math.floor((listWidth + LIST_GRID_GAP) / (CARD_MIN_WIDTH + LIST_GRID_GAP));
  return Math.max(1, Math.min(MAX_COLUMNS, n));
}

/** 1枚ぶんの幅(px)。1列のときは指定しない(=今までどおり横幅いっぱい)。 */
export function listCellWidth(listWidth: number, columns: number): number | undefined {
  if (columns <= 1) return undefined;
  const cell = Math.floor((listWidth - LIST_GRID_GAP * (columns - 1)) / columns);
  return cell > 0 ? cell : undefined;
}
