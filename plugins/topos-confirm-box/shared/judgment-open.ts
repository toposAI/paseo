/**
 * バッジの「ユーザー判断」の件数=確認箱の **open 件数 N**。
 *
 * 2026-10-27: サイドバーのバッジが N より大きく出ることがあった(実測 バッジ11 対 窓口A「残り3」)。
 * 原因は2つ。
 * (1) 確認箱が `waiting_materials`(材料待ち。ユーザーが答える項目ではない)のノートも判断項目として
 *     出しており、`state !== "approved"` だけで数えると材料待ちの件数だけ多くなる。
 * (2) Vault 判断ノート化の前から箱に残っている `state: "new"` の判断行(どのノートの `legacy_keys` にも
 *     載っていない古い行)も数えていた。判断窓口の N は **Vault の判断ノート(state が open)だけ**を数える
 *     (`judgment_window.py` の `open_notes` / `counts.open`)ので、ノートを持たない箱の行は N に出てこない
 *     (その行の決定は別経路で済んでいて、箱の `ack` が書かれていないだけ。回答の書き先もノートなので、
 *     ノートの無い行には答えられない。例: `coord-j-6b02455-20261025`)。
 *
 * なので **数える側(N)** は「Vault の判断ノート由来(`key: vault:<id>`)の open」+「Paseo の承認待ち
 * (permit)の open」にする。permit は判断窓口の外の別枠だが、ユーザーが答えないと止まる本物の判断なので
 * 数える(材料待ち・承認済み・既読は数えない)。
 * 一方 **一覧(判断タブ)** は、まだノートになっていない投函も見えるべきなので、今までどおり
 * 「判断印 or permit の open」を出す。N と行数がずれることがあるが、隠す方が害が大きい
 * (ノート化が遅れた判断が画面から消える)。
 *
 * 数え方はここ1本にまとめ、確認箱の中のバッジと下部バー(`index.client.tsx`)は
 * `countJudgmentCounted` を使う(片方だけ直すと再びずれる)。
 */
import { isJudgmentItem } from "./contract.js";
import type { ConfirmBoxItem } from "./contract.js";

/** 箱の項目のうち open(新しい・まだ見ていない)。`approved` は決定済み、`read` は既読(open ではない)。 */
export const OPEN_BOX_STATE = "new";

/** Vault 判断ノート由来の項目の `key` 接頭辞(`shared/contract.ts` の `REJECT_KEY_PREFIX` と同じ値)。 */
export const VAULT_KEY_PREFIX = "vault:";

/**
 * 判断タブに既定で並べる「まだ決まっていない判断」か。判断印か permit のうち `state: "new"` だけ
 * (承認済み・既読=材料待ちは出さない)。旧形式・通知は出さない。
 */
export function isJudgmentOpen(item: ConfirmBoxItem): boolean {
  return isJudgmentItem(item) && item.state === OPEN_BOX_STATE;
}

/**
 * バッジの N に数える項目か。**判断窓口の `counts.open` と同じ対象**に絞る:
 * Vault 判断ノート由来(`key` が `vault:` 始まり)と permit のうち `state: "new"` だけ。
 * ノートを持たない箱・中間形式の判断行は数えない(それらは N に出てこない)。
 */
export function isJudgmentCounted(item: ConfirmBoxItem): boolean {
  if (item.state !== OPEN_BOX_STATE) return false;
  if (item.kind === "permit") return true;
  return !!item.key?.startsWith(VAULT_KEY_PREFIX);
}

/** バッジの open 件数 N。確認箱の中のバッジと下部バーはこれを使う。 */
export function countJudgmentCounted(items: readonly ConfirmBoxItem[]): number {
  return items.filter(isJudgmentCounted).length;
}
