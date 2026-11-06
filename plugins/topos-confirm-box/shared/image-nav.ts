/** 画像の拡大表示で、前後の画像の番号(端は反対側へ回る)。 */
export function neighborIndex(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}
