/**
 * 判断カードの行を画面に出したとき、先頭が上へ隠れていたら先頭へ合わせる(2026-11-01 壁打ち4)。
 *
 * 隠れているかの基準は**実測**: いちばん近いスクロール領域の上端(=ヘッダーの下端)と
 * カードの上端を比べる。ヘッダーの高さを固定値で持たないので、ヘッダーが背高になっても
 * 先頭は隠れない。画面全体(0)と比べるだけだと、ヘッダーの下に少しだけ潜った状態
 * (上端が 0〜ヘッダー高の間)を見のがす。
 */

export interface AlignBox {
  getBoundingClientRect: () => { top: number };
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  parentElement?: AlignBox | null;
}

type StyleOf = (el: AlignBox) => { overflowY?: string } | null;

const styleOfNode: StyleOf = (el) =>
  typeof getComputedStyle === "function"
    ? (getComputedStyle(el as never) as { overflowY?: string })
    : null;

/** いちばん近い「縦にスクロールする親」を探す(見つからなければ null=ページ全体でスクロール)。 */
export function scrollParent(el: AlignBox, styleOf: StyleOf = styleOfNode): AlignBox | null {
  let n = el.parentElement ?? null;
  while (n) {
    const oy = styleOf(n)?.overflowY ?? "";
    if (
      /(auto|scroll)/.test(oy) &&
      typeof n.scrollHeight === "number" &&
      typeof n.clientHeight === "number" &&
      n.scrollHeight > n.clientHeight + 1
    ) {
      return n;
    }
    n = n.parentElement ?? null;
  }
  return null;
}

/**
 * 先頭が隠れていたら、いちばん近いスクロール領域を「隠れている分だけ」戻す。
 * 隠れていなければ何もしない(利用者のスクロールを動かさない)。
 */
export function alignToTop(node: unknown, styleOf: StyleOf = styleOfNode): void {
  const el = node as AlignBox | null;
  if (!el || typeof el.getBoundingClientRect !== "function") return;
  const scroller = scrollParent(el, styleOf);
  const limit = scroller ? scroller.getBoundingClientRect().top : 0;
  const hidden = el.getBoundingClientRect().top - limit;
  if (hidden >= -2) return; // 隠れていない(2px は丸め誤差とみなす)
  if (scroller && typeof scroller.scrollTop === "number") {
    scroller.scrollTop = Math.max(0, scroller.scrollTop + hidden);
    return;
  }
  if (typeof window !== "undefined" && typeof window.scrollBy === "function") {
    window.scrollBy(0, hidden);
  }
}
