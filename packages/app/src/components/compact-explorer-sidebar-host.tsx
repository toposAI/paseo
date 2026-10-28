import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
// eslint-disable-next-line no-restricted-imports -- 幕の見出し・閉じるボタンの色だけをテーマから取る(既存のコンポーネント群と同じ `useUnistyles`)
import { useUnistyles } from "react-native-unistyles";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  CompactExplorerSidebar,
  NativeExplorerSidebarDock,
} from "@/components/compact-explorer-sidebar";
import { useCloseFileExplorerGesture, useOpenFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { usePanelStore } from "@/stores/panel-store";
import { collectAllTabs, findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { useInstalledPlugin } from "@/plugins/registry";
import { PluginPanel } from "@/plugins/workspace-panels/panel";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { isWeb } from "@/constants/platform";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import {
  resolveCompactExplorerSidebarHostModel,
  type CompactExplorerSidebarHostModel,
} from "@/components/compact-explorer-sidebar-host-state";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";

interface CompactExplorerOpenGestureSurfaceProps {
  children: ReactNode;
  enabled: boolean;
  onOpenExplorer: () => void;
}

const COMPACT_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

function CompactExplorerOpenGestureSurface({
  children,
  enabled,
  onOpenExplorer,
}: CompactExplorerOpenGestureSurfaceProps) {
  const explorerOpenGesture = useOpenFileExplorerGesture({
    enabled,
    onOpen: onOpenExplorer,
  });

  return (
    <GestureDetector gesture={explorerOpenGesture} touchAction={COMPACT_WEB_GESTURE_TOUCH_ACTION}>
      <View style={styles.fill}>{children}</View>
    </GestureDetector>
  );
}

function useActiveCompactExplorerSidebarModel(
  enabled: boolean,
): CompactExplorerSidebarHostModel | null {
  const selection = useActiveWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const isExplorerActive = useIsMobilePanelActive("file-explorer");
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const client = useHostRuntimeClient(selection?.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(selection?.serverId ?? "");
  const retainedModelRef = useRef<CompactExplorerSidebarHostModel | null>(null);
  const { checkoutQuery } = useWorkspaceCheckoutStatus({
    client,
    isConnected,
    isRouteFocused: enabled && selection !== null,
    normalizedServerId: selection?.serverId ?? "",
    normalizedWorkspaceId: selection?.workspaceId ?? "",
    workspaceDirectory: workspace?.workspaceDirectory || null,
  });
  const resolvedModel = useMemo(
    () =>
      resolveCompactExplorerSidebarHostModel({
        previous: isExplorerActive ? retainedModelRef.current : null,
        selection,
        workspace,
        isGit: checkoutQuery.data?.isGit ?? false,
      }),
    [checkoutQuery.data?.isGit, isExplorerActive, selection, workspace],
  );

  useEffect(() => {
    if (!selection) {
      retainedModelRef.current = null;
      if (enabled && isExplorerActive) {
        showMobileAgent();
      }
      return;
    }
    if (!isExplorerActive) {
      retainedModelRef.current = null;
      return;
    }
    if (resolvedModel) {
      retainedModelRef.current = resolvedModel;
    }
  }, [enabled, isExplorerActive, resolvedModel, selection, showMobileAgent]);

  return selection ? (resolvedModel ?? (isExplorerActive ? retainedModelRef.current : null)) : null;
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
  presentation: "overlay" | "dock";
}

export function CompactExplorerSidebarHost({
  children,
  enabled,
  presentation,
}: CompactExplorerSidebarHostProps) {
  const model = useActiveCompactExplorerSidebarModel(enabled);
  const [containerWidth, setContainerWidth] = useState(0);
  // 右から出る幕に出すプラグインの面板(例: 窓口Bの「タスク台帳」)。幕の出来は `file-explorer` のままで、
  // 中身だけ出し分ける(スワイプの通し番号・閉じる操作はそのまま使える)。
  const pluginTarget = useCompactExplorerPluginTarget(model);
  const hideIntoAgent = usePanelStore((state) => state.showMobileAgent);
  const openCompactFileExplorer = usePanelStore((state) => state.openCompactFileExplorer);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const openWorkspaceTabInFocusedPane = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget) =>
      openTab({ workspaceKey, target, intent: "reveal" }),
    [openTab],
  );
  const focusWorkspaceTab = useWorkspaceLayoutStore((state) => state.focusTab);

  const handleOpenExplorer = useCallback(() => {
    if (!model?.workspaceRoot) {
      return;
    }
    openCompactFileExplorer({
      serverId: model.serverId,
      cwd: model.workspaceRoot,
      isGit: model.isGit,
    });
  }, [model, openCompactFileExplorer]);

  // 幕の中の「右の欄の面板」からファイル一覧へ戻る。選んだ中身(面板)は覚えたままなので、
  // 次に左端からスワイプしたらまた面板が出る。
  const handleShowFiles = useCallback(() => {
    usePanelStore.getState().setCompactExplorerView("files");
  }, []);

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!model) {
        return;
      }
      openWorkspaceFileFromExplorer({
        filePath,
        persistenceKey: model.persistenceKey,
        closeExplorerAfterOpen: presentation === "overlay",
        showMobileAgent,
        openWorkspaceTabInFocusedPane,
        focusWorkspaceTab,
      });
    },
    [focusWorkspaceTab, model, openWorkspaceTabInFocusedPane, presentation, showMobileAgent],
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  const explorer =
    enabled && model ? (
      <DiffDocumentWorkspaceCacheProvider key={model.persistenceKey}>
        <CompactExplorerContent
          model={model}
          presentation={presentation}
          pluginTarget={pluginTarget}
          containerWidth={containerWidth}
          onOpenFile={handleOpenFile}
          onShowFiles={handleShowFiles}
          onClosePlugin={hideIntoAgent}
        />
      </DiffDocumentWorkspaceCacheProvider>
    ) : null;

  let themedExplorer = explorer;
  if (isWeb) {
    themedExplorer = <AppearanceStyleBoundary>{explorer}</AppearanceStyleBoundary>;
  }

  if (presentation === "dock") {
    return (
      <View style={styles.row} onLayout={handleContainerLayout}>
        <View style={styles.fill}>{children}</View>
        {themedExplorer}
      </View>
    );
  }

  return (
    <>
      <CompactExplorerOpenGestureSurface
        enabled={enabled && Boolean(model?.workspaceRoot)}
        onOpenExplorer={handleOpenExplorer}
      >
        {children}
      </CompactExplorerOpenGestureSurface>
      {themedExplorer}
    </>
  );
}

