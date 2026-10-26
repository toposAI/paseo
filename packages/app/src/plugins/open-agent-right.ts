import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import { collectAllPanes } from "@/stores/workspace-layout-actions";
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
  resolveWorkspaceMapKey: (input: {
    serverId: string;
    workspaceId: string;
  }) => string | null;
  readLayout: (workspaceKey: string) => WorkspaceLayout | null;
  readExplorerSidebarPaneId: (workspaceKey: string) => string | null | undefined;
  readSidePaneId: (workspaceKey: string) => string | null | undefined;
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
  if (!rawWorkspaceId) return null;
  const workspaceId = deps.resolveWorkspaceMapKey({
    serverId: input.serverId,
    workspaceId: rawWorkspaceId,
  });
  if (!workspaceId) return null;

  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId: input.serverId, workspaceId });
  if (!workspaceKey) return null;

  const layout = deps.readLayout(workspaceKey);
  if (!layout) return { workspaceId, workspaceKey, paneId: null };

  const explorerPaneId = deps.readExplorerSidebarPaneId(workspaceKey) ?? null;
  const sidePaneId = deps.readSidePaneId(workspaceKey) ?? null;
  const panes = collectAllPanes(layout.root).filter(
    (pane) => pane.id !== explorerPaneId && pane.hidden !== true,
  );

  if (sidePaneId && panes.some((pane) => pane.id === sidePaneId)) {
    return { workspaceId, workspaceKey, paneId: sidePaneId };
  }
  // ペインが1枚(エクスプローラを除く)なら右側がまだ無い。そのときは呼び出し側に作らせる。
  if (panes.length < 2) return { workspaceId, workspaceKey, paneId: null };
  return { workspaceId, workspaceKey, paneId: panes[panes.length - 1]?.id ?? null };
}

/**
 * エージェントをワークスペースの右カラムで開く。開けない(エージェントやワークスペースが
 * わからない・右カラムを作れない)ときは `false` を返し、呼び出し側が通常遷移へ落とす。
 */
export function openAgentInRightColumn(input: { serverId: string; agentId: string }): boolean {
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
  });
  if (!plan) return false;

  const paneId = plan.paneId ?? store.ensureSidePane(plan.workspaceKey);
  if (!paneId) return false;

  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: plan.workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    placement: { mode: "pane", paneId },
  });
  return true;
}
