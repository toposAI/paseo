import { useEffect, useMemo } from "react";
import { useWindowDimensions } from "react-native";
import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { useInstalledPlugins } from "@/plugins/registry";
import { rightColumnPlacement } from "@/plugins/right-column";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectAllTabs, findPaneContainingTab } from "@/stores/workspace-layout-actions";
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
 * - **読み込み済みの並びの上でだけ入れる**。並び(レイアウト)の保存の読み出しが終わる前に欄を作ると、
 *   あとから来る保存の内容でワークスペースごと置き換わり、入れた面が消える(記録済みなので戻らない)。
 *   呼び出し側が `ready`(読み出し済み)を渡し、まだなら何もしない(`ensureSidePane` は保存の待ち受け
 *   に反応しないので、ここで待つ)。
 * - 面はワークスペースのもの(`context: "workspace"`)だけ。スレ紐付きの面(`context: "agent"`)は
 *   開くスレが決まっているので、この仕組みの対象外。
 * - **窓口B以外のスレへ切り替えたら畳む**。面はワークスペースのものなので、入れた面は同じワークスペースの
 *   別のスレへ切り替えても残ってしまう(2026-10-30 実画面確認: `?open=agent:<別スレ>` で母ワークスペースに
 *   別スレを開くと出たままだった)。自動で入れた面は `handledKeys` で区別し、条件の合わないスレへ切り替えた
 *   ら閉じる(ユーザーが自分でボタンから開いた面は閉じない)。
 */

/** 面を自動で入れるかどうかの境目。プラグイン側の `WIDE_MIN_WIDTH`(720)と同じ値。 */
export const AUTO_OPEN_MIN_WIDTH = 720;

/** 起動中に一度入れた面。`<workspaceKey>|<pluginId>:<panelId>`。 */
const handledKeys = new Set<string>();

/**
 * 自動で入れた面を、条件に合わないスレへ切り替えたときに閉じる(手で開いた面は触らない)。
 * 隠した右の欄の中にある面は閉じない(欄ごと隠しただけの物を消さない)。
 */
function closeAutoOpened(
  store: ReturnType<typeof useWorkspaceLayoutStore.getState>,
  workspaceKey: string,
  target: AutoOpenTarget,
): void {
  const tabTarget = {
    kind: "plugin" as const,
    pluginId: target.pluginId,
    panelId: target.panelId,
    context: "workspace" as const,
  };
  const tabId = buildDeterministicWorkspaceTabId(tabTarget);
  const layout = store.layoutByWorkspace[workspaceKey];
  const pane = layout ? findPaneContainingTab(layout.root, tabId) : null;
  if (pane && pane.hidden !== true) store.closeTab(workspaceKey, tabId);
  handledKeys.delete(`${workspaceKey}|${target.pluginId}:${target.panelId}`);
}

export interface AutoOpenTarget {
  pluginId: string;
  panelId: string;
}

interface PanelSource {
  id: string;
  serverId: string;
  workspacePanels: readonly PluginWorkspacePanelContribution[];
}

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
 * `ready` は並び(レイアウト)の保存の読み出しが終わったときだけ true。
 */
export function usePluginAutoOpenPanels(input: {
  serverId: string | null;
  workspaceId: string | null;
  agentId: string | null;
  enabled: boolean;
  ready: boolean;
}): void {
  const plugins = useInstalledPlugins();
  const { width } = useWindowDimensions();
  const wide = width >= AUTO_OPEN_MIN_WIDTH;
  const { serverId, workspaceId, agentId, enabled, ready } = input;
  const targets = useMemo(
    () => (serverId ? autoOpenTargets(plugins, serverId, agentId) : []),
    [plugins, serverId, agentId],
  );

  useEffect(() => {
    if (!ready || !enabled || !serverId || !workspaceId) return;
    const workspaceKey = `${serverId}:${workspaceId}`;
    const store = useWorkspaceLayoutStore.getState();
    // このワークスペースで自動で入れたのに、いまのスレには要らない面は閉じる(窓口B以外のスレへ切り替えたとき)。
    const wanted = new Set(targets.map((target) => `${target.pluginId}:${target.panelId}`));
    for (const key of Array.from(handledKeys)) {
      const [keyWorkspace, panel] = key.split("|");
      if (keyWorkspace !== workspaceKey || wanted.has(panel)) continue;
      const [pluginId, panelId] = panel.split(":");
      closeAutoOpened(store, workspaceKey, { pluginId, panelId });
    }
    if (!wide || targets.length === 0) return;
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
  }, [ready, enabled, wide, serverId, workspaceId, targets]);
}

/** テスト用: 何を入れたかの記録を消す。 */
export function resetAutoOpenMemory(): void {
  handledKeys.clear();
}
