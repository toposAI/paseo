const LINE_H = 20;
const MIN_H = 44;
const MAX_H = 120;
const CHAR_W = 8;

/** 行数(改行+折り返しの見積り)から入力欄の高さを決める。RN webの multiline は自動で伸びないため。 */
export function composerHeight(text: string, innerWidth: number): number {
  const perLine = Math.max(4, Math.floor(innerWidth / CHAR_W));
  const lines = text
    .split("\n")
    .reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / perLine)), 0);
  return Math.min(MAX_H, Math.max(MIN_H, 18 + LINE_H * lines));
}