/**
 * 幕・欄の中身。狭い画面で右の欄のプラグイン面板を選んでいるときはその面板、それ以外は
 * ファイル一覧(幕)・ドック(広い画面)を出す。分岐を1か所にまとめて、上では組み立てるだけにする。
 */
function CompactExplorerContent({
  model,
  presentation,
  pluginTarget,
  containerWidth,
  onOpenFile,
  onShowFiles,
  onClosePlugin,
}: {
  model: CompactExplorerSidebarHostModel;
  presentation: "overlay" | "dock";
  pluginTarget: WorkspaceTabTarget | null;
  containerWidth: number;
  onOpenFile: (filePath: string) => void;
  onShowFiles: () => void;
  onClosePlugin: () => void;
}) {
  if (presentation === "overlay" && pluginTarget) {
    return (
      <CompactExplorerPluginPanel
        serverId={model.serverId}
        workspaceId={model.workspaceId}
        target={pluginTarget}
        onShowFiles={onShowFiles}
        onClose={onClosePlugin}
      />
    );
  }
  if (presentation === "dock") {
    return (
      <NativeExplorerSidebarDock
        serverId={model.serverId}
        workspaceId={model.workspaceId}
        workspaceRoot={model.workspaceRoot}
        isGit={model.isGit}
        persistenceKey={model.persistenceKey}
        containerWidth={containerWidth}
        onOpenFile={onOpenFile}
      />
    );
  }
  return (
    <CompactExplorerSidebar
      serverId={model.serverId}
      workspaceId={model.workspaceId}
      workspaceRoot={model.workspaceRoot}
      isGit={model.isGit}
      onOpenFile={onOpenFile}
    />
  );
}

