import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import {
  EXPLORER_SIDEBAR_PANE_ID,
  collectAllPanes,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-actions";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";

export interface OpenAgentRightPlan {
  workspaceId: string;
  workspaceKey: string;
  /** 右カラムにしたペイン。`null` はまだ右側が無く、`ensureSidePane` で作る場合。 */
  paneId: string | null;
}

export interface OpenAgentRightDeps {
  readAgentWorkspaceId: (input: { serverId: string; agentId: string }) => string | null;
  resolveWorkspaceMapKey: (input: { serverId: string; workspaceId: string }) => string | null;
  readLayout: (workspaceKey: string) => WorkspaceLayout | null;
  /** 保存済みのエクスプローラID。未記録なら既定のエクスプローラIDに倒す。 */
  readExplorerSidebarPaneId: (workspaceKey: string) => string | null | undefined;
  readSidePaneId: (workspaceKey: string) => string | null | undefined;
  /** 右カラムに開けなかった理由の記録先。既定では何も記録しない(純関数のまま保つ)。 */
  reportUnavailable?: (reason: OpenAgentRightUnavailableReason) => void;
}

/**
 * 右カラムに開けなかった理由。実画面で「押しても何も起きない」を追えるように、
 * 黙って false を返す枝を名前で残す(2026-10-27 本番で開かなかった原因の切り分け用)。
 */
export type OpenAgentRightUnavailableReason =
  | "agent-workspace-unknown"
  | "workspace-key-unavailable"
  | "layout-not-loaded"
  | "side-pane-unavailable";

/**
 * 右端のペイン。左右の区別は水平分割でしか付かないので、一番上の分割が縦なら
 * `null`(=右カラムはまだ無い)。水平分割の右側がさらに縦に積まれている場合は、
 * その中の先頭のペインを返す(どの段も x 座標は同じ)。
 *
 * 一番左の子は見ない。そこまで右へ戻るのは「画面のほぼ全部が隠れていて、
 * 残っているのが元のメインペインだけ」という場合で、そこへ開くと押した人の
 * 作業中のペインを置き換えてしまう。そのときは `null` を返して右カラムを作らせる。
 */
function rightmostPaneId(node: SplitNode, excludePaneId: string): string | null {
  if (node.kind === "pane") return visiblePaneId(node.pane, excludePaneId);
  // 一番上が横並びでなければ「最も右」という単位が無い(上下のペインは同じ x)。
  if (node.group.direction !== "horizontal") return null;
  const { children } = node.group;
  for (let i = children.length - 1; i >= 1; i -= 1) {
    const child = children[i];
    const found = child ? deepestRightPaneId(child, excludePaneId) : null;
    if (found) return found;
  }
  return null;
}

/**
 * 右側の子の中で、いちばん右にある可視ペイン。右側が縦積みなら先頭(=一番上)、
 * 横積みなら末尾(=一番右)。同じ向きの入れ子は本来作られないが、保存された
 * レイアウトに残っていても右端を取り違えないよう向きで辿る。
 */
function deepestRightPaneId(node: SplitNode, excludePaneId: string): string | null {
  if (node.kind === "pane") return visiblePaneId(node.pane, excludePaneId);
  const { children, direction } = node.group;
  if (direction === "horizontal") {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      const found = child ? deepestRightPaneId(child, excludePaneId) : null;
      if (found) return found;
    }
    return null;
  }
  for (const child of children) {
    const found = deepestRightPaneId(child, excludePaneId);
    if (found) return found;
  }
  return null;
}

function visiblePaneId(pane: SplitPane, excludePaneId: string): string | null {
  return pane.hidden === true || pane.id === excludePaneId ? null : pane.id;
}

let warnedBeforeHydration = false;
/** 同じ理由の警告でログを埋めない(読み込み直すまで1回ずつ)。 */
const warnedReasons = new Set<OpenAgentRightUnavailableReason>();

function reportUnavailable(reason: OpenAgentRightUnavailableReason): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(`[Plugins] Right column unavailable: ${reason}`);
}

/**
 * エージェントを右カラムで開くときの置き場所を決める。2026-10-25、確認箱の「スレを開く」用。
 *
 * 優先順は「以前サイドペインとして開いたペイン → 右端のペイン」。どちらも無ければ `paneId: null`
 * を返し、呼び出し側が右カラムを新しく作る。スレがすでに左のペインで開いていても右へ移すのは、
 * 押した人の期待が「右に出る」ことだから(元実装と同じ挙動)。
 */
