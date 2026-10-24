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
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 機械状態 → 上段の語彙。**動いているものだけ `実装中`**にし、承認待ちは `ユーザー判断待ち`
 * (表示は「判断待ち」)、それ以外(idle・closed 等)は `待機中`。規則は
 * `shared/thread-status-label.ts` の `statusKindOfMachine` が正で、ここはそれを使うだけ。
 */
function statusHintOfMachine(machineState: string | null): ChildThread["status"] {
  // **写しは1か所**(`statusKindOfMachine`)。以前は同じ規則をここへ二重に書いていて、
  // `closed` の扱いが帯と食い違った(出口レビュー round2 指摘2)。生の機械状態
  // (`initializing` 等)は `statusKindOfMachine` 側が吸収する(承認待ちの名前もそちら)。
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

/** 一覧に足さなかったスレの理由(テストと報告のための語彙)。 */
export type SkippedReason =
  | "listed"
  | "coordinator"
  | "internal"
  | "archived"
  | "untitled"
  | "duplicate";

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
): UnregisteredThreads {
  const listed = new Set(rows.map((t) => t.agentId));
  const coordinators = new Set(coordinatorIds);
  const skipped: Record<SkippedReason, number> = {
    listed: 0,
    coordinator: 0,
    internal: 0,
    archived: 0,
    untitled: 0,
    duplicate: 0,
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
    added.push({
      agentId,
      title: title.slice(0, 120),
      // 登録簿の行と違い、正になる自己申告が無い。機械状態を語彙へ写して上段の絞り込みに渡す
      // (`buildUpperRows` が `待機中` を「動いていない」として扱う)。
      status: statusHintOfMachine(machineState),
      machineState,
      request: "",
      summaryItemId: null,
      summary: null,
      summaryState: null,
      summaryAcked: false,
      updatedAt: typeof a.updatedAt === "number" ? a.updatedAt : 0,
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
