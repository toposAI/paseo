/**
 * サイドバー下部バーの項目と、確認箱の中のタブの出し分け(2026-10-24 ユーザー指示・第3版)。
 *
 * 下部バーは PC 幅も iPhone 幅も**同じ並び**にする:
 *   ユーザー判断 → バグ報告 → スレ一覧 → 構想一覧 → メールUI
 * 「ユーザー判断」は確認箱の中から出して下部バーに並べる。確認箱そのものは
 * 下部バーの「バグ報告」から開く(中では バグ報告・通知・優先順位 の3枚タブ)。
 *
 * 第3版(2026-10-26 ユーザー指示): 「子スレ完了」の下部バー項目・確認箱のタブ・バッジを撤去した。
 * 完了報告は完了箱C(スレ)へ一本化しており、確認箱で個別に確認する面を持たない
 * (`.claude-memory/project_sidebar_improvement_20261021.md`)。
 *
 * 並びはホストが `addSidebarFooterItem` の**登録順**で決める(`sidebarFooterItems` の保存設定が
 * 空のときの既定)。保存設定が入っている場合はホストの設定が優先される(プラグインからは触らない)。
 */

/** 本プラグインの footer 項目。並びは登録順(= 保存設定が空のときの既定順)。 */
export const FOOTER_TABS = [
  { id: "judgment", title: "ユーザー判断" },
  { id: "bugs", title: "バグ報告" },
  { id: "sidebar-threads", title: "スレ一覧" },
  { id: "sidebar-concepts", title: "構想一覧" },
  { id: "mail", title: "メールUI" },
] as const;

export type FooterTabId = (typeof FOOTER_TABS)[number]["id"];

/** footer 項目の表示名。登録タイトルと読み上げで同じ文字列を使う(SSOT は `FOOTER_TABS`)。 */
export function footerTitle(id: FooterTabId): string {
  const tab = FOOTER_TABS.find((t) => t.id === id);
  return tab ? tab.title : id;
}

/** 下部バーの「ユーザー判断」から開く画面の id。 */
export const BOX_TAB_SCREEN_ID = "box-tab";

/** 確認箱のタブのうち、下部バーへ移したもの(= 確認箱の中には出さない)。 */
const MOVED_TAB_IDS = new Set<string>(["items"]);

/**
 * 確認箱の中に出すタブの並び。下部バーへ移した「ユーザー判断」は常に外す
 * (PC も iPhone も同じ3枚)。
 */
export function confirmBoxTabs<T extends { id: string }>(all: readonly T[]): readonly T[] {
  return all.filter((t) => !MOVED_TAB_IDS.has(t.id));
}

/**
 * 確認箱の「バグ報告」タブのバッジ=**まだ終わっていない**報告の数(定義は
 * `shared/feedback.ts` の `countOpenReports`)。
 * 通知の未読は下部バーに出さない(箱の中の通知タブにバッジが出る)。
 */
export function bugBadgeCount(counts: { bugs?: number; [key: string]: unknown }): number {
  return counts.bugs ?? 0;
}

/** PC幅の下限(ホストの compact 境界と同じ720px。`packages/app/src/styles/unistyles.ts` の md)。 */
export const WIDE_MIN_WIDTH = 720;
/**
 * PC幅とみなす高さの下限。横倒しにした iPhone(例 932×430)は幅だけ見ると PC 幅になるが、
 * 一覧とチャットを横に並べるのは高さのある画面だけにする。
 * プラグインにはタッチ端末かどうかが届かないため、判定材料は幅と高さだけ。
 */
export const WIDE_MIN_HEIGHT = 480;

/**
 * 描画先が PC 幅か(一覧とチャットを横に並べるか)。高さが取れない呼び出しでは幅だけで判定する。
 * `compact` はホストの `layout.compact`(幅<720)。
 * 下部バーと確認箱のタブは幅で出し分けない(第2版で PC と iPhone を同じ並びにした)ので、
 * この判定は**画面の並べ方にだけ**使う。
 */
export function isWideLayout(width: number, height: number | undefined, compact = false): boolean {
  if (compact) return false;
  return width >= WIDE_MIN_WIDTH && (height === undefined || height >= WIDE_MIN_HEIGHT);
}
