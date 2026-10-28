/**
 * バッジの「ユーザー判断」の件数=確認箱の **open 件数 N**。
 *
 * 2026-10-27: サイドバーのバッジが N より大きく出ることがあった(実測 バッジ11 対 N=10)。
 * 原因は、Vault 判断ノート化の前から箱に残っている `state: "new"` の判断行(どのノートの `legacy_keys` にも
 * 載っていない古い行)も数えていたこと。判断窓口の N は **Vault の判断ノート(state が open)だけ**を数える
 * (`judgment_window.py` の `open_notes` / `counts.open`)ので、ノートを持たない箱の行は N に出てこない
 * (その行の決定は別経路で済んでいて、箱の `ack` が書かれていないだけ。回答の書き先もノートなので、
 * ノートの無い行には答えられない。例: `coord-j-6b02455-20261025`)。
 *
 * N の対象は「Vault の判断ノート由来の open」+「Paseo の承認待ち(permit)の open」。permit は判断窓口の
 * 外の別枠だが、ユーザーが答えないと止まる本物の判断なので数える(N とずれることがある)。
 *
 * 一方 **一覧(判断タブ)** は、まだノートになっていない投函も見えるべきなので、今までどおり
 * 「判断印 or permit の open」を出す。N と行数がずれることがあるが、隠す方が害が大きい
 * (ノート化が遅れた判断が画面から消える)。N に数える対象は行の対象の部分集合にしてある
 * (バッジに出ている件は必ず一覧にもある)。
 *
 * 数え方はここ1本にまとめ、確認箱の中のバッジ・下部バー(`index.client.tsx`)・判断タブの既定の絞り込みは
 * すべてこのファイルの述語を使う(片方だけ直すと再びずれる)。
 */
import { isJudgmentItem } from "./contract.js";
import type { ConfirmBoxItem } from "./contract.js";

/**
 * Vault の判断ノートから作った項目の出所。サーバー専用モジュールからは import できない
 * (shared バンドルがビルドで落ちる)ので、定義はここに置き、server 側が再 export する。
 */
export const VAULT_DECISION_SOURCE = "vault_decision_note";

/** 箱の項目のうち open(新しい・まだ見ていない)。`approved` は決定済み、`read` は既読(open は出さない)。 */
export const OPEN_BOX_STATE = "new";

/** まだ決まっていない(承認済み・既読でない)項目か。判断かどうかは見ない。 */
export function isOpenState(item: ConfirmBoxItem): boolean {
  return item.state === OPEN_BOX_STATE;
}

/**
 * Vault の判断ノートから作った項目か。出所(`readVaultDecisions` が付ける `VAULT_DECISION_SOURCE`)で判定する
 * (`key` の `vault:` 接頭辞だけで見ると、箱の行に同じ形の key が付いたときに二重に数える余地がある)。
 */
export function isVaultNoteItem(item: ConfirmBoxItem): boolean {
  return item.kind !== "permit" && item.source === VAULT_DECISION_SOURCE;
}

/**
 * 判断タブに既定で並べる「まだ決まっていない判断」か。判断印か permit のうち `state: "new"` だけ
 * (承認済み・既読は出さない。旧形式・通知は呼び出し側の絞り込みで外す)。
 */
export function isJudgmentOpen(item: ConfirmBoxItem): boolean {
  return isOpenState(item) && isJudgmentItem(item);
}

/**
 * バッジの N に数える項目か。**判断窓口の `counts.open` と同じ対象**に絞る:
 * Vault 判断ノート由来の項目と permit のうち `state: "new"` だけ。ノートを持たない箱・中間形式の判断行は
 * 数えない(N に出てこない)。`isJudgmentOpen` を前提に組み立てるので、数える対象は必ず判断タブにも出る。
 */
export function isJudgmentCounted(item: ConfirmBoxItem): boolean {
  // 裏方が検討中・保留中の件(`onHold`)は窓口Aも出せないので数えない(一覧には「保留中」として出す)。
  // 2026-10-28 ユーザー指摘「そしたらバッジださないでよ」: バッジ2なのに窓口は0件だった。
  if (item.onHold) return false;
  return isJudgmentOpen(item) && (item.kind === "permit" || isVaultNoteItem(item));
}

/** バッジの open 件数 N。確認箱の中のバッジと下部バーはこれを使う。 */
export function countJudgmentCounted(items: readonly ConfirmBoxItem[]): number {
  return items.filter(isJudgmentCounted).length;
}
