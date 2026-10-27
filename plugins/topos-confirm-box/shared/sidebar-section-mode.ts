/**
 * サイドバーで出す一覧のタブ(スレ一覧 / 構想一覧)。**状態を持たない純粋関数だけ**を置く。
 *
 * 実体(現在値・購読者・保存)は `client/sidebar-mode.ts` に置く。ここに分けているのは、
 * RN を読み込まずに単体テストするため(テストは `server/sidebar-section-mode.test.ts`)。
 *
 * 経緯(2026-10-24 ユーザー指示): 上段(スレ)と下段(構想)を同じサイドバーに積むのをやめ、
 * Paseo のサイドバー下部タブバーの2項目で切り替える。
 */

export const SIDEBAR_SECTIONS = ["threads", "concepts", "projects"] as const;
export type SidebarSectionKey = (typeof SIDEBAR_SECTIONS)[number];

/** 初期値。props で指定が無ければスレ一覧を出す(従来の主画面を変えない)。 */
export const DEFAULT_SIDEBAR_SECTION: SidebarSectionKey = "threads";

export const SIDEBAR_SECTION_LABELS: Record<SidebarSectionKey, string> = {
  threads: "スレ一覧",
  concepts: "構想一覧",
  projects: "共有プロジェクト",
};

/** 保存先のキー。値の書式は変えない想定なので、版番号は付けない。 */
export const SIDEBAR_SECTION_STORAGE_KEY = "topos-confirm-box.sidebarMode";

/**
 * 外部(タブ・保存値・URL)から来た値を安全にタブへ寄せる。未知の値は既定タブ
 * (保存値が壊れていてもサイドバーが空にならない)。
 */
export function normalizeSidebarSection(value: unknown): SidebarSectionKey {
  return SIDEBAR_SECTIONS.includes(value as SidebarSectionKey)
    ? (value as SidebarSectionKey)
    : DEFAULT_SIDEBAR_SECTION;
}

/** タブを押したときに次に出す一覧。同じタブを押しても切り替えない(= 常にその一覧)。 */
export function sectionAfterPress(current: SidebarSectionKey, pressed: unknown): SidebarSectionKey {
  // 別のタブを押したらそのタブへ。同じタブなら現状維持(押し直しで思いがけず入れ替わらない)。
  const next = normalizeSidebarSection(pressed);
  return SIDEBAR_SECTIONS.includes(pressed as SidebarSectionKey) ? next : current;
}

/** 保存された文字列をタブへ戻す。`null`(未保存)・読めない値は既定タブ。 */
export function parseStoredSection(raw: string | null | undefined): SidebarSectionKey {
  if (raw == null || raw === "") return DEFAULT_SIDEBAR_SECTION;
  return normalizeSidebarSection(raw);
}

/** localStorage から読む。localStorage が無い(SSR/ネイティブの一部)・例外でも既定タブへ落ちる。 */
export function loadStoredSection(
  storage: Pick<Storage, "getItem"> | undefined,
): SidebarSectionKey {
  try {
    return parseStoredSection(storage?.getItem(SIDEBAR_SECTION_STORAGE_KEY));
  } catch {
    return DEFAULT_SIDEBAR_SECTION;
  }
}

/**
 * localStorage へ保存する。保存できなくても画面の切替は動くので、失敗は握りつぶす
 * (プライベートモード等で `setItem` が投げる)。
 */
export function saveStoredSection(
  storage: Pick<Storage, "setItem"> | undefined,
  section: SidebarSectionKey,
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SIDEBAR_SECTION_STORAGE_KEY, section);
    return true;
  } catch {
    return false;
  }
}

/**
 * 画面のグループ「司令塔」(司令塔の行とその子を1つに寄せる。groupPressAction の開閉のみのキー)。
 * クライアントと通しテストの両方で同じ値を使うため、ここに置く。
 */
export const COORDINATOR_GROUP = "__coordinators";

/**
 * 画面のグループ「ピン止め」(ピン止めした子スレを「司令塔」の外へ出し、その上に並べる。
 * 2026-10-25 ユーザー指示「ピン止めしたら、司令塔スレの外にだして、上部の司令塔の下において」)。
 * 司令塔の行はピン止めの対象外(`server/coordinator-threads.ts` が `pinned: false` 固定)。
 */
export const PINNED_GROUP = "__pinned";

/** グループ見出しの題名(ピン止めグループは開閉できないので、ここで固定する)。 */
export const PINNED_GROUP_LABEL = "ピン止め";

/** 一覧が空のときの行の文言(タブごと)。 */
export function emptySectionLabel(section: SidebarSectionKey): string {
  if (section === "projects") return "参加している共有プロジェクトはありません";
  return section === "concepts" ? "進行中の構想はありません" : "実装中のスレはありません";
}