const styles = {
  fill: {
    flex: 1,
  },
  row: {
    flex: 1,
    flexDirection: "row",
  },
  panelBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  panelTab: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  panelTabActive: {
    borderBottomWidth: 2,
  },
  panelClose: {
    position: "absolute",
    right: 12,
    bottom: 16,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
} as const;

/**
 * 幕の中に出すもの。既定はファイル一覧。ワークスペースの右側の欄からプラグインの面板
 * (`locations` に `"explorer"` を含むもの)を開くと、その面板を出す(2026-10-28 ユーザー指示:
 * 「窓口Bの右側に台帳を作る。スワイプでその台帳に移動できるように」)。
 * 幕の出来(スワイプ・閉じる)はファイル一覧と共通で、選んだ中身だけを覚える。
 */
function useCompactExplorerPluginTarget(
  model: CompactExplorerSidebarHostModel | null,
): WorkspaceTabTarget | null {
  const workspaceKey = model ? `${model.serverId}:${model.workspaceId}` : null;
  const view = usePanelStore((state) => state.compactExplorerView);
  const paneId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null) : null,
  );
  const target = useWorkspaceLayoutStore((state) => {
    if (!workspaceKey) {
      return null;
    }
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!layout) {
      return null;
    }
    const pane = findPaneById(layout.root, paneId);
    if (!pane) {
      return null;
    }
    const tab = collectAllTabs(layout.root).find(
      (candidate) => candidate.tabId === pane.focusedTabId,
    );
    return tab?.target.kind === "plugin" ? tab.target : null;
  });
  if (view !== "plugin" || !workspaceKey || !target) {
    return null;
  }
  return target;
}

function usePluginPanelTitle(serverId: string, target: WorkspaceTabTarget): string {
  const pluginId = target.kind === "plugin" ? target.pluginId : null;
  const plugin = useInstalledPlugin(serverId, pluginId ?? "");
  if (target.kind !== "plugin") {
    return "";
  }
  return (
    plugin?.workspacePanels.find(
      (panel) => panel.id === target.panelId && panel.context === target.context,
    )?.title ?? "パネル"
  );
}

/** 幕の中に出すプラグインの面板(1枚だけ)。閉じる操作は上の見出し(ファイル一覧へ戻る・閉じる)。 */
function CompactExplorerPluginPanel({
  serverId,
  workspaceId,
  target,
  onShowFiles,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  target: WorkspaceTabTarget;
  onShowFiles: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const isActive = useIsMobilePanelActive("file-explorer");
  const { gesture: closeGesture } = useCloseFileExplorerGesture();
  const title = usePluginPanelTitle(serverId, target);
  const panelStyle = useMemo(
    () => [styles.fill, { paddingTop: insets.top, backgroundColor: theme.colors.surfaceSidebar }],
    [insets.top, theme.colors.surfaceSidebar],
  );
  const barStyle = useMemo(
    () => [styles.panelBar, { borderBottomColor: theme.colors.border, borderBottomWidth: 1 }],
    [theme.colors.border],
  );
  const tabStyle = useMemo(() => [styles.panelTab, styles.panelTabActive], []);
  const tabTextStyle = useMemo(
    () => [{ color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const titleStyle = useMemo(() => [{ color: theme.colors.foreground }], [theme.colors.foreground]);
  const pane = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId,
      host: "explorer",
      tabId: "compact-explorer-plugin-panel",
      target,
      openTab: () => {},
      openPreferredTarget: () => {},
      openTargetToSide: () => {},
      closeCurrentTab: onClose,
      retargetCurrentTab: () => {},
      setCurrentTabState: () => {},
      openFileInWorkspace: () => {},
      openImportSheet: () => {},
    }),
    [onClose, serverId, target, workspaceId],
  );
  const closeStyle = useMemo(
    () => [
      styles.panelClose,
      {
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
    ],
    [theme.colors.border, theme.colors.surface1],
  );

  return (
    <RetainedPanelActivity active={isActive}>
      <MobilePanelOverlay panel="file-explorer" closeGesture={closeGesture} panelStyle={panelStyle}>
        <View style={barStyle} testID="compact-explorer-panel-bar">
          <Pressable style={styles.panelTab} onPress={onShowFiles} testID="explorer-tab-files">
            <Text style={tabTextStyle}>ファイル</Text>
          </Pressable>
          <View style={tabStyle}>
            <Text style={titleStyle}>{title}</Text>
          </View>
        </View>
        <PaneProvider value={pane}>
          <View style={styles.fill}>
            <PluginPanel />
          </View>
        </PaneProvider>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="閉じる"
          style={closeStyle}
          onPress={onClose}
          testID="compact-plugin-panel-close"
        >
          <Text style={tabTextStyle}>閉じる</Text>
        </Pressable>
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
}
