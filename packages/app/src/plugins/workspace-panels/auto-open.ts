import { useEffect, useMemo } from "react";
import { useWindowDimensions } from "react-native";
import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { useInstalledPlugins } from "@/plugins/registry";
import { rightColumnPlacement } from "@/plugins/right-column";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";

/**
 * プラグインの面を「スレを開いたら右カラムに出す」仕組み(2026-10-30)。
 *
 * 2026-10-30 08:18 ユーザー(確認箱)「右側に一覧(PCは常時・iPhoneはボタンで開閉)で作る」の「PCは常時」。
 * これまでプラグインの面は、誰かが `openPanel` を呼ぶ(ボタンを押す)まで作られなかった。
 * ここでは、開いているスレのIDが面の `autoOpen.whenAgentIds` に含まれるとき、その面を右カラムへ入れる。
 *
 * 決めたこと:
 * - **狭い画面では出さない**。iPhone/スマホ幅は今までどおりボタンで開閉する(ユーザーの決定)。
 * - **ユーザーが置いた物を隠さない**。右カラムに既に会話や別の面が出ていれば、その後ろへ足す
 *   (`intent: "background"`)。入れた面に焦点は移さない(会話の入力位置を奪わない)。
 * - **1回だけ**。同じアプリの起動中に一度閉じた面は開き直さない(勝手に戻ると「閉じた」が効かない)。
 *   アプリを開き直したときに戻るのは「常時」の既定として意図どおり。
 * - 面はワークスペースのもの(`context: "workspace"`)だけ。スレ紐付きの面(`context: "agent"`)は
 *   開くスレが決まっているので、この仕組みの対象外。
 */

/** 面を自動で入れるかどうかの境目。プラグイン側の `WIDE_MIN_WIDTH` と同じ 720px。 */
export const AUTO_OPEN_MIN_WIDTH = 720;

/** 起動中に一度入れた(または閉じられた)面。`<workspaceKey>|<pluginId>:<panelId>`。 */
const handledKeys = new Set<string>();

export interface AutoOpenTarget {
  pluginId: string;
  panelId: string;
}

interface PanelSource {
  id: string;
  serverId: string;
  workspacePanels: readonly PluginWorkspacePanelContribution[];
};

/**
 * このスレを開いたときに右カラムへ入れる面。`serverId` のプラグインのうち、`autoOpen.whenAgentIds` に
 * `agentId` を含み、`right` に置けるワークスペース面だけを返す(重複は除く)。
 */
export function autoOpenTargets(
  plugins: readonly PanelSource[],
  serverId: string,
  agentId: string | null,
): AutoOpenTarget[] {
  if (!agentId) return [];
  const seen = new Set<string>();
  const targets: AutoOpenTarget[] = [];
  for (const plugin of plugins) {
    if (plugin.serverId !== serverId) continue;
    for (const panel of plugin.workspacePanels) {
      if (panel.context !== "workspace") continue;
      if (!(panel.locations ?? []).includes("right")) continue;
      const when = panel.autoOpen?.whenAgentIds ?? [];
      if (!when.includes(agentId)) continue;
      const key = `${plugin.id}:${panel.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ pluginId: plugin.id, panelId: panel.id });
    }
  }
  return targets;
}

/**
 * 開いているスレに応じて、面を右カラムへ入れる(入れたら何もしない)。
 * `enabled` は経路が前面にあるときだけ true(裏のワークスペースで勝手に欄が増えないように)。
 */
export function usePluginAutoOpenPanels(input: {
  serverId: string | null;
  workspaceId: string | null;
  agentId: string | null;
  enabled: boolean;
}): void {
  const plugins = useInstalledPlugins();
  const { width } = useWindowDimensions();
  const wide = width >= AUTO_OPEN_MIN_WIDTH;
  const { serverId, workspaceId, agentId, enabled } = input;
  const targets = useMemo(
    () => (serverId ? autoOpenTargets(plugins, serverId, agentId) : []),
    [plugins, serverId, agentId],
  );

  useEffect(() => {
    if (!enabled || !wide || !serverId || !workspaceId || targets.length === 0) return;
    const workspaceKey = `${serverId}:${workspaceId}`;
    const store = useWorkspaceLayoutStore.getState();
    for (const target of targets) {
      const handledKey = `${workspaceKey}|${target.pluginId}:${target.panelId}`;
      if (handledKeys.has(handledKey)) continue;
      const tabTarget = {
        kind: "plugin" as const,
        pluginId: target.pluginId,
        panelId: target.panelId,
        context: "workspace" as const,
      };
      const tabId = buildDeterministicWorkspaceTabId(tabTarget);
      const layout = store.layoutByWorkspace[workspaceKey];
      if (layout && collectAllTabs(layout.root).some((tab) => tab.tabId === tabId)) {
        handledKeys.add(handledKey);
        continue;
      }
      const paneId = store.ensureSidePane(workspaceKey, { focus: false });
      if (!paneId) continue;
      // 入れたこと自体は、開けたかに関わらず1回きりにする(失敗して毎描画で作り直さない)。
      handledKeys.add(handledKey);
      store.openTab({
        workspaceKey,
        target: tabTarget,
        intent: "background",
        placement: rightColumnPlacement(paneId, "behind"),
      });
    }
  }, [enabled, wide, serverId, workspaceId, targets]);
}

/** テスト用: 何を入れたかの記録を消す。 */
export function resetAutoOpenMemory(): void {
  handledKeys.clear();
}
