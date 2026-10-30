import type { ComponentType } from "react";
import type {
  PluginPanelLocation,
  PluginWorkspaceBandProps,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin/client";

/**
 * 窓口Bのスレの「入口」(右端スワイプ・会話の上の帯)を決める純粋な関数(2026-10-30 ユーザー指示
 * 「窓口Bの場面で右端からスワイプすると指示一覧が開く」「Cもいいね。やって」)。
 * 窓口BのIDはここに書かず、プラグインの面の `autoOpen.whenAgentIds` / `band.whenAgentIds` から引く。
 */

/** 右端の細い帯の幅(px)。既存の右端スワイプ(24px)より少し広く、横の動きだけを見る。 */
export const EDGE_SWIPE_STRIP_WIDTH = 28;
/** 左向きにこれだけ動いたら横スワイプとみなす(px)。 */
export const EDGE_SWIPE_MIN_DX = 14;
/** 横が縦の何倍以上なら「横が優勢」とみなすか。 */
export const EDGE_SWIPE_DOMINANCE = 1.25;

export type EdgeSwipeVerdict = "open" | "cancel" | "pending";

/**
 * 指の動き(開始点からの差 dx, dy)を判定する。
 * - open   … 左向きに14px以上動き、横が縦の1.25倍以上(指示一覧を開く)
 * - cancel … 縦(または右向き)が優勢と分かった。このタッチでは開かない(縦スクロールの意図)
 * - pending … まだ判定できない(タップを含む)
 */
export function resolveEdgeSwipe(dx: number, dy: number): EdgeSwipeVerdict {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (dx <= -EDGE_SWIPE_MIN_DX && ax >= EDGE_SWIPE_DOMINANCE * ay) return "open";
  if (ay >= EDGE_SWIPE_MIN_DX && ay > ax) return "cancel";
  if (dx >= EDGE_SWIPE_MIN_DX) return "cancel";
  return "pending";
}

interface PanelSource {
  id: string;
  serverId: string;
  workspacePanels: readonly PluginWorkspacePanelContribution[];
}

export interface EdgeSwipeTarget {
  pluginId: string;
  panelId: string;
}

/** このスレで右端スワイプから開く面(ワークスペース面だけ。先頭1つを使う)。 */
export function edgeSwipeTargets(
  plugins: readonly PanelSource[],
  serverId: string,
  agentId: string | null,
): EdgeSwipeTarget[] {
  if (!agentId) return [];
  const targets: EdgeSwipeTarget[] = [];
  for (const plugin of plugins) {
    if (plugin.serverId !== serverId) continue;
    for (const panel of plugin.workspacePanels) {
      if (panel.context !== "workspace") continue;
      if (panel.autoOpen?.edgeSwipe !== true) continue;
      if (!panel.autoOpen.whenAgentIds.includes(agentId)) continue;
      targets.push({ pluginId: plugin.id, panelId: panel.id });
    }
  }
  return targets;
}

export interface BandTarget extends EdgeSwipeTarget {
  Component: ComponentType<PluginWorkspaceBandProps>;
}

/** このスレの会話の上に出す帯(ワークスペース面の `band`)。 */
export function bandTargets(
  plugins: readonly PanelSource[],
  serverId: string,
  agentId: string | null,
): BandTarget[] {
  if (!agentId) return [];
  const targets: BandTarget[] = [];
  for (const plugin of plugins) {
    if (plugin.serverId !== serverId) continue;
    for (const panel of plugin.workspacePanels) {
      if (panel.context !== "workspace" || !panel.band) continue;
      if (!panel.band.whenAgentIds.includes(agentId)) continue;
      targets.push({ pluginId: plugin.id, panelId: panel.id, Component: panel.band.Component });
    }
  }
  return targets;
}

/**
 * 面を開く場所。広い画面は右カラム、狭い画面は主ペイン(全画面タブ)。面が右カラムに置けなければ主ペイン。
 */
export function entryOpenLocation(
  panel: PluginWorkspacePanelContribution | undefined,
  width: number,
  wideMinWidth: number,
): PluginPanelLocation {
  const supportsRight = (panel?.locations ?? []).includes("right");
  return width >= wideMinWidth && supportsRight ? "right" : "workspace";
}
