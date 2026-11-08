/**
 * ユーザーが**自分の手で**子司令塔スレを閉じるボタン(2026-11-09)。
 *
 * 事故: 窓口が「表と写真表示の壁打ちを閉じて」を、名前・番号で**別スレ**と取り違え、外から
 * 閉じる指示を出しかけた。ユーザー原文「閉じたいスレで使うスキルつかうのと、僕が自分で
 * 子司令塔スレ閉じれるようにして こんなん危なくてむりだわ」。
 *
 * 決めた線(変えない):
 * - 閉じるスキル(`handoff-and-close`)は**閉じたいスレ自身の中でだけ**走る。外から別スレIDを
 *   指定して閉じる操作はスクリプト側が拒否する(ToposAI の `scripts/handoff_and_close.py`)。
 * - 外から閉じてよいのは、ユーザーがその行を直接指定するこのボタンだけ。ボタンはアーカイブを
 *   代行せず、**そのスレへ1通だけ**「自分でスキルを走らせて閉じて」と送る。閉じるのはスレ自身。
 * - 引き継ぎ先は既存スレのみ(新しい壁打ちを作らない)。既定は親。
 *
 * このファイルは純粋関数と RPC 契約だけ(RN を読み込まないので単体テストできる)。
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** 1件のIDの上限(`child_threads.json` 側の切り詰めと同じ)。 */
export const HANDOFF_CLOSE_ID_LIMIT = 200;

/** 引き継ぎ先の候補に出す件数の上限(スマホのボトムシートで芋づるに長くしない)。 */
export const HANDOFF_TARGET_LIMIT = 8;

export const childThreadsHandoffCloseRpc = defineRpc({
  name: "topos.childthreads.handoff-close",
  input: z.object({
    /** 閉じたいスレ(ユーザーが押した行)。 */
    agentId: z.string().min(1).max(HANDOFF_CLOSE_ID_LIMIT),
    /** 引き継ぎ先(既存スレ)。自分自身は不可。 */
    targetAgentId: z.string().min(1).max(HANDOFF_CLOSE_ID_LIMIT),
  }),
  output: z.object({
    ok: z.boolean(),
    /** 画面に出す1行(無言で閉じない)。 */
    message: z.string().optional(),
  }),
});
export type ChildThreadsHandoffCloseOutput = z.infer<typeof childThreadsHandoffCloseRpc.output>;

/** 判定に要る範囲だけの行の形(呼び手の型に縛られない)。 */
export interface HandoffThreadLike {
  agentId: string;
  title?: string | null;
  parentAgentId?: string | null;
  /** 司令塔(子を持つ行)か。並び順で親の次に出すだけに使う。 */
  coordinator?: boolean;
}

export interface HandoffTarget {
  agentId: string;
  title: string;
  /** 既定の引き継ぎ先(その行の親)か。画面で「(親)」と添える。 */
  isParent: boolean;
}

/**
 * 引き継ぎ先の候補。**既定=親**を先頭に、次に司令塔、そのあと一覧の順。
 * 自分自身とIDの重複は落とす。題名が空の行は出さない(取り違えの元)。
 */
export function handoffTargets(
  thread: HandoffThreadLike,
  threads: readonly HandoffThreadLike[],
  limit: number = HANDOFF_TARGET_LIMIT,
): HandoffTarget[] {
  const parentId = String(thread.parentAgentId ?? "");
  const out: HandoffTarget[] = [];
  const seen = new Set<string>([thread.agentId]);
  const push = (t: HandoffThreadLike) => {
    const id = String(t.agentId ?? "");
    const title = String(t.title ?? "").trim();
    if (!id || seen.has(id) || !title) return;
    seen.add(id);
    out.push({ agentId: id, title, isParent: id === parentId });
  };
  const parent = parentId ? threads.find((t) => t.agentId === parentId) : undefined;
  if (parent) push(parent);
  for (const t of threads) if (t.coordinator === true) push(t);
  for (const t of threads) push(t);
  return out.slice(0, Math.max(0, limit));
}

/**
 * その行のメニューに「引き継いで閉じる」を出すか。
 * 司令塔(子を持つ行)にも出す: 子司令塔こそユーザーが閉じたい対象だから(2026-11-09)。
 * ただし引き継ぎ先が1つも無い(親も他の既存スレも無い)ときは出さない(押しても進めない)。
 */
export function menuCanHandoffClose(targets: readonly HandoffTarget[]): boolean {
  return targets.length > 0;
}

/** 外から閉じる操作(行メニューのアーカイブ)を断る文。押した人の次の一手まで書く。 */
export const WALLTALK_CLOSE_REFUSAL =
  "壁打ち(子司令塔)のスレはここからは閉じられません。行メニューの「引き継いで閉じる」から閉じてください";

/**
 * **機械の門**(2026-11-09)。外からアーカイブしてよい行か。断る理由を返す(よければ null)。
 *
 * 壁打ち(子司令塔)は、閉じるスキルをスレ自身の中で走らせないと引き継ぎ文が届かないまま
 * 文脈が消える。だから外からのアーカイブは断り、ユーザーが「引き継いで閉じる」を押した
 * 経路(そのスレへ1通送る)だけを通す。
 */
export function externalCloseRefusal(input: {
  agentId: string;
  /** 登録簿の行(司令塔の印・親子関係を見る)。 */
  rows: readonly {
    agentId: string;
    coordinator?: boolean;
    parentAgentId?: string | null;
  }[];
  /** 振り分け(`child_thread_sides.json`)。読めなければ undefined を返してよい。 */
  sideOf: (agentId: string) => string | undefined;
}): string | null {
  const { agentId, rows, sideOf } = input;
  const walltalk =
    sideOf(agentId) === "walltalk" ||
    rows.some((r) => r.coordinator === true && r.agentId === agentId) ||
    rows.some((r) => r.parentAgentId === agentId);
  return walltalk ? WALLTALK_CLOSE_REFUSAL : null;
}

/** スレへ送る文面。押した時点の指定(自分・引き継ぎ先)を必ず本文に書く(取り違え防止)。 */
export function handoffClosePrompt(input: {
  sourceAgentId: string;
  targetAgentId: string;
  targetTitle: string;
  handoffPath: string;
}): string {
  const src = input.sourceAgentId.slice(0, 8);
  const dst = input.targetAgentId.slice(0, 8);
  return [
    `【ユーザーが「引き継いで閉じる」ボタンを押しました】`,
    `このスレ(${src})を「${input.targetTitle}」(${dst})へ引き継いで閉じます。`,
    "",
    "やること(このスレ自身の中で):",
    "1. `.claude/skills/handoff-and-close/SKILL.md` の型で引き継ぎ文を書く",
    `   (保存先: ${input.handoffPath})`,
    "2. 次の1行を実行する(点検→送信→受領確認→子スレの付け替え→自分をアーカイブ):",
    `   python3 scripts/handoff_and_close.py run --target ${input.targetAgentId} --handoff ${input.handoffPath} --execute`,
    "3. 点検で止まったら、**閉じずに**止まった理由を1行で返す(ユーザーが確認箱で見ます)。",
    "",
    "自分以外のスレを閉じないこと。引き継ぎ先は上の1つだけです。",
  ].join("\n");
}
