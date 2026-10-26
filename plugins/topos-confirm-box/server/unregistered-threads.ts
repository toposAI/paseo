/**
 * 登録簿(`child_threads.json`)に載っていない**人が Paseo から直接建てたスレ**を一覧の行に足す。
 *
 * なぜ要るか(2026-10-24 ユーザー報告「Paseoの新しいワークスペースボタンから追加したスレも
 * サイドバーにでない」): サイドバーの行は登録簿に載っているスレ(=司令塔が建てた子スレ)からしか
 * 作られていなかった。`agents.list()` は取っていたが、印付け・親子の寄せ・開けるかの判定にしか
 * 使っていなかった。
 *
 * 足すときの規則:
 * - 登録簿の行・司令塔(`coordinatorIds`)・既に足した行と同じ id は足さない(二重にしない)。
 * - Paseo の**内部スレ**(タイトル生成など `internal: true` の使い捨て、一覧から隠す `hidden`)は足さない。
 * - **アーカイブ済みのスレは足さない**(終えたスレが溜まらないように。既定の一覧はアーカイブ済みを
 *   返さないが、念のためここでも弾く)。
 * - 題名の無いスレは足さない(行が `id.slice(0,8)` だけになる)。Paseo は最初のメッセージで
 *   仮題名を付ける(`session.ts` の `prepareAgentMessage`)ので、実用上は数秒で埋まる。
 * - 状態文字は**機械状態から導く**(`machineState` だけを持つ登録簿の行と違い、正になる自己申告が無い)。
 *   一律「実装中」にすると、アイドルや承認待ちのスレまで「実装中」の帯で並び、動いているように
 *   見える(出口レビュー round1 指摘2)。`status` は上段の絞り込みにだけ効く語彙へ写す。
 * - **ピン止めは保存値を反映する**(`pinnedIds`)。反映しないと、メニューでピン止めしても次の取得で
 *   黙って外れて見える(保存自体は成功しているので巻き戻しの通知も出ない。出口レビュー round1 指摘3)。
 * - 並びは既定順の後ろ(`applyChildThreadOrder` が保存に無いIDを後ろに置く既存挙動)。
 *   登録簿へは**書き戻さない**(この経路は読むだけ)。
 * - 開けるか(`access`)はここでは付けない(未判定の null)。呼び出し元が `threadAccessById` で
 *   既存の印を付ける。ワークスペースが引けないスレは行から消さず、印の側で示す。
 */
import type { ChildThread } from "../shared/child-threads.js";
import { compareChildThreads } from "../shared/child-threads.js";
import { deriveStateDot, statusWithDot } from "../shared/state-dot.js";
import type { StateDotKind } from "../shared/state-dot.js";
import { statusKindOfMachine } from "../shared/thread-status-label.js";

