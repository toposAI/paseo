/**
 * サイドバーの行に出す文字色を **WCAG AA(通常文字 4.5:1)** で選ぶ。
 *
 * ユーザーから「状態文字が薄くて読めない」と複数回指摘されているため、テーマの
 * `foregroundMuted` をそのまま使わず、行の背景に対して 4.5:1 を満たすか確かめてから使う。
 * 満たさなければ `foreground` に落とす(落とした結果も満たさないテーマは、テーマ側の
 * 問題なのでここでは何もしない=そのまま返す)。
 */

/** `#rgb` / `#rrggbb` / `#rrggbbaa` を [r,g,b] にする。読めなければ null。 */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  else if (hex.length === 8) hex = hex.slice(0, 6);
  else if (hex.length !== 6) return null;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG のコントラスト比。どちらかが読めなければ null。 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `preferred` が **すべての** 背景に対して `min` 以上ならそれを、駄目なら `fallback` を返す。
 * 背景が1つも無い/色が読めないときは `fallback`(安全側)。
 */
export function pickReadableText(
  preferred: string,
  fallback: string,
  backgrounds: readonly string[],
  min = 4.5,
): string {
  if (backgrounds.length === 0) return fallback;
  const ok = backgrounds.every((bg) => {
    const ratio = contrastRatio(preferred, bg);
    return ratio !== null && ratio >= min;
  });
  return ok ? preferred : fallback;
}
