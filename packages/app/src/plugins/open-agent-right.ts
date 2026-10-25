import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectAllPanes } from "@/stores/workspace-layout-actions";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceOpaqueId, resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

/**
 * エージェントをワークスペースの右カラム(分割ペイン)で開く。2026-10-25、確認箱の「スレを開く」用。
 * 右にすでにペインがあればそこへ、無ければフォーカス中ペインを右に分割して開く。
 * 開けない(ワークスペース不明・レイアウト未読込・分割不可)ときは false を返し、呼び出し側が通常遷移へ落とす。
 */
export function openAgentInRightColumn(input: { serverId: string; agentId: string }): boolean {
  const session = useSessionStore.getState().sessions[input.serverId];
  const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
  const rawWorkspaceId = normalizeWorkspaceOpaqueId(agent?.workspaceId);
  if (!rawWorkspaceId) return false;
  const workspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces: session?.workspaces,
    workspaceId: rawWorkspaceId,
  });
  if (!workspaceId) return false;

  const workspaceKey = `${input.serverId}:${workspaceId}`;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  if (!layout) return false;
  const explorerPaneId = store.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null;
  const panes = collectAllPanes(layout.root).filter((p) => p.id !== explorerPaneId);
  if (panes.length === 0) return false;

  let paneId: string | null;
  if (panes.length >= 2) {
    paneId = panes[panes.length - 1]?.id ?? null;
  } else {
    const target = layout.focusedPaneId ?? panes[0]?.id;
    paneId = target ? store.splitPaneEmpty(workspaceKey, { targetPaneId: target, position: "right" }) : null;
  }
  if (!paneId) return false;

  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    placement: { mode: "pane", paneId },
  });
  return true;
}
