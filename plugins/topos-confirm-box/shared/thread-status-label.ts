/**
 * サイドバーの子スレ行に出す状態ラベル。登録簿の status(自己申告)だけだと、止まったスレが
 * 「実装中」のまま残るため、Paseo の機械状態を併せて出す:
 * - `closed` が取れている → status に関わらず「終了」(止まった/閉じたスレ)
 * - 一覧の取得に失敗した → 直前の値を古い表示として区別する
 * Node/React のAPIは使わない(両ランタイムが import する)。
 */
export type StatusKind = "done" | "closed" | "waiting" | "running" | "idle";

/**
 * 機械状態から導く状態語彙の種類(登録簿に載らないスレ = Paseo から直接建てたスレ用)。
 *
 * 登録簿の行は人が登録時に入れた status が正だが、登録簿に無いスレには正になる status が無い。
 * 一律「実装中」にすると、アイドルや承認待ちのスレまで実装中として並び、**動いていないスレが
 * 動いているように見える**(出口レビュー round1 指摘2)。そこで機械状態だけを語彙へ写す。
 */
export function statusKindOfMachine(machineState: string | null): StatusKind {
  switch (machineState) {
    case "running":
    case "initializing":
      return "running";
    case "waiting_approval":
    case "approval":
    case "permission":
      return "waiting";
    case "closed":
      return "closed";
    // `idle`・`error`・未知・null は「動いていない」に寄せる(動いていると誤って見せない)
    case "idle":
    default:
      return "idle";
  }
}

/** 機械状態から導く状態語彙の文言(状態の帯に出す)。 */
export function statusTextOfMachine(machineState: string | null): string {
  switch (statusKindOfMachine(machineState)) {
    case "running":
      return "実装中";
    case "waiting":
      return "承認待ち";
    case "closed":
      return "終了";
    default:
      return "待機中";
  }
}

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
