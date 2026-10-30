import { useCallback, useMemo, useRef } from "react";
import { PanResponder, View, useWindowDimensions, type ViewStyle } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { PluginWorkspaceBandProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { PluginInstallationProvider } from "../installation-provider";
import { createPluginNavigation } from "../navigation";
import { resolvePluginPlatform } from "../platform";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { AUTO_OPEN_MIN_WIDTH } from "./auto-open";
import {
  EDGE_SWIPE_STRIP_WIDTH,
  bandTargets,
  edgeSwipeTargets,
  entryOpenLocation,
  resolveEdgeSwipe,
} from "./entry-points";

/**
 * 窓口Bのスレの入口 2つ(2026-10-30 ユーザー指示「右端からスワイプで指示一覧」「会話の上に帯」)。
 * どちらも窓口BのIDは持たず、プラグインの面の `autoOpen.edgeSwipe` / `band` の指定から引く。
 */

function openTargetPanel(input: {
  serverId: string;
  workspaceId: string;
  pluginId: string;
  panelId: string;
  width: number;
  plugins: ReturnType<typeof useInstalledPlugins>;
}): void {
  const { serverId, workspaceId, pluginId, panelId, width, plugins } = input;
  const panel = plugins
    .find((plugin) => plugin.serverId === serverId && plugin.id === pluginId)
    ?.workspacePanels.find((candidate) => candidate.id === panelId);
  const location = entryOpenLocation(panel, width, AUTO_OPEN_MIN_WIDTH);
  createPluginNavigation({ serverId, workspaceId }).openWorkspacePanel(pluginId, panelId, location);
}

// ---------------------------------------------------------------- 右端スワイプの帯

// web は縦スクロールを始めさせない(横の動きをこちらで判定する)。RN の型には無いので型を足す。
const STRIP_STYLE = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  width: EDGE_SWIPE_STRIP_WIDTH,
  zIndex: 20,
  touchAction: "none",
} as ViewStyle;

/**
 * 画面の右端だけを覆う細い帯。左向きの横の動きが優勢になったら面を開く。縦が優勢なら何もしない。
 * タップはこの帯(約28px)の中では子に届かない(判断: 帯の幅が細いため許容。docs は報告に記載)。
 */
export function PluginEdgeSwipeStrip({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string | null;
}) {
  const compact = useIsCompactFormFactor();
  const plugins = useInstalledPlugins();
  const { width } = useWindowDimensions();
  const target = useMemo(
    () => edgeSwipeTargets(plugins, serverId, agentId)[0] ?? null,
    [plugins, serverId, agentId],
  );
  const open = useCallback(() => {
    if (!target) return;
    openTargetPanel({ serverId, workspaceId, ...target, width, plugins });
  }, [target, serverId, workspaceId, width, plugins]);
  const openRef = useRef(open);
  openRef.current = open;
  const state = useRef<"idle" | "tracking" | "done">("idle");
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          state.current = "tracking";
        },
        onPanResponderMove: (_event, gesture) => {
          if (state.current !== "tracking") return;
          const verdict = resolveEdgeSwipe(gesture.dx, gesture.dy);
          if (verdict === "pending") return;
          state.current = "done";
          if (verdict === "open") openRef.current();
        },
        onPanResponderRelease: () => {
          state.current = "idle";
        },
        onPanResponderTerminate: () => {
          state.current = "idle";
        },
      }),
    [],
  );
  if (!compact || !target) return null;
  return <View testID="plugin-edge-swipe-strip" style={STRIP_STYLE} {...responder.panHandlers} />;
}

// ---------------------------------------------------------------- 会話の上の帯

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function BandBody({
  serverId,
  workspaceId,
  agentId,
  target,
  theme,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  target: ReturnType<typeof bandTargets>[number];
  theme: PluginTheme;
}) {
  const plugins = useInstalledPlugins();
  const plugin = plugins.find((p) => p.serverId === serverId && p.id === target.pluginId) ?? null;
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const open = useCallback(() => {
    try {
      openTargetPanel({
        serverId,
        workspaceId,
        pluginId: target.pluginId,
        panelId: target.panelId,
        width,
        plugins,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [serverId, workspaceId, target.pluginId, target.panelId, width, plugins, toast]);
  if (!plugin || !client) return null;
  const Component = target.Component;
  const props: PluginWorkspaceBandProps = {
    theme,
    host: { id: serverId, label: hostLabel },
    layout: { compact, platform: resolvePluginPlatform() },
    workspaceId,
    agentId,
    open,
  };
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} renderError={renderNothing}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component {...props} />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

// 帯が壊れても会話は出す(帯だけ消える)。
function renderNothing() {
  return null;
}

const ThemedBandBody = withUnistyles(BandBody);

/** 会話の上に、`band` を持つ面の帯を並べる。指定の無いスレでは何も出さない。 */
export function PluginWorkspaceBands({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string | null;
}) {
  const plugins = useInstalledPlugins();
  const targets = useMemo(
    () => bandTargets(plugins, serverId, agentId),
    [plugins, serverId, agentId],
  );
  if (!agentId || targets.length === 0) return null;
  return (
    <>
      {targets.map((target) => (
        <ThemedBandBody
          key={`${target.pluginId}:${target.panelId}`}
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          target={target}
          uniProps={pluginThemeMapping}
        />
      ))}
    </>
  );
}
