/**
 * バッジの「ユーザー判断」の件数=確認箱の **open 件数 N**。
 *
 * 2026-10-27: サイドバーのバッジが N より大きく出ることがあった。原因は、判断窓口側の定義
 * (`antigravity/utils/judgment_window.py` の `open_notes` / `counts.open` = state が open のノート)に対し、
 * 確認箱が `waiting_materials`(材料待ち。ユーザーが答える項目ではない)のノートも `judgment: true` の
 * 判断項目として画面とバッジに出していたこと。`state !== "approved"` だけで数えると材料待ちの件数だけ
 * N より大きくなる。箱の行・中間形式の材料待ち相当(`state: "read"`)も同じで、open ではないので数えない。
 *
 * 数え方をここ1本にまとめ、画面(`ConfirmBoxView`)・確認箱の中のバッジ・下部バー(`index.client.tsx`)は
 * すべてこれを使う(片方だけ直すと再びずれる)。サーバーの件数はカードの作成状況(`ready`/`waiting`/`held`)
 * に依存しない。それは判断窓口の内側の内訳であって、確認箱の open ではない。
 */
import { isJudgmentItem, type ConfirmBoxItem } from "./contract.js";

/** 箱の項目のうち open(新しい・まだ見ていない)。`approved` は決定済み、`read` は既読/材料待ち(open ではない)。 */
export const OPEN_BOX_STATE = "new";

/**
 * 確認箱の open(N)に数える判断項目か。判断印か permit のうち、箱の行は `state: "new"` だけ
 * (承認済み・既読=材料待ちは数えない)。旧形式・通知は数えない。
 */
export function isJudgmentOpen(item: ConfirmBoxItem): boolean {
  return isJudgmentItem(item) && item.state === OPEN_BOX_STATE;
}

/** 確認箱の open 件数 N。一覧・バッジ・下部バーはこれを使う。 */
export function countJudgmentOpen(items: readonly ConfirmBoxItem[]): number {
  return items.filter(isJudgmentOpen).length;
}
