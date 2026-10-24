/**
 * サイドバーの行の**左端**に出す「状態の点」。純正 Paseo のサイドバーと同じ意味・同じ色にする
 * (2026-10-24 ユーザー依頼「純正のサイドバーのスレにオレンジとか緑の点がつくやつ。とくにオレンジ。
 * どのスレに Ask が来ているのか全然わからん」)。
 *
 * 役割分担(ユーザー 2026-10-24): **確認箱=内容**(何を聞かれているか)、**一覧の点=所在**
 * (どのスレが止まっているか)。よって点は「いま Paseo がどう見ているか」だけを表し、
 * 行末の状態の帯(実装ノート/登録簿の status)とは別の軸として並べる。
 *
 * 意味の対応は Paseo 本体の `deriveAgentStateBucket`(`packages/protocol/src/agent-state-bucket.ts`)
 * と `getStatusDotColor`(`packages/app/src/utils/status-dot-color.ts`)に合わせた:
 * - needs_input(承認待ち)= 橙。`pendingPermissions` が1件以上、または `attentionReason === "permission"`
 * - failed(失敗)= 赤。`status === "error"` または `attentionReason === "error"`
 * - running(実行中)= 青。`status` が running / initializing
 * - attention(新着・未読の結果)= 緑。`requiresAttention`
 * - done(待機・終了)= 灰の小さい点(純正は idle の行にも半透明の点を置いて列の軸を保つ)
 *
 * 色は**テーマ非依存で固定**する(行末の帯と同じ理由: プラグインには明暗の別が渡らず、
 * 起動時のテーマ推測が外れても読める必要がある)。純正の点の色(light/dark)をそのまま持ち、
 * 背景の明暗だけ `appearanceOf()` で判定して選ぶ。値の正は
 * `packages/app/src/styles/theme.ts` の statusDot* と `packages/app/src/utils/status-dot-color.ts`。
 *
 * Node/React のAPIは使わない(両ランタイムが import する)。
 */

/** 点の種類(純正 Paseo の状態バケットと同じ語彙)。 */
export type StateDotKind = "needs_input" | "failed" | "running" | "attention" | "done";

export const STATE_DOT_KINDS = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
] as const satisfies readonly StateDotKind[];

/** 点を決める材料(Paseo の `AgentStateBucketInput` と同じ)。 */
export interface AgentStateDotInput {
  /** Paseo のライフサイクル状態(initializing/idle/running/error/closed)。 */
  machineState: string | null;
  /** 未読の結果があるか(純正では開くと消える)。 */
  requiresAttention?: boolean | null;
  /** 注意の理由。`permission` は「承認待ちで止まっている」。 */
  attentionReason?: string | null;
  /** 承認待ち(permission)の件数。`agents.list()` の `pendingPermissions` の長さ。 */
  pendingPermissionCount?: number | null;
}

/**
 * 材料から点の種類を決める。**判定の順序が意味を持つ**(純正と同じ):
 * 承認待ち > 失敗 > 実行中 > 新着 > 待機。承認待ちが最優先なのは、止まっているスレを
 * 一目で見つけるのがこの点の目的だから。
 */
export function deriveStateDot(input: AgentStateDotInput): StateDotKind {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission")
    return "needs_input";
  if (input.machineState === "error" || input.attentionReason === "error") return "failed";
  // 純正のバケットは `running` だけを実行中と数えるが、画面は initializing も「起動中」の輪で描く
  // (`sidebar-workspace-row-content.tsx` の loading)。点でも同じに見せる。
  if (input.machineState === "running" || input.machineState === "initializing") return "running";
  if (input.requiresAttention === true) return "attention";
  return "done";
}

/** 明暗。プラグインには `appearance` が渡らないので、背景色の輝度から判定する。 */
export type DotAppearance = "light" | "dark";

/** 背景色(hex)から明暗を決める。判定できない色は light に倒す(明るい点は暗い背景で読めないため)。 */
export function appearanceOf(backgroundHex: string | null | undefined): DotAppearance {
  const rgb = parseHex(backgroundHex);
  if (!rgb) return "light";
  // sRGB の相対輝度(WCAG と同じ式)。0.5 は白黒の中間。
  return relativeLuminance(rgb) > 0.5 ? "light" : "dark";
}

