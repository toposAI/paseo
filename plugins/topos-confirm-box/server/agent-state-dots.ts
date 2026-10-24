/**
 * 一覧の**すべての行**(登録簿の行・司令塔の行・未登録の行)へ、左端の点の種類を付ける。
 *
 * なぜサーバーで決めるか: 行の材料のうち `machineState`(登録簿の `status`)だけでは
 * **承認待ちで止まっているスレ**が見つけられない。承認待ちの間 Paseo の `status` は `running` の
 * ままで、止まっていることは `pendingPermissions` と `attentionReason === "permission"` にしか
 * 出ない(`packages/protocol/src/agent-state-bucket.ts`)。その2つは `agents.list()` の実時間の値に
 * しか無いので、一覧を作るこの時点で点まで決め、行には種類(語彙)だけを載せる。
 *
 * 規則:
 * - 一覧に居ないスレ(範囲外・取得できなかった)は **null**(点を出さない)。分からないものを
 *   `done` に倒すと「止まっていない」と読めてしまうため。
 * - アーカイブ済みのスレ(`archivedAt`)は点を出さない(見に行く先が無い。completed の灰点だけ
 *   残すと、行末尾の帯と役割が重なる)。
 * - 判定そのものは `shared/state-dot.ts` の `deriveStateDot`(純正と同じ順序)。ここは写さない。
 */
import type { ChildThread } from "../shared/child-threads.js";
import type { StateDotKind } from "../shared/state-dot.js";
import { stateDotOf } from "./unregistered-threads.js";
import type { ListedAgentLike } from "./unregistered-threads.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** スレの id → 点の種類。アーカイブ済み・id の無い要素は入れない(不明=null)。 */
export function stateDotsById(agents: readonly ListedAgentLike[]): Map<string, StateDotKind> {
  const out = new Map<string, StateDotKind>();
  for (const a of agents) {
    const id = str(a.id);
    if (!id || a.archivedAt != null) continue;
    out.set(id, stateDotOf(a));
  }
  return out;
}

/** 行へ点を付ける(判定に無い行は null=不明)。 */
export function applyStateDots(
  rows: readonly ChildThread[],
  dots: ReadonlyMap<string, StateDotKind>,
): ChildThread[] {
  return rows.map((t) => {
    const next = dots.get(t.agentId) ?? null;
    return t.stateDot === next ? t : { ...t, stateDot: next };
  });
}
