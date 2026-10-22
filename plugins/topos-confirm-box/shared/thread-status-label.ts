/**
 * サイドバーの子スレ行に出す状態ラベル。登録簿の status(自己申告)だけだと、止まったスレが
 * 「実装中」のまま残るため、Paseo の機械状態を併せて出す:
 * - `closed` が取れている → status に関わらず「終了」(止まった/閉じたスレ)
 * - 一覧の取得に失敗した → 直前の値を古い表示として区別する
 * Node/React のAPIは使わない(両ランタイムが import する)。
 */
export type StatusKind = "done" | "closed" | "waiting" | "running";

export interface StatusLabel {
  text: string;
  kind: StatusKind;
}

export function displayStatus(
  status: string,
  machineState: string | null,
  failed = false,
): StatusLabel {
  const stale = failed ? "(古い表示)" : "";
  if (machineState === "closed") return { text: `終了${stale}`, kind: "closed" };
  if (status === "完了") return { text: `完了${stale}`, kind: "done" };
  if (status === "ユーザー判断待ち") return { text: `判断待ち${stale}`, kind: "waiting" };
  return { text: `実装中${stale}`, kind: "running" };
}
