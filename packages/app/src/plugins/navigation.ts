import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import { UnistylesRuntime } from "react-native-unistyles";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

/**
 * 狭い画面(幕の出る幅)かどうか。`useIsCompactFormFactor` の非フック版
 * (`plugins/navigation.ts` はフックの外から呼ばれる)。判定は同じ出どころ(Unistyles の breakpoint)。
 */
function isCompactLayout(): boolean {
  const breakpoint = UnistylesRuntime.breakpoint;
  return breakpoint === "xs" || breakpoint === "sm";
}

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(location: PluginPanelLocation) {
    if (location !== "explorer") return undefined;
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    if (!paneId) throw new Error("Explorer is unavailable");
    return { mode: "pane" as const, paneId };
  }

  /**
   * プラグインの面板を右の欄に出した後、狭い画面ではその幕も開く
   * (`compactExplorerView` = "plugin" で、幕の中身がその面板になる)。
   * 2026-10-28 ユーザー指示「窓口Bの右側に台帳。スワイプでその台帳に移動できるように」の受け皿。
   */
  function showPanelInCompactExplorer(placed: { paneId: string } | undefined) {
    if (!placed) return;
    const panelStore = usePanelStore.getState();
    panelStore.setCompactExplorerView("plugin");
    if (isCompactLayout()) panelStore.openCompactExplorerView("plugin");
  }
  return {
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId, params) {
      router.push(
        buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }, params),
      );
    },
    openWorkspacePanel(pluginId, panelId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      const placed = placement(location);
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        placement: placed,
      });
      showPanelInCompactExplorer(placed);
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      const placed = placement(location);
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
        placement: placed,
      });
      showPanelInCompactExplorer(placed);
    },
  };
}
