/**
 * サイドバー二段の**上段**(実装ノートの status で子スレ行を絞り込む)の純粋関数。
 *
 * - ノートの status が正(標準_サイドバーの表示ルール)。子スレ一覧の status(=古い語彙)は
 *   ノートが無いスレにだけ使う。
 * - 上段に出すのは status が 実装中/判断待ち/確認待ち(旧語彙・移行中) の行(ノートがあるスレ)、または
 *   ノートが無く子スレ一覧でも `完了` 以外の行(実装中/ユーザー判断待ち/承認待ち/待機中)。
 *   ノートがあるのに `完了` のスレは上段から外す。2026-10-26 に完了の「確認待ち」表示は廃止した
 *   (完了はユーザー確認を待たずに畳まれる)。
 * - 行の題名と状態文字はノート側を優先する(スレ側は古いことがあるため)。
 */
import { LOWER_TIER_STATUSES, UPPER_TIER_STATUSES } from "./notes.js";
import type { NoteStatus, SidebarNote } from "./notes.js";
import type { StateDotKind } from "./state-dot.js";
import { rowStatusText } from "./thread-status-label.js";

/**
 * 子スレ一覧側の status。登録簿の行は `shared/child-threads.ts` の3語彙、登録簿に載らない
 * (Paseo から直接建てた)スレは機械状態から導く2語彙(`server/unregistered-threads.ts`)を使う。
 * `待機中`/`承認待ち` も上段に出す(消すと「出ない」症状と見分けが付かない。動いていないことは
 * 状態の帯の色で示す(構想タブより前の版のレビュー round1 指摘2)。
 */
export type ThreadStatusHint = "実装中" | "ユーザー判断待ち" | "完了" | "承認待ち" | "待機中";

export interface RowThread {
  agentId: string;
  title: string;
  status: ThreadStatusHint;
  /** 司令塔の行か(点を出す条件が子スレと違う。`shouldShowDot`)。未指定は司令塔でない。 */
  coordinator?: boolean;
  /**
   * 行の左端の点の種類(純正 Paseo の点と同じ意味)。サーバーが実時間の値から決めて載せる。
   * 無い/分からない行は null(点を出さない)。意味は status と別の軸(いまどう見えているか)。
   */
  stateDot?: StateDotKind | null;
  /**
   * 完了まとめを個別に確認済みか(`ChildThread.summaryAcked`)。2026-10-26 に「完了待ち」の判定を
   * 廃止したので表示には使わない(データ形は互換のため残す)。
   */
  summaryAcked?: boolean;
  /** 完了まとめのカードを作らない運用の行か(`ChildThread.nocard`)。表示の判定には使わない。 */
  nocard?: boolean;
  /**
   * 子を持つ親(子司令塔)の行か。この行は子の行の**グループ見出し**になる(`ChildThread.groupingParent`)。
   * 上段に出すのは子の行より後ろ(見出しとして)で、子の行は「自分の見出しの先頭」に来る。
   */
  groupingParent?: boolean;
  /** Paseo の機械状態(行末の「終了」の判定に使う。閉じたスレの「実装中」を出さない)。 */
  machineState?: string | null;
}

export interface SidebarRowView<T> {
  thread: T;
  /** 行の題名(ノートがあればノートの題名)。 */
  title: string;
  /**
   * 行右端の状態文字。`待機中` はノート語彙の外にある(登録簿に載らないスレの機械状態から導く。
   * ノート語彙を増やすと、ノートの frontmatter 側にまで語彙が漏れるため別扱いにする)。
   */
  statusLabel: NoteStatus | "待機中" | "終了";
  /** この行に対応する実装ノート(無ければ null)。 */
  note: SidebarNote | null;
  /**
   * 登録簿(スレ側)の状態と実装ノートの状態が食い違う行の、両方の表示語(2026-10-27、通し検証B 指摘6・
   * 判断12a)。`note` はノートの語彙・`registry` はスレ側の語彙(ノートが引けないときは null)。
   * **表示はノート(正)のまま変えない**。食い違いは別の項目で添えるだけ(黙って片方に寄せない)。
   * 遡りノート(`zone: "later"`。整理のための参照用)は食い違いに数えない。
   */
  conflict: { note: NoteStatus; registry: NoteStatus | "待機中" | null } | null;
  /**
   * 行の左端の点の種類(純正 Paseo と同じ意味。`shared/state-dot.ts`)。
   * 材料が無い行は null(点を出さない)。
   */
  dot: StateDotKind | null;
}

/**
 * 行の左端に点を出すか。
 *
 * - **子スレ行(司令塔グループ内を含む)はすべて出す**。ユーザーの目的は「どのスレが承認待ちで
 *   止まっているかを一覧で見つける」ことで、点が無い行が混ざると「点が無い=止まっていない」と
 *   読めてしまう(見つけ損なう側に倒れる)。
 * - **司令塔の行そのものは、承認待ち/失敗のときだけ出す**。司令塔は常に一覧の先頭グループに並ぶので、
 *   全部に灰色の点を置くと点の列が「意味の無い飾り」に見え、オレンジの見落としにつながる。
 */