export function planOpenAgentInRightColumn(
  input: { serverId: string; agentId: string },
  deps: OpenAgentRightDeps,
): OpenAgentRightPlan | null {
  const rawWorkspaceId = normalizeWorkspaceOpaqueId(deps.readAgentWorkspaceId(input));
  if (!rawWorkspaceId) {
    deps.reportUnavailable?.("agent-workspace-unknown");
    return null;
  }
  // 一覧(`sessions[serverId].workspaces`)に無いと引けないが、保存キーも遷移先も生のIDで足りる
  // (通常の遷移 `navigateToWorkspace` も同じIDをそのまま使う)。一覧が古い/未取得でも
  // 右カラムを諦めないよう、引けないときは生のIDへ落とす。
  const workspaceId =
    deps.resolveWorkspaceMapKey({ serverId: input.serverId, workspaceId: rawWorkspaceId }) ??
    rawWorkspaceId;

  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId: input.serverId, workspaceId });
  if (!workspaceKey) {
    deps.reportUnavailable?.("workspace-key-unavailable");
    return null;
  }

  const layout = deps.readLayout(workspaceKey);
  if (!layout) return { workspaceId, workspaceKey, paneId: null };

  // 未記録は「エクスプローラ無し」ではなく既定ID。後者は非表示でも `panes` から外れないため、
  // ここで除外しないとホバー表示したエクスプローラが右端と誤認される。
  const explorerPaneId = deps.readExplorerSidebarPaneId(workspaceKey) ?? EXPLORER_SIDEBAR_PANE_ID;
  const sidePaneId = deps.readSidePaneId(workspaceKey) ?? null;
  // 隠れているペインは数に入れない。右側が全部隠れているだけなのを「右側がある」と
  // 誤認して左のペインへ開くと、押した人の作業中のペインが置き換わる。
  const panes = collectAllPanes(layout.root).filter(
    (pane) => pane.id !== explorerPaneId && pane.hidden !== true,
  );

  // 隠れているペイン(旧エクスプローラ等)は使い回さない。右端の判定と同じ扱いに揃える。
  if (sidePaneId && panes.some((pane) => pane.id === sidePaneId && pane.hidden !== true)) {
    return { workspaceId, workspaceKey, paneId: sidePaneId };
  }
  // ペインが1枚(エクスプローラを除く)なら右側がまだ無い。そのときは呼び出し側に作らせる。
  if (panes.length < 2) return { workspaceId, workspaceKey, paneId: null };
  return {
    workspaceId,
    workspaceKey,
    paneId: rightmostPaneId(layout.root, explorerPaneId),
  };
}

/**
 * エージェントをワークスペースの右カラムで開く。開けない(エージェントやワークスペースが
 * わからない・右カラムを作れない)ときは `false` を返し、呼び出し側が通常遷移へ落とす。
 */
export function openAgentInRightColumn(input: { serverId: string; agentId: string }): boolean {
  // 未読み込みだと `navigateToWorkspace` が配置を捨てて通常遷移に落ちる。ここで書き込むと
  // 空の右カラムだけが残るので、先に false を返して呼び出し側の通常遷移に任せる。
  if (!useWorkspaceLayoutStore.persist.hasHydrated()) {
    // 読み込みが失敗したまま戻らないと右カラムが黙って効かなくなるので、一度だけ記録する。
    if (!warnedBeforeHydration) {
      warnedBeforeHydration = true;
      console.warn("[Plugins] Layout not loaded yet; opening agents without the right column");
      reportUnavailable("layout-not-loaded");
    }
    return false;
  }
  const sessions = useSessionStore.getState().sessions;
  const store = useWorkspaceLayoutStore.getState();
  const plan = planOpenAgentInRightColumn(input, {
    readAgentWorkspaceId: ({ serverId, agentId }) => {
      const session = sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return agent?.workspaceId ?? null;
    },
    resolveWorkspaceMapKey: ({ serverId, workspaceId }) =>
      resolveWorkspaceMapKeyByIdentity({
        workspaces: sessions[serverId]?.workspaces,
        workspaceId,
      }),
    readLayout: (workspaceKey) => store.layoutByWorkspace[workspaceKey] ?? null,
    readExplorerSidebarPaneId: (workspaceKey) =>
      store.explorerSidebarPaneIdByWorkspace[workspaceKey],
    readSidePaneId: (workspaceKey) => store.sidePaneIdByWorkspace[workspaceKey],
    reportUnavailable,
  });
  if (!plan) return false;

  const paneId = plan.paneId ?? store.ensureSidePane(plan.workspaceKey);
  if (!paneId) {
    reportUnavailable("side-pane-unavailable");
    return false;
  }

  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: plan.workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    placement: { mode: "pane", paneId },
  });
  return true;
}
