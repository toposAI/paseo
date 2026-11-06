/** 画像の拡大表示の変換(拡大率と平行移動)。transform-origin は左上、translate してから scale する。 */
export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** ダブルタップで拡大したときの倍率。 */
export const DOUBLE_TAP_SCALE = 3;

export const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

function clampAxis(offset: number, view: number, scale: number): number {
  const content = view * scale;
  // 画面より小さければ中央、大きければ端に余白を出さない範囲に収める。
  if (content <= view) return (view - content) / 2;
  return Math.min(0, Math.max(view - content, offset));
}

/** 拡大率を範囲に収め、画面端に余白が出ないよう平行移動を丸める。 */
export function clampTransform(t: ZoomTransform, width: number, height: number): ZoomTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale));
  return {
    scale,
    x: clampAxis(t.x, width, scale),
    y: clampAxis(t.y, height, scale),
  };
}

/** 画面上の点(px, py)を動かさずに、拡大率を newScale にする。 */
export function zoomAt(
  t: ZoomTransform,
  newScale: number,
  px: number,
  py: number,
  width: number,
  height: number,
): ZoomTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  const ratio = scale / t.scale;
  return clampTransform(
    { scale, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio },
    width,
    height,
  );
}

/** ダブルタップ/ダブルクリック: 等倍なら拡大、拡大中なら等倍へ戻す。 */
export function toggleZoomAt(
  t: ZoomTransform,
  px: number,
  py: number,
  width: number,
  height: number,
): ZoomTransform {
  if (t.scale > MIN_SCALE + 0.01) return IDENTITY;
  return zoomAt(t, DOUBLE_TAP_SCALE, px, py, width, height);
}

/** ホイール1目盛り(deltaY)に対する倍率。 */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.002);
}
