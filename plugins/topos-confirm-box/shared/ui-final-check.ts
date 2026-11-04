/**
 * 「UIの最終チェック」カードの判定と画像の割り当て(純関数。画面からも試験からも使う)。
 *
 * 投函側(scripts/confirm_box_deposit.py の `kind: ui_final_check`)は、件名を「UIの最終チェック: <画面>」、
 * group を `ui-final-check`、選択肢を a=OK / b=直してほしい、画像を [PC完成版, iPhone完成版, PC変更前, iPhone変更前]
 * の順(変更前は任意)で入れる。ここはその約束だけを読む。
 */
export const UFC_SUBJECT_PREFIX = "UIの最終チェック";
export const UFC_GROUP = "ui-final-check";
/** 「OK」ボタンの選択肢 id(投函側の約束)。 */
export const UFC_OK_ID = "a";

export function isUiFinalCheck(item: { subject: string; group: string | null }): boolean {
  return item.group === UFC_GROUP || item.subject.startsWith(UFC_SUBJECT_PREFIX);
}

export interface UfcImage {
  data: string;
  mimeType: string;
}

export interface UfcShots<T extends UfcImage> {
  /** 完成版(PC, iPhone の順。無いものは入らない)。 */
  finals: T[];
  /** 変更前(PC, iPhone の順)。 */
  befores: T[];
}

/** 画像配列を完成版と変更前に分ける。先頭2枚が完成版、残りが変更前。 */
export function splitShots<T extends UfcImage>(images: readonly T[] | undefined): UfcShots<T> {
  const all = images ?? [];
  return { finals: all.slice(0, 2), befores: all.slice(2, 4) };
}

/** 縦横比を保ったまま maxW×maxH の枠に収めた大きさ(拡大はしない)。寸法が不明(0以下)なら枠いっぱい。 */
export function fitInside(
  width: number,
  height: number,
  maxW: number,
  maxH: number
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: maxW, height: maxH };
  const scale = Math.min(maxW / width, maxH / height, 1);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** 画像の見出し(拡大表示の上に出す)。 */
export function shotLabel(index: number, isBefore: boolean): string {
  const device = index === 0 ? "PC" : "iPhone";
  return `${isBefore ? "変更前" : "完成版"} ${device}`;
}
