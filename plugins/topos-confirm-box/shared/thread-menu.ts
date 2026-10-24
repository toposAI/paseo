/**
 * サイドバー行の**操作メニュー**(状態の帯を押すと開くポップアップ)の状態遷移。
 *
 * 行末のピン/アーカイブのアイコンを廃止し、状態の帯そのものを入口にした(2026-10-24 ユーザー指示)。
 * 描画は `client/ThreadMenu.tsx`、ここは副作用を持たない純粋関数だけを置く(RN を読み込まずに
 * 単体テストできるようにするため。テストは `server/thread-menu.test.ts`)。
 *
 * **アーカイブの2段階確認はここが唯一の正**: 1回目の押下で `confirmingArchive` を立てるだけで、
 * 2回目で初めて `intent: "archive"` を返す。メニューを閉じる/開き直すと確認は必ずリセットする
 * (閉じたあとに1回押しただけで実行される、という取り違えを起こさない)。
 */

export interface ThreadMenuState {
  /** メニューが開いているか。 */
  open: boolean;
  /** アーカイブの2段階確認。1回目の押下で true、2回目の押下で実行する。 */
  confirmingArchive: boolean;
}

export type ThreadMenuAction = "open" | "close" | "toggle-pin" | "archive" | "open-thread";

/** 画面側が実行する副作用。状態遷移だけの操作では null。 */
export type ThreadMenuIntent = "toggle-pin" | "archive" | "open-thread";

export interface ThreadMenuStep {
  state: ThreadMenuState;
  intent: ThreadMenuIntent | null;
}

/** 閉じた状態(確認も無い)。共有しても壊れないよう凍結する。 */
export const CLOSED_MENU: ThreadMenuState = Object.freeze({
  open: false,
  confirmingArchive: false,
});

/** 開いた直後の状態。開き直すたびに確認はリセットされる。 */
export const OPEN_MENU: ThreadMenuState = Object.freeze({
  open: true,
  confirmingArchive: false,
});

/**
 * メニューの次の状態と、実行すべき副作用を返す。
 *
 * - `open`: 開く(確認はリセット)。
 * - `close`: 閉じる(確認も捨てる)。
 * - `toggle-pin`: ピン止めの切り替えを実行して閉じる。
 * - `open-thread`: スレを開いて閉じる。
 * - `archive`: 1回目は確認待ちにして開いたまま、2回目で実行して閉じる。
 *
 * 閉じている間の操作は無視する(遅れて届いた押下で勝手に走らせない)。
 */
export function nextMenu(state: ThreadMenuState, action: ThreadMenuAction): ThreadMenuStep {
  if (action === "open") return { state: OPEN_MENU, intent: null };
  if (!state.open) return { state: CLOSED_MENU, intent: null };
  switch (action) {
    case "close":
      return { state: CLOSED_MENU, intent: null };
    case "toggle-pin":
      return { state: CLOSED_MENU, intent: "toggle-pin" };
    case "open-thread":
      return { state: CLOSED_MENU, intent: "open-thread" };
    case "archive":
      if (!state.confirmingArchive) {
        return { state: { open: true, confirmingArchive: true }, intent: null };
      }
      return { state: CLOSED_MENU, intent: "archive" };
    default:
      return { state, intent: null };
  }
}

/**
 * その行のメニューにアーカイブ項目を出すか。
 *
 * **子を持つ行(= 司令塔)はアーカイブさせない**(2026-10-24 子司令塔の決定: 誤って親を畳むより、
 * 隠して安全側に倒す)。ピン止めは残す。司令塔の行は登録簿ではなく起こしデーモンの id から作られるので
 * `coordinator` で判定し、加えて他の行の親になっている id(`parentIds`)も対象にする
 * (司令塔の印が付かない親の行が混ざっても畳めないように)。
 */
export function menuCanArchive(
  thread: { agentId: string; coordinator?: boolean },
  parentIds: ReadonlySet<string>,
): boolean {
  if (thread.coordinator === true) return false;
  return !parentIds.has(thread.agentId);
}

/** メニューのアーカイブ項目の文言(1回目と2回目で変える)。 */
export function archiveMenuLabel(confirmingArchive: boolean): string {
  return confirmingArchive ? "もう一度押すとアーカイブ" : "アーカイブする";
}

/** メニューのピン項目の文言(現在の状態で切り替える)。 */
export function pinMenuLabel(pinned: boolean): string {
  return pinned ? "ピン止めを外す" : "ピン止めする";
}