/** 純正の点の色(`statusDot*`)。done は本文色を薄く使うのでここには無い。 */
export const STATE_DOT_COLORS: Record<
  DotAppearance,
  Record<Exclude<StateDotKind, "done">, string>
> = {
  // light: L=0.62 / dark: L=0.72(純正 theme.ts のまま)
  light: {
    needs_input: "#b37824",
    failed: "#f12e2f",
    running: "#268ae0",
    attention: "#299f51",
  },
  dark: {
    needs_input: "#db932e",
    failed: "#f7796d",
    running: "#5caaf6",
    attention: "#35c264",
  },
};

/**
 * 点の見た目。`color` が null の種類(done)は、呼び出し側が本文色(foregroundMuted)を薄く使う。
 * 大きさは純正の 6px(`STATUS_INDICATOR_FILLED_DOT_SIZE`)より少し大きくする: 純正は行の先頭が
 * アイコン+点の2段構えで、点が小さいぶんアイコンが目印になる。こちらは点だけなので、
 * 単独で読める大きさ(8〜9px)にする。承認待ちだけ 9px にして最も目立たせる。
 */
export const STATE_DOT_SIZE: Record<StateDotKind, number> = {
  needs_input: 9,
  failed: 8,
  running: 8,
  attention: 8,
  done: 5,
};

/** done の点の不透明度(純正の idle の点は 0.3。列の軸を保つだけで状態を主張しない)。 */
export const STATE_DOT_DONE_OPACITY = 0.45;

/** 読み上げ・ツールチップ用の短い語(行末の帯とは別の軸であることが分かる文言)。 */
export const STATE_DOT_LABEL: Record<StateDotKind, string> = {
  needs_input: "承認待ち",
  failed: "失敗",
  running: "実行中",
  attention: "新着",
  done: "待機",
};

/**
 * `SidebarRow` の `icon` に渡す点の描き方(`client/StateDot.tsx` が読む。純粋な値だけなので shared)。
 *
 * なぜアイコンの位置に置くか: `SidebarRow` の先頭スロットは「アイコン名 or `{size,color}` を受ける
 * コンポーネント」しか受け付けず、任意のノードは置けない。よって行の先頭のアイコンを点に置き換える
 * (ホストはコンポーネントへ `size`=14 と文字色を渡してくる。点は渡された `size` を使わず下の
 * 箱で中央に寄せる)。
 * 意味は行末の状態の帯(実装ノート/登録簿の status)が持ち続けるので、点だけを残しても情報は失わない。
 */
export interface StateDotStyle {
  /** アイコン枠の一辺(px)。行の他のアイコンと同じ 14(ホストの `ICON_SIZE.sm`)。 */
  box: number;
  /** 点の直径(px)。 */
  size: number;
  /** 色。null は「呼び出し元が渡す文字色(`color` = foregroundMuted)を薄く使う」(done)。 */
  color: string | null;
  opacity: number;
}

export function stateDotStyle(kind: StateDotKind, appearance: DotAppearance): StateDotStyle {
  return {
    box: 14,
    size: STATE_DOT_SIZE[kind],
    color: kind === "done" ? null : STATE_DOT_COLORS[appearance][kind],
    opacity: kind === "done" ? STATE_DOT_DONE_OPACITY : 1,
  };
}

/**
 * 点の枠の背景色(明暗の判定に使う)。行が選ばれている(ホバー等)ときもホストの文字色
 * (`color`)は背景に応じて変わるので、判定に使うのは行の下地である `surface*`。
 */
export const DOT_BACKGROUND_KEYS = ["surface0", "surface1", "surface2"] as const;

/**
 * 承認待ち(点が橙)の行は、**帯の語彙も**「ユーザー判断待ち」に揃える。
 *
 * 揃えないと「点は橙(止まっている)のに帯は実装中(動いている)」と読めてしまう
 * (2026-10-24 実機確認で発覚)。承認待ちの間 Paseo の status は running のままなので、
 * 帯の材料(登録簿の `status`・機械状態)だけでは止まっていると分からないため、点の判定を正にする。
 * **登録簿の書き込み語彙は変えない**(この揃えは一覧を出すときだけの上書き)。
 */
export function statusWithDot<T extends string>(
  status: T,
  dot: StateDotKind | null,
): T | "ユーザー判断待ち" {
  return dot === "needs_input" ? "ユーザー判断待ち" : status;
}

function parseHex(hex: string | null | undefined): [number, number, number] | null {
  if (typeof hex !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
