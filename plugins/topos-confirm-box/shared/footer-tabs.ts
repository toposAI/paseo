/**
 * サイドバー下部バーの項目と、確認箱の中のタブの出し分け(2026-10-24 ユーザー指示)。
 *
 * PC幅では「ユーザー判断」「子スレ完了」を確認箱の**中から出して下部バーに並べる**
 * (ユーザー判断 → 子スレ完了 → 確認箱)。確認箱の中は バグ報告・通知・優先順位 だけになる。
 * iPhone等の狭い幅は**従来どおり**(下部バーに出さず、確認箱の中の5枚タブのまま)。
 *
 * 幅の判定は2種類ある。下部バーの項目はホストが `layout.compact`(画面幅 <720 で true)を渡すので
 * それに従い、確認箱の中のタブは**描画先の箱の幅**(ポップオーバーは窓が広くても箱が420px)で決める。
 * どちらも最終的には `showsMovedFooterTabs`(幅720以上かつ高さ480以上)1本で揃える。
 *
 * 並びはホストが `addSidebarFooterItem` の**登録順**で決める(`sidebarFooterItems` の保存設定が
 * 空のときの既定)。保存設定が入っている場合はホストの設定が優先される(プラグインからは触らない)。
 */

/** 本プラグインの footer 項目。並びは登録順(= 保存設定が空のときの既定順)。 */
export const FOOTER_TABS = [
  { id: "judgment", title: "ユーザー判断" },
  { id: "childdone", title: "子スレ完了" },
  { id: "box", title: "確認箱" },
  { id: "mail", title: "メール" },
  { id: "sidebar-threads", title: "スレ一覧" },
  { id: "sidebar-concepts", title: "構想一覧" },
] as const;

export type FooterTabId = (typeof FOOTER_TABS)[number]["id"];

/** footer 項目の表示名。登録タイトルと読み上げで同じ文字列を使う(SSOT は `FOOTER_TABS`)。 */
export function footerTitle(id: FooterTabId): string {
  const tab = FOOTER_TABS.find((t) => t.id === id);
  return tab ? tab.title : id;
}

/** 下部バーの2項目から開く画面の id。`?mode=` と同じ値。 */
export const BOX_TAB_SCREEN_ID = "box-tab";
export const BOX_TAB_MODE_PARAM = "mode";

const MOVED_TAB_IDS = new Set<string>(["items", "childdone"]);
/** 確認箱のバッジに数えるタブ(残るタブのうち件数を持つもの)。 */
const BOX_BADGE_TAB_IDS = ["bugs", "notify"] as const;

/** 画面に出すタブの並び。PC幅(wide)だけ下部バーへ移した2枚を外す。狭い幅は従来どおり。 */
export function confirmBoxTabs<T extends { id: string }>(
  all: readonly T[],
  wide: boolean,
): readonly T[] {
  return wide ? all.filter((t) => !MOVED_TAB_IDS.has(t.id)) : all;
}

/** 確認箱のバッジ(PC幅)。中に残るタブの合計だけを数える(移した2枚を二重に数えない)。 */
export function confirmBoxBadgeCount(counts: Partial<Record<string, number>>): number {
  return BOX_BADGE_TAB_IDS.reduce((n, id) => n + (counts[id] ?? 0), 0);
}

/** PC幅の下限(ホストの compact 境界と同じ720px。`packages/app/src/styles/unistyles.ts` の md)。 */
export const WIDE_MIN_WIDTH = 720;
/**
 * PC幅とみなす高さの下限。横倒しにした iPhone(例 932×430)は幅だけ見ると PC 幅になるが、
 * 「iPhone版はそのまま」という指示に反するので、高さで狭い側へ倒す。iPad(768×1024)は PC 扱い。
 * プラグインにはタッチ端末かどうかが届かないため、判定材料は幅と高さだけ。
 */
export const WIDE_MIN_HEIGHT = 480;

/**
 * 描画先が PC 幅か。高さが取れない呼び出しでは幅だけで判定する。
 * `compact` はホストの `layout.compact`(幅<720)。幅の判定と重なるが、ホスト側の境界が変わっても
 * 下部バーと確認箱が食い違わないよう、判定を1か所に寄せるために受ける。
 */
export function isWideLayout(width: number, height: number | undefined, compact = false): boolean {
  if (compact) return false;
  return width >= WIDE_MIN_WIDTH && (height === undefined || height >= WIDE_MIN_HEIGHT);
}

/**
 * 下部バーに移した2項目を出すか(= 確認箱のタブを3枚にするか)。
 * サイドバーの下部バー(幅=窓幅)と確認箱の画面(幅=描画先の箱)の両方でこれ1本を使い、
 * 同じ画面の中で「バーに出たのに箱は5枚」のような食い違いを作らない。
 * ホストの `compact`(幅<720)は幅の判定と重なるが、ホスト側の境界が変わっても従来どおりへ倒れるよう残す。
 */
export function showsMovedFooterTabs(
  compact: boolean,
  width: number,
  height: number | undefined,
): boolean {
  return isWideLayout(width, height, compact);
}

/** 下部バーから開いた画面のタブ。不正な値は「ユーザー判断」に倒す。 */
export function boxTabMode(param: string | undefined): "items" | "childdone" {
  return param === "childdone" ? "childdone" : "items";
}
