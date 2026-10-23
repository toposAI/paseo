/**
 * サイドバー二段の**上段**(実装ノートの status で子スレ行を絞り込む)の純粋関数。
 *
 * - ノートの status が正(標準_サイドバーの表示ルール)。子スレ一覧の status(=古い語彙)は
 *   ノートが無いスレにだけ使う。
 * - 上段に出すのは status が 実装中/判断待ち/確認待ち の行(ノートがあるスレ)、または
 *   ノートが無く子スレ一覧でも 実装中/ユーザー判断待ち の行(ノート作成前の移行期間)。
 *   ノートがあるのに `完了` 等他の status のスレは上段から外す(勝手に畳まない)。
 * - 行の題名と状態文字はノート側を優先する(スレ側は古いことがあるため)。
 */
import { LOWER_TIER_STATUSES, UPPER_TIER_STATUSES } from "./notes.js";
import type { NoteStatus, SidebarNote } from "./notes.js";

/** 子スレ一覧側の status(shared/child-threads.ts と同値。循環 import を避けここで受け取る)。 */
export type ThreadStatusHint = "実装中" | "ユーザー判断待ち" | "完了";

export interface RowThread {
  agentId: string;
  title: string;
  status: ThreadStatusHint;
}

export interface SidebarRowView<T> {
  thread: T;
  /** 行の題名(ノートがあればノートの題名)。 */
  title: string;
  /** 行右端の状態文字。 */
  statusLabel: NoteStatus;
  /** この行に対応する実装ノート(無ければ null)。 */
  note: SidebarNote | null;
}

const isUpperStatus = (s: NoteStatus) => UPPER_TIER_STATUSES.includes(s);

/**
 * 上段の行を作る。ノートの無いスレは従来どおり(実装中/ユーザー判断待ちのみ)残す。
 * 並びは入力の順を保つ(ドラッグ並びを壊さない)。
 */
export function buildUpperRows<T extends RowThread>(
  threads: readonly T[],
  implByThread: ReadonlyMap<string, SidebarNote>,
): SidebarRowView<T>[] {
  const rows: SidebarRowView<T>[] = [];
  for (const t of threads) {
    const note = implByThread.get(t.agentId) ?? null;
    if (note) {
      if (!isUpperStatus(note.status)) continue;
      rows.push({ thread: t, title: note.title || t.title, statusLabel: note.status, note });
      continue;
    }
    if (t.status === "完了") continue;
    rows.push({
      thread: t,
      title: t.title,
      statusLabel: t.status === "ユーザー判断待ち" ? "判断待ち" : "実装中",
      note: null,
    });
  }
  return rows;
}

/**
 * 実装ノートをスレIDで引ける形にする(行に status・題名を重ねる材料)。
 * ノートは1スレに1枚(検収単位と1対1)なので、解決済みの threadId だけを張る。
 * 解決できない候補しか無いノートは、そのスレの行に重ねない。同じスレに複数枚あれば
 * **先頭(新しい順の最初)勝ち**。テストの写しと本番で結果がずれないよう、クライアントは
 * これだけを使う(出口レビュー round2 指摘1)。
 */
export function indexImplementationNotes(
  notes: readonly SidebarNote[],
): ReadonlyMap<string, SidebarNote> {
  const map = new Map<string, SidebarNote>();
  for (const n of notes) {
    if (n.kind === "implementation" && n.threadId && !map.has(n.threadId)) {
      map.set(n.threadId, n);
    }
  }
  return map;
}

/** 下段(進行中の構想ノート)。構想/壁打ち中だけ。並びは入力順(サーバーが新しい順に並べる)。 */
export function lowerTierNotes(notes: readonly SidebarNote[]): SidebarNote[] {
  return notes.filter((n) => n.kind === "concept" && LOWER_TIER_STATUSES.includes(n.status));
}
