/**
 * サイドバー下部バーの項目と、確認箱の中のタブの出し分け(2026-10-24 ユーザー指示)。
 *
 * PC幅では「ユーザー判断」「子スレ完了」を確認箱の**中から出して下部バーに並べる**
 * (ユーザー判断 → 子スレ完了 → 確認箱)。確認箱の中は バグ報告・通知・優先順位 だけになる。
 * iPhone等の狭い幅は**従来どおり**(下部バーに出さず、確認箱の中の5枚タブのまま)。
 *
 * 幅の判定は2種類ある。下部バーの項目はホストが `layout.compact`(画面幅 <720 で true)を渡すので
 * それに従い、確認箱の中のタブは**描画先の箱の幅**(ポップオーバーは窓が広くてもね箱が420px)で決める。
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

/** PC幅か。確認箱の画面は描画先の箱の幅で判定する(狭い幅=iPhone は従来のまま)。 */
export function isWideLayout(containerWidth: number | undefined, windowWidth: number): boolean {
  return (containerWidth ?? windowWidth) >= 720;
}

/** 下部バーから開いた画面のタブ。不正な値は「ユーザー判断」に倒す。 */
export function boxTabMode(param: string | undefined): "items" | "childdone" {
  return param === "childdone" ? "childdone" : "items";
}