export function shouldShowDot(thread: RowThread): boolean {
  const kind = thread.stateDot ?? null;
  if (kind === null) return false;
  if (thread.coordinator !== true) return true;
  return kind === "needs_input" || kind === "failed";
}

/** 行の左端に出す点の種類(出さない行は null)。 */
export function dotOf(thread: RowThread): StateDotKind | null {
  return shouldShowDot(thread) ? (thread.stateDot ?? null) : null;
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
  t: { agentId: string; parentAgentId?: string | null; coordinator?: boolean },
  coordinatorIds: ReadonlySet<string>,
  coordinatorGroup: string,
): string {
  const parent = t.parentAgentId ?? null;
  const underCoordinator =
    t.coordinator === true || (parent !== null && coordinatorIds.has(parent));
  return underCoordinator ? coordinatorGroup : (parent ?? "");
}

/**
 * 画面と並べ替えの両方が使う**グループの割り方の唯一の定義**。ピン止めした子スレは、所属する
 * グループ(司令塔を含む)から外して「ピン止め」グループへ寄せる(2026-10-25 ユーザー指示。
 * 司令塔の外に出す)。司令塔の行は元々司令塔グループに出るのでピン止めの対象外にする。
 * `groupRows`(描画)・`onReorderGroup`・挿入時の整列がすべてこれを通す。
 */
export function rowGroupKeyOf(
  t: { agentId: string; parentAgentId?: string | null; coordinator?: boolean; pinned?: boolean },
  coordinatorIds: ReadonlySet<string>,
  coordinatorGroup: string,
  pinnedGroup: string,
): string {
  if (t.pinned === true && t.coordinator !== true) return pinnedGroup;
  return visibleGroupKeyOf(t, coordinatorIds, coordinatorGroup);
}

/** グループ割りに要る行の項目(画面の行と、テストの緩い行の両方を受ける)。 */
export interface GroupableThread {
  agentId: string;
  parentAgentId?: string | null;
  parentTitle?: string | null;
  machineState?: string | null;
  coordinator?: boolean;
  pinned?: boolean;
}

/** 画面に出す1グループ(見出し + 行)。 */
export interface ThreadGroup<T> {
  key: string;
  title: string;
  rows: SidebarRowView<T>[];
  /**
   * 見出しの状態(子の親 = 子司令塔の行。`groupingParent`)。見出しの件数の隣に出す。
   * 親の行が上段に無い(完了・ノート違い)ときは null(見出しは題名だけ)。
   */
  heading: SidebarRowView<T> | null;
}

/**
 * サーバーの並び(グループ単位でまとまっている)を出現順のままグループへ割る。
 *
 * - 行のキーは `rowGroupKeyOf`(1か所の定義)。並べ替えの当たり判定と同じキーになる。
 * - `groupingParent` の行(子司令塔)は**行として並べず**、自分の id のグループの見出しにする
 *   (2026-10-27、通し検証B 指摘1)。子の行が上段に居ないグループは見出しだけ残らないので、
 *   その行は普通の行として出す(判断待ちの見落としを作らない)。
 * - ピン止め → 司令塔 → その他(出現順)。空のグループは出さない。
 */
