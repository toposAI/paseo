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
 * - 題名の無いスレは足さない(行が `id.slice(0,8)` だけになる)。
 * - 状態文字は実装ノートの無いスレと同じ扱い(`buildUpperRows` に流す)にするため、`status` は
 *   「実装中」で置き、機械状態は `machineState` に入れる。
 * - 並びは既定順の後ろ(`applyChildThreadOrder` が保存に無いIDを後ろに置く既存挙動)。
 *   登録簿へは**書き戻さない**(この経路は読むだけ)。
 * - 開けるか(`access`)はここでは付けない(未判定の null)。呼び出し元が `threadAccessById` で
 *   既存の印を付ける。ワークスペースが引けないスレは行から消さず、印の側で示す。
 */
import type { ChildThread } from "../shared/child-threads.js";
import { compareChildThreads } from "../shared/child-threads.js";

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
 * 足し���行は並び替えずに後ろへ置く(既定順そのまま。グループ分けは画面側が行う)。
 */
export function mergeUnregisteredThreads(
  rows: readonly ChildThread[],
  agents: readonly ListedAgentLike[],
  coordinatorIds: Iterable<string> = [],
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
    added.push({
      agentId,
      title: title.slice(0, 120),
      // 実装ノートの無いスレと同じ扱い(状態はノート側で上書きされなければこれが出る)。
      status: "実装中",
      machineState: str(a.status).slice(0, 40) || null,
      request: "",
      summaryItemId: null,
      summary: null,
      summaryState: null,
      summaryAcked: false,
      updatedAt: typeof a.updatedAt === "number" ? a.updatedAt : 0,
      parentAgentId: null,
      parentTitle: null,
      pinned: false,
      coordinator: false,
      // 開けるかは `thread-liveness.ts` が後で付ける(ここでは未判定)。
      access: null,
    });
  }
  added.sort((a, b) => compareChildThreads(a, b) || a.agentId.localeCompare(b.agentId));
  return { rows: [...rows, ...added], skipped };
}
