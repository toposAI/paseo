/**
 * サイドバー二段の**上段**(実装ノートの status で子スレ行を絞り込む)の純粋関数。
 *
 * - ノートの status が正(標準_サイドバーの表示ルール)。子スレ一覧の status(=古い語彙)は
 *   ノートが無いスレにだけ使う。
 * - 上段に出すのは status が 実装中/判断待ち/確認待ち の行(ノートがあるスレ)、または
 *   ノートが無く子スレ一覧でも `完了` 以外の行(実装中/ユーザー判断待ち/承認待ち/待機中)。
 *   ノートがあるのに `完了` のスレは上段から外す(勝手に畳まない)。
 * - 行の題名と状態文字はノート側を優先する(スレ側は古いことがあるため)。
 */
import { LOWER_TIER_STATUSES, UPPER_TIER_STATUSES } from "./notes.js";
import type { NoteStatus, SidebarNote } from "./notes.js";

/**
 * 子スレ一覧側の status。登録簿の行は `shared/child-threads.ts` の3語彙、登録簿に載らない
 * (Paseo から直接建てた)スレは機械状態から導く2語彙(`server/unregistered-threads.ts`)を使う。
 * `待機中`/`承認待ち` も上段に出す(消すと「出ない」症状と見分けが付かない。動いていないことは
 * 状態の帯の色で示す。出口レビュー round1 指摘2)。
 */
export type ThreadStatusHint = "実装中" | "ユーザー判断待ち" | "完了" | "承認待ち" | "待機中";

export interface RowThread {
  agentId: string;
  title: string;
  status: ThreadStatusHint;
}

export interface SidebarRowView<T> {
  thread: T;
  /** 行の題名(ノートがあればノートの題名)。 */
  title: string;
  /**
   * 行右端の状態文字。`待機中` はノート語彙の外にある(登録簿に載らないスレの機械状態から導く。
   * ノート語彙を増やすと、ノートの frontmatter 側にまで語彙が漏れるため別扱いにする)。
   */
  statusLabel: NoteStatus | "待機中";
  /** この行に対応する実装ノート(無ければ null)。 */
  note: SidebarNote | null;
}

const isUpperStatus = (s: NoteStatus) => UPPER_TIER_STATUSES.includes(s);

/** ノートの無い行の状態文字(スレ側の語彙をノート語彙へ寄せる)。 */
function labelOfThreadStatus(status: ThreadStatusHint): NoteStatus | "待機中" {
  switch (status) {
    case "実装中":
      return "実装中";
    case "ユーザー判断待ち":
    case "承認待ち":
      return "判断待ち";
    case "待機中":
      return "待機中";
    default:
      return "完了";
  }
}

/** ノートが無い行を上段に出すか(`完了` だけ外す。待機中も一覧には残す)。 */
function keepsWithoutNote(status: ThreadStatusHint): boolean {
  return status !== "完了";
}

/**
 * 司令塔スレと、司令塔の子スレを寄せる「司令塔」グループの id 集合。
 * 集合の作り元は**全スレ**(`threads`)でなければならない。画面に出ている行だけから作ると、
 * 上段から外れている司令塔の子スレが「司令塔」グループから漏れ、司令塔の見出しが本人の題名の
 * グループとして開く(並べ替え側は全スレから作るため、描画とキーがずれる。出口レビュー round3 指摘3)。
 */
export function coordinatorIdSet(
  threads: readonly { agentId: string; coordinator?: boolean }[],
): Set<string> {
  return new Set(threads.filter((t) => t.coordinator === true).map((t) => t.agentId));
}

/**
 * 画面上のグループのキー。司令塔の行そのものと、司令塔の子スレは1つの「司令塔」グループへ寄せる
 * (司令塔ごとに見出しを分けない)。並べ替えの当たり判定もこの関数を使い、グループの割り方と揃える。
 * 「司令塔」の値は `sidebar-section-mode.ts` が持つ(見出しの押下の通しテストと共有)。
 */
export function visibleGroupKeyOf(
  t: { agentId: string; parentAgentId: string | null; coordinator?: boolean },
  coordinatorIds: ReadonlySet<string>,
  coordinatorGroup: string,
): string {
  const underCoordinator =
    t.coordinator === true || (t.parentAgentId !== null && coordinatorIds.has(t.parentAgentId));
  return underCoordinator ? coordinatorGroup : (t.parentAgentId ?? "");
}

/** グループ見出しを押したときの動作。 */
export type GroupPress = "open" | "toggle";

/**
 * 見出しで開ける親スレの id(`parentOpenable` を立てた行の `parentAgentId`)。
 *
 * 親は**行として出ない**ことが多い(グループ見出しだけになる)。`parentOpenable` は子の行に付くので、
 * ここで親の id を集めないと、見出しのキー(=親の id)と突き合わせられない
 * (出口レビュー round1 指摘1: `agentId` を集める実装では症状が残っていた)。
 * `coordinator: true` の行は足さない — 画面上は必ず「司令塔」グループ(開閉のみ)へ寄るので、
 * ここへ入れても見出しの判定には届かない(`visibleGroupKeyOf`)。
 */
export function openableParentIds(
  rows: readonly { parentAgentId: string | null; parentOpenable?: boolean }[],
): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.parentOpenable === true && r.parentAgentId !== null) ids.add(r.parentAgentId);
  }
  return ids;
}

/**
 * グループ見出しの押下で、その親スレを開くか、開閉だけにするか。
 *
 * - 「その他」(`key === ""`)は開く先が無いので開閉。
 * - 「司令塔」グループ(`coordinatorGroup`)は複数の司令塔が混ざるので、従来どおり開閉だけ。
 * - 生きた親(`openableParents` にある id)だけ開く。一覧に居ない/アーカイブ済みの親は開閉だけ
 *   (押しても会話に着かない画面へ落とさない)。
 *
 * 開閉は見出しのシェブロンが別に担うので、ここが `toggle` でも開閉できなくならない。
 */
export function groupPressAction(
  key: string,
  openableParents: ReadonlySet<string>,
  coordinatorGroup: string,
): GroupPress {
  if (!key || key === coordinatorGroup || !openableParents.has(key)) return "toggle";
  return "open";
}

/**
 * 上段の行を作る。ノートの無いスレは `完了` 以外を残す(`keepsWithoutNote`)。
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
    if (!keepsWithoutNote(t.status)) continue;
    rows.push({
      thread: t,
      title: t.title,
      statusLabel: labelOfThreadStatus(t.status),
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
