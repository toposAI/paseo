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
  // 止まった/閉じたスレは status に関わらず「終了」。`待機中` の行(登録簿に載らないスレ)は
  // status だけ見ると idle に見えるので、ここで closed を先に見ないと帯と行末の箱が食い違う
  // (出口レビュー round3 指摘1)。
  if (statusKindOfMachine(machineState) === "closed")
    return { text: `終了${stale}`, kind: "closed" };
  if (status === "完了") return { text: `完了${stale}`, kind: "done" };
  // 登録簿に載らないスレの語彙(機械状態から導く)。ここを落とすと「実装中」に化ける
  // (出口レビュー round2 指摘2)。
  if (status === "待機中") return { text: `待機中${stale}`, kind: "idle" };
  if (status === "承認待ち") return { text: `承認待ち${stale}`, kind: "waiting" };
  if (status === "ユーザー判断待ち") return { text: `判断待ち${stale}`, kind: "waiting" };
  return { text: `実装中${stale}`, kind: "running" };
}

/**
 * 行末の状態の文字と色(一覧の行・チップが使う規則の1か所)。閉じたスレ(`closed`)の「実装中」「待機中」を
 * 「終了」にする(`displayStatus` の closed 優先と同じ判断。2026-10-27、通し検証B 指摘2)。
 *
 * `判断待ち` は機械状態が idle/closed でも残す(返事待ちの印。動いていないことは色で示す)。
 */
export function rowStatusText(label: string, machineState: string | null | undefined): StatusLabel {
  // 閉じたスレは「実装中」「待機中」とも「終了」に寄せる(未登録の closed 行は「待機中」で来るため、
  // 実装中だけを対象にすると同じ closed が行の種類で別の語になる。出口レビュー round1 R1-7)。
  if (
    (label === "実装中" || label === "待機中") &&
    statusKindOfMachine(machineState ?? null) === "closed"
  ) {
    return { text: "終了", kind: "closed" };
  }
  return { text: label, kind: statusKindOfLabel(label) };
}

/** 行末の帯の色だけ(文字は呼び出し元の語彙のまま。行末の印の選び方に使う)。 */
export function rowStatusKind(label: string, machineState: string | null | undefined): StatusKind {
  return rowStatusText(label, machineState).kind;
}

/** ノート語彙の状態 → 帯の色(閉じたスレの「終了」も含めた1か所の定義)。 */
function statusKindOfLabel(label: string): StatusKind {
  if (label === "待機中") return "idle";
  if (label === "完了" || label === "終了") return label === "完了" ? "done" : "closed";
  if (label === "判断待ち" || label === "構想") return "waiting";
  if (label === "確認待ち") return "done"; // 旧語彙のノート(移行中だけ)
  return "running";
}
