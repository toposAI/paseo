/**
 * 一覧の行が「いま開けるか」の判定と、行の印付け。
 *
 * なぜ要るか(2026-10-23 ユーザー報告「サイドバーの行をタップしても開かない」): 行を押すと Paseo の
 * ホスト遷移(`navigateToAgent` → `navigateToWorkspace`)が**そのスレのワークスペース**を開く。
 * ワークスペースがアーカイブ済みだと「ワークスペースはアーカイブ済みです」の画面に落ち、会話に着かない。
 * アーカイブ済みのワークスペースを戻す手段はアプリの「アーカイブを解除」だけで、プラグインの API には無い。
 * よって行を黙って消さずに**印だけ付け**、押したときは理由を言う(画面側で判断する)。
 *
 * 判定は Paseo の一覧の2点だけを見る:
 * - そのスレの workspaceId が、生きている(アーカイブされていない)ワークスペースの一覧に在るか
 *   — `workspaces.list()` は**生きているものしか返さない**ので、在る=開ける・無い=閉じた と読む
 *   (アーカイブ済みの識別子一覧はプラグインから引けない)
 * - スレ自身がアーカイブされていないか(`agents.list({filter:{includeArchived:true}})` で見る。
 *   既定の `agents.list()` はアーカイブ済みを返さない)
 * 一覧の取得に失敗したときは**印を付けない**(unknown)。取れないことを「アーカイブ済み」と言い換えると、
 * 一時的な失敗が全行「開けません」に見えてしまう。
 */
import type { ChildThread, ThreadAccess } from "../shared/child-threads.js";

/** `ctx.paseo.agents.list()` / `ctx.paseo.workspaces.list()` の要素(読む所だけ緩く持つ)。 */
export interface LivenessAgent {
  id?: unknown;
  workspaceId?: unknown;
  archivedAt?: unknown;
}

export interface LivenessWorkspace {
  workspaceId?: unknown;
  archivedAt?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * スレの id → いま開けるか。一覧に居ないスレ(Paseo から消えた/範囲外)は印を付けない。
 * 同じ workspaceId に複数の記録があることがある(同じ cwd の複製)ので、
 * **どれか1つでも生きていれば開ける**とみなす(開く側の解決と同じ基準)。
 */
export function threadAccessById(
  agents: readonly LivenessAgent[],
  workspaces: readonly LivenessWorkspace[],
): Map<string, ThreadAccess> {
  const live = new Set<string>();
  const all = new Set<string>();
  for (const w of workspaces) {
    const id = str(w.workspaceId);
    if (!id) continue;
    all.add(id);
    if (w.archivedAt == null) live.add(id);
  }
  const out = new Map<string, ThreadAccess>();
  for (const a of agents) {
    const id = str(a.id);
    if (!id) continue;
    const archived = a.archivedAt != null;
    const workspaceId = str(a.workspaceId);
    // ワークスペースの記録が無い(=解決できない)なら、遷移側は深リンクへ落ちて同じワークスペースを
    // 引き直す。生きていると分からないので印は付けない。
    if (archived) out.set(id, "thread-archived");
    else if (workspaceId && all.has(workspaceId) && !live.has(workspaceId))
      out.set(id, "workspace-archived");
    else out.set(id, "open");
  }
  return out;
}

/** 行へ印を付ける(判定に無い行は null=不明)。 */
export function applyThreadAccess(
  rows: readonly ChildThread[],
  access: ReadonlyMap<string, ThreadAccess>,
): ChildThread[] {
  return rows.map((t) => {
    const next = access.get(t.agentId) ?? null;
    return t.access === next ? t : { ...t, access: next };
  });
}