export function groupThreadRows<T extends GroupableThread>(
  rows: readonly SidebarRowView<T>[],
  coordinatorIds: ReadonlySet<string>,
  coordinatorGroup: string,
  pinnedGroup: string,
  pinnedLabel: string,
  otherLabel: string,
): ThreadGroup<T>[] {
  const groups = new Map<string, ThreadGroup<T>>();
  const fixedTitle = (key: string): string => {
    if (key === coordinatorGroup) return "司令塔";
    if (key === pinnedGroup) return pinnedLabel;
    return "";
  };
  const ensure = (key: string, title: string): ThreadGroup<T> => {
    let g = groups.get(key);
    if (!g) {
      g = { key, title: fixedTitle(key) || title, rows: [], heading: null };
      groups.set(key, g);
    }
    return g;
  };
  const headings: SidebarRowView<T>[] = [];
  for (const r of rows) {
    // ピン止めした親は見出しにしない(ピン止めグループの普通の行として出す。R1-6)。
    if (
      (r.thread as { groupingParent?: boolean }).groupingParent === true &&
      (r.thread as { pinned?: boolean }).pinned !== true
    ) {
      headings.push(r);
      continue;
    }
    const key = rowGroupKeyOf(r.thread, coordinatorIds, coordinatorGroup, pinnedGroup);
    ensure(key, r.thread.parentTitle || otherLabel).rows.push(r);
  }
  // 親は「自分の id のグループ(子の行の見出し)」があればその見出しになる。無ければ普通の行。
  for (const h of headings) {
    const own = groups.get(h.thread.agentId);
    if (own) {
      own.heading = h;
      continue;
    }
    const key = rowGroupKeyOf(h.thread, coordinatorIds, coordinatorGroup, pinnedGroup);
    ensure(key, h.thread.parentTitle || otherLabel).rows.push(h);
  }
  const ordered: ThreadGroup<T>[] = [];
  for (const key of [pinnedGroup, coordinatorGroup]) {
    const g = groups.get(key);
    if (g) ordered.push(g);
  }
  for (const g of groups.values()) {
    if (g.key !== pinnedGroup && g.key !== coordinatorGroup) ordered.push(g);
  }
  return ordered.filter((g) => g.rows.length > 0 || g.heading !== null);
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
 * 並べ替えの置換先になる行の id。**グループの行**だけで、見出しになる行は除く
 * (見出しはグループの行ではないので、置換先にすると1つずれて隣の id が書き戻される。
 * 出口レビュー round1 R1-4)。
 *
 * 判定は `groupThreadRows` の**出力そのもの**から作る。行の条件を別に書き写すと、子が上段に無くて
 * 見出しにならなかった親(普通の行として出る)まで外れて並びがずれる(出口レビュー round2 R2-1)。
 */
export function reorderableIds<T extends GroupableThread>(
  groups: readonly ThreadGroup<T>[],
): Set<string> {
  return new Set(groups.flatMap((g) => g.rows.map((r) => r.thread.agentId)));
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
    const dot = dotOf(t);
    const registryLabel = labelOfThreadStatus(t.status);
    // 登録簿とノートの食い違い(12a)。遡りノート(参照用)は対象外。
    const conflict =
      note && note.zone !== "later" && note.status !== registryLabel
        ? { note: note.status, registry: registryLabel }
        : null;
    // 2026-10-26: 「完了待ち」(ユーザーの確認待ち)は廃止した。完了は確認を待たずに畳まれるので、
    // 行はノートの status(実装中・判断待ち)か、ノートの無い行の機械状態だけで決める。
    if (note) {
      if (!isUpperStatus(note.status)) continue;
      rows.push({
        thread: t,
        title: note.title || t.title,
        // ノートが正。ただし閉じたスレの「実装中」は「終了」にする(表示の規則は1か所)
        statusLabel: rowStatusText(note.status, t.machineState).text as
          | NoteStatus
          | "待機中"
          | "終了",
        note,
        dot,
        conflict,
      });
      continue;
    }
    // グループ見出しになる親(子司令塔)は、完了でも**残す**(子の行はこの見出しの下に並ぶため。
    // 親の状態は見出しの帯に出す。2026-10-27 通し検証B 指摘1)。
    if (!keepsWithoutNote(t.status) && t.groupingParent !== true) continue;
    rows.push({
      thread: t,
      title: t.title,
      statusLabel: rowStatusText(registryLabel, t.machineState).text as
        | NoteStatus
        | "待機中"
        | "終了",
      note: null,
      dot,
      conflict: null,
    });
  }
  // 親の行は子の行より後ろへ。子の行は自分の見出しの**先頭**に来るので、`groupRows` が親の行に
  // 見出しを付けると「見出し→子の行」の順で並ぶ(親が子の間や先頭に混ざる二重表示をしない)。
  // 並びはそれ以外(pin 先頭・グループ単位の出現順)を保つ。
  const isHeading = (r: SidebarRowView<T>) =>
    (r.thread as { groupingParent?: boolean }).groupingParent === true;
  return [...rows.filter((r) => !isHeading(r)), ...rows.filter(isHeading)];
}

/** 上段の行を状態ごとに数える(一覧の上の件数チップ用。下部バーの件数とは別集計)。司令塔は実装中に含めず別に数える。 */
export function countStatusLabels(rows: readonly { statusLabel: string; thread: RowThread }[]): {
  judgment: number;
  running: number;
  coordinator: number;
  idle: number;
  /** 閉じたスレ(=「終了」と出している行)。`実装中` に混ぜない(2026-10-27、通し検証B 指摘2)。 */
  closed: number;
} {
  const c = { judgment: 0, running: 0, coordinator: 0, idle: 0, closed: 0 };
  for (const r of rows) {
    if (r.thread.coordinator === true) c.coordinator += 1;
    else if (r.statusLabel === "判断待ち") c.judgment += 1;
    else if (r.statusLabel === "実装中") c.running += 1;
    else if (r.statusLabel === "待機中") c.idle += 1;
    else if (r.statusLabel === "終了") c.closed += 1;
  }
  return c;
}

/**
 * 実装ノートをスレIDで引ける形にする(行に status・題名を重ねる材料)。
 * ノートは1スレに1枚(検収単位と1対1)なので、解決済みの threadId だけを張る。
 * 解決できない候補しか無いノートは、そのスレの行に重ねない。同じスレに複数枚あれば
 * **先頭(新しい順の最初)勝ち**。テストの写しと本番で結果がずれないよう、クライアントは
 * これだけを使う(構想タブ出口レビュー round1 指摘3)。
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
