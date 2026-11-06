/**
 * カードの見出しと画像の下の説明文の整え方(ce91 の表示差し戻し)。
 * 「(2/2枚目)」は折り返し・省略で欠けると何枚目か分からなくなるので、見出し本体と分けて必ず残す。
 */

const COUNT_SUFFIX = /\s*[((]\s*\d+\s*\/\s*\d+\s*枚目\s*[))]\s*$/;

export interface SplitTitle {
  title: string;
  /** 「(2/2枚目)」。無ければ空文字。 */
  suffix: string;
}

export function splitShotCount(subject: string): SplitTitle {
  const m = COUNT_SUFFIX.exec(subject);
  if (!m) return { title: subject, suffix: "" };
  return { title: subject.slice(0, m.index).trimEnd(), suffix: m[0].trim() };
}

const squash = (s: string): string => splitShotCount(s).title.replace(/\s+/g, "").toLowerCase();

/** 画像の下の説明文。見出しと同じ(枚数表記を除いて)なら出さない(null)。 */
export function captionToShow(caption: string | undefined, subject: string): string | null {
  const c = (caption ?? "").trim();
  if (!c) return null;
  return squash(c) === squash(subject) ? null : c;
}

/** 縦長画像の描画上限。幅いっぱいに描き、これより縦に長い分は切る(全画面と拡大で細部を見る)。 */
export const SHOT_MAX_HEIGHT = 520;
/** 画像の大きさが分かる前の仮の縦横比(枠の高さがガタつきすぎないように)。 */
export const SHOT_FALLBACK_RATIO = 1.6;

/** 画像の縦横比(幅/高さ)。壊れた値は仮の比に落とす。 */
export function shotRatio(width: number, height: number): number {
  return width > 0 && height > 0 ? width / height : SHOT_FALLBACK_RATIO;
}