/** `ctx.paseo.agents.list()` の要素(読む所だけ緩く持つ)。 */
export interface ListedAgentLike {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  archivedAt?: unknown;
  internal?: unknown;
  hidden?: unknown;
  /** 未読の結果があるか(純正サイドバーの点の材料)。 */
  requiresAttention?: unknown;
  /** 注意の理由。`permission` が「承認待ち」。 */
  attentionReason?: unknown;
  /** 承認待ち(permission)の配列。長さが件数。 */
  pendingPermissions?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * `updatedAt` をミリ秒へ。契約(`packages/plugin/src/contracts.ts` の `AgentSnapshot` は
 * `updatedAt: string`)は **ISO 8601 の文字列**なので、数値だけ採ると未登録スレが全部 0 になり
 * id 順に並ぶ(2026-10-27 通し検証B 指摘5)。数値はそのまま(既存の入力とテスト)。
 * 壊れた値は 0(落ちない)。
 */
export function timestampOf(v: unknown): number {
  // 契約は ISO 文字列。数値も受けるが、秒(1e12 未満)とミリ秒が混ざると並びが逆転するので秒は ms へ揃える
  // (出口レビュー round1 R1-10)。タイムゾーンの無い文字列は `Date.parse` の地方時解釈に任せる(並び順だけに使う)。
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v < 1e12 ? Math.round(v * 1000) : v;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** 一覧の1件から、行の左端の点の種類を決める(`shared/state-dot.ts` の判定をそのまま使う)。 */
export function stateDotOf(a: ListedAgentLike): StateDotKind {
  const pending = Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : 0;
  const reason = str(a.attentionReason);
  return deriveStateDot({
    machineState: str(a.status) || null,
    requiresAttention: a.requiresAttention === true,
    attentionReason: reason || null,
    pendingPermissionCount: pending,
  });
}

/**
 * 機械状態 → 上段の語彙。**動いているものだけ `実装中`**にし、承認待ちは `ユーザー判断待ち`
 * (表示は「判断待ち」)、それ以外(idle・closed 等)は `待機中`。規則は
 * `shared/thread-status-label.ts` の `statusKindOfMachine` が正で、ここはそれを使うだけ。
 */
function machineHint(machineState: string | null): ChildThread["status"] {
  // **写しは1か所**(`statusKindOfMachine`)。以前は同じ規則をここへ二重に書いていて、
  // `closed` の扱いが帯と食い違った(出口レビュー round2 指摘2)。
  switch (statusKindOfMachine(machineState)) {
    case "running":
      return "実装中";
    case "waiting":
      return "ユーザー判断待ち";
    default:
      // `closed` も `idle` も「動いていない」として行は残す(閉じただけの未アーカイブのスレを
      // 一覧から消すと、元の「出ない」症状と見分けが付かない)。
      return "待機中";
  }
}

/** 承認待ちは機械状態では `running` のままなので、点(同じ材料で決めたもの)で上書きする。 */
function statusHintOfMachine(
  machineState: string | null,
  dot: StateDotKind,
): ChildThread["status"] {
  return statusWithDot(machineHint(machineState), dot);
}

/** 一覧に足さなかったスレの理由(テストと報告のための語彙)。 */
export type SkippedReason =
  | "listed"
  | "coordinator"
  | "internal"
  | "archived"
  | "untitled"
  | "duplicate"
  /** 子の見出しになっている親(`groupingParent`)。行として足さない(2026-10-27 指摘1)。 */
  | "parent"
  /** 登録簿で畳み済み(archived)なのに Paseo 側に残っている(アーカイブ失敗の再試行待ち。指摘4)。 */
  | "archivedRegistry"
  /** 登録簿に載っている(行に出ていなくても未登録ではない。2026-10-27 実測: `12b4eab`)。 */
  | "inRegistry";

export interface UnregisteredThreads {
  /** 登録簿の行の後ろに、未登録のスレを足したもの(登録簿の行自体は変えない)。 */
  rows: ChildThread[];
  /** 足さなかったスレの件数(理由別)。 */
  skipped: Record<SkippedReason, number>;
}

/**
 * 登録簿の行(`rows`)に無いスレを、Paseo の一覧(`agents`)から行として足す。
 * 足した行は並び替えずに後ろへ置く(既定順そのまま。グループ分けは画面側が行う)。
 */
export function mergeUnregisteredThreads(
  rows: readonly ChildThread[],
  agents: readonly ListedAgentLike[],
  coordinatorIds: Iterable<string> = [],
  /** ピン止め済みの agent id(保存値。`readChildThreadPins` の結果)。 */
  pinnedIds: ReadonlySet<string> = new Set(),
  /**
   * 登録簿で畳み済み(`archived`)なのに Paseo の一覧に残っている agent id
   * (`retryListedArchivedIds`。アーカイブ失敗の再試行前に、行として復活させない)。
   */
  registryArchivedIds: ReadonlySet<string> = new Set(),
  /**
   * 登録簿に載っている agent id の**全部**(畳み済み・子の見出しになった親も含む。`readKnownChildThreadIds`)。
   * ここに入っているスレは「未登録」ではないので、行に無くても足さない(2026-10-27 実測: `12b4eab`)。
   */
  registryKnownIds: ReadonlySet<string> = new Set(),
): UnregisteredThreads {
  const listed = new Set(rows.map((t) => t.agentId));
  const coordinators = new Set(coordinatorIds);
  // 子の見出しになっている親は「行に無い」が未登録ではない(登録簿に載っている。2026-10-27 指摘1)。
  // ピン止めした親は見出しではなく普通の行として返る(`server/child-threads.ts`)ので、行に無ければ
  // **未登録として足す**(足さないとピン止めが一覧から消える。出口レビュー round1 R1-6)。
  const pinnedParentIds = new Set(pinnedIds);
  const parents = new Set(
    rows
      .map((t) => t.parentAgentId)
      .filter((id): id is string => id !== null && !pinnedParentIds.has(id)),
  );
  const skipped: Record<SkippedReason, number> = {
    listed: 0,
    coordinator: 0,
    internal: 0,
    archived: 0,
    untitled: 0,
    duplicate: 0,
    parent: 0,
    archivedRegistry: 0,
    inRegistry: 0,
  };
  const added: ChildThread[] = [];
  const seen = new Set<string>(listed);
  for (const a of agents) {
    const agentId = str(a.id).slice(0, 200);
    if (!agentId) continue;
    if (listed.has(agentId)) {
      skipped.listed += 1;
      continue;
    }
    if (coordinators.has(agentId)) {
      skipped.coordinator += 1;
      continue;
    }
    if (parents.has(agentId)) {
      skipped.parent += 1;
      continue;
    }
    if (registryArchivedIds.has(agentId)) {
      skipped.archivedRegistry += 1;
      continue;
    }
    // 登録簿に載っているスレは、行に出ていなくても「未登録の新しいスレ」ではない(2026-10-27 実測の
    // `12b4eab`「判断窓口スレ2本を作る」: 本人は `[STATUS] 完了`・台帳も完了・自身はアーカイブ済みだが、
    // 直下の常駐の子(窓口B・判断窓口A)が未アーカイブなので親として読み飛ばされ、Paseo 側は idle のまま
    // 残っているため、機械状態だけで「待機中」の行が足されていた。完了の自己申告を失い、直す手段も無い)。
    if (registryKnownIds.has(agentId)) {
      skipped.inRegistry += 1;
      continue;
    }
    if (seen.has(agentId)) {
      skipped.duplicate += 1;
      continue;
    }
    if (a.internal === true || a.hidden === true) {
      skipped.internal += 1;
      continue;
    }
    if (a.archivedAt != null) {
      skipped.archived += 1;
      continue;
    }
    const title = str(a.title).trim();
    if (!title) {
      skipped.untitled += 1;
      continue;
    }
    seen.add(agentId);
    const machineState = str(a.status).slice(0, 40) || null;
    const stateDot = stateDotOf(a);
    added.push({
      agentId,
      title: title.slice(0, 120),
      // 登録簿の行と違い、正になる自己申告が無い。機械状態を語彙へ写して上段の絞り込みに渡す
      // (`buildUpperRows` が `待機中` を「動いていない」として扱う)。
      status: statusHintOfMachine(machineState, stateDot),
      machineState,
      stateDot,
      request: "",
      summaryItemId: null,
      nocard: false,
      summary: null,
      summaryState: null,
      summaryAcked: false,
      updatedAt: timestampOf(a.updatedAt),
      parentAgentId: null,
      parentTitle: null,
      pinned: pinnedIds.has(agentId),
      coordinator: false,
      parentOpenable: false,
      // 開けるかは `thread-liveness.ts` が後で付ける(ここでは未判定)。
      access: null,
    });
  }
  added.sort((a, b) => compareChildThreads(a, b) || a.agentId.localeCompare(b.agentId));
  return { rows: [...rows, ...added], skipped };
}
