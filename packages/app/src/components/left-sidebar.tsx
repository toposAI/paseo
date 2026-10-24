import { router } from "expo-router";
import { FolderPlus, GitBranch, Settings, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { builtinSidebarNavLabelKey, type BuiltinSidebarNavId } from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { buildSettingsRoute } from "@/utils/host-routes";
import { UsageSidebarItem, UsageSidebarRoot } from "@/usage";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

/**
 * The vanilla sidebar's workspace/agent list and its display preferences are gone: the thread list
 * lives in the Topos child-thread plugin section below these rows. Only the navigation that is
 * still used daily is kept — starting a new workspace and search (⌘K). History and Schedules are
 * dropped along with the rest of the vanilla chrome.
 */
const NAV_IDS_IN_USE: readonly BuiltinSidebarNavId[] = ["new-workspace", "search"];

interface SidebarLabels {
  settings: string;
  usage: string;
  closeSidebar: string;
}

interface SidebarSharedProps {
  theme: SidebarTheme;
  labels: SidebarLabels;
  handleSettings: () => void;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const labels = useMemo(
    (): SidebarLabels => ({
      settings: t("sidebar.actions.settings"),
      usage: t(builtinSidebarNavLabelKey("usage")),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  if (isCompactLayout) {
    return (
      <RetainedPanelActivity active={active}>
        <MobileSidebar
          theme={theme}
          labels={labels}
          insetsTop={insets.top}
          insetsBottom={0}
          closeSidebar={showMobileAgent}
          handleSettings={handleSettingsMobile}
        />
      </RetainedPanelActivity>
    );
  }

  return (
    <RetainedPanelActivity active={active}>
      <DesktopSidebar
        theme={theme}
        labels={labels}
        insetsTop={insets.top}
        active={active}
        handleSettings={handleSettingsDesktop}
      />
    </RetainedPanelActivity>
  );
});

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon: Icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
  theme,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: typeof FolderPlus;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  theme: SidebarTheme;
  buttonRef?: RefObject<View | null>;
}) {
  const isCompact = useIsCompactFormFactor();
  const iconSize = isCompact ? theme.iconSize.lg : theme.iconSize.md;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton(isCompact)}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered }) => (
            <Icon
              size={iconSize + iconSizeAdjustment}
              color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

// The bottom line used to open with a fixed Add project button. That button now lives in Settings >
// Sidebar as an off-by-default row (the `add-project` builtin, hidden once for existing installs by
// the `add-project-row` settings migration), so the line is only plugin bar items (registered by
// `topos-confirm-box`, in their registration order) followed by Settings.
const BAR_PLUGIN_ID = "topos-confirm-box";

function SidebarFooter({
  theme,
  handleSettings,
  labels,
  onBeforeNavigate,
}: {
  theme: SidebarTheme;
  handleSettings: () => void;
  labels: {
    settings: string;
    usage: string;
  };
  onBeforeNavigate?: () => void;
}) {
  const settingsKeys = useShortcutKeys("toggle-settings");
  const { items: footerItems } = useSidebarNavItems("footer");
  const barRef = useRef<View | null>(null);
  const barItems = footerItems.filter(isBarItem);
  const hasBarItems = barItems.length > 0;
  // The six items are 192px wide; the line has 194px for them at the default sidebar width, and
  // less once the sidebar is dragged narrower. Comparing the two lets the line show a scrollbar
  // exactly when it is clipping, so a visible last icon always means "this is the whole line".
  const [barViewport, setBarViewport] = useState(0);
  const [barContent, setBarContent] = useState(0);
  const barOverflowing = barContent > barViewport + 1;
  const onBarLayout = useCallback((e: LayoutChangeEvent) => {
    setBarViewport(e.nativeEvent.layout.width);
  }, []);
  const onBarContentSize = useCallback((width: number) => setBarContent(width), []);

  // One line of icons: the plugin bar items, then Settings at the end. React Native Web drops a
  // horizontal scroll view's `overflow-x: auto` when `horizontal` sets `flexDirection`, so the
  // overflowing state adds it back (web-only; native scroll views already scroll).
  return (
    <UsageSidebarRoot>
      <View style={styles.footerContainer} testID="sidebar-footer">
        <SidebarFooterRows onBeforeNavigate={onBeforeNavigate} />
        <View style={styles.sidebarFooter} testID="sidebar-footer-bottom-line">
          <ScrollView
            testID="sidebar-footer-bar-scroll"
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.footerBarScroll, barOverflowing && styles.footerBarOverflowing]}
            contentContainerStyle={styles.footerBarItems}
            onLayout={hasBarItems ? onBarLayout : undefined}
            onContentSizeChange={hasBarItems ? onBarContentSize : undefined}
          >
            <View ref={barRef} collapsable={false} style={styles.footerBarGroup}>
              {barItems.map((item) =>
                item.kind === "plugin" ? (
                  <PluginSidebarItem
                    key={item.key}
                    group={item.group}
                    section="footer"
                    bar
                    fallbackAnchorRef={barRef}
                    onBeforeNavigate={onBeforeNavigate}
                  />
                ) : null,
              )}
            </View>
          </ScrollView>
          <FooterIconButton
            onPress={handleSettings}
            testID="sidebar-settings"
            label={labels.settings}
            icon={Settings}
            shortcutKeys={settingsKeys}
            theme={theme}
          />
        </View>
      </View>
    </UsageSidebarRoot>
  );
}

/** Whether a footer item is drawn as an icon in the bottom bar (plugin items only). */
function isBarItem(item: { kind: string; visible: boolean; group?: { pluginId?: string } }) {
  if (!item.visible) return false;
  if (item.kind === "builtin") return false;
  return item.group?.pluginId === BAR_PLUGIN_ID;
}

function SidebarFooterRows({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { items } = useSidebarNavItems("footer");
  const rowsRef = useRef<View | null>(null);
  const visibleItems = items.filter((item) => item.visible && !isBarItem(item));
  if (visibleItems.length === 0) return null;
  return (
    <>
      <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
        {visibleItems.map((item) =>
          item.kind === "plugin" ? (
            <PluginSidebarItem
              key={item.key}
              group={item.group}
              section="footer"
              fallbackAnchorRef={rowsRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          ) : (
            <UsageSidebarItem key={item.key} />
          ),
        )}
      </View>
      <SidebarSeparator testID="sidebar-footer-separator" />
    </>
  );
}

function MobileSidebar({
  theme,
  labels,
  handleSettings,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const { gesture: closeGesture } = useCloseAgentListGesture();

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        <SidebarNavRows
          style={styles.sidebarHeaderGroup}
          only={NAV_IDS_IN_USE}
          onBeforeNavigate={closeSidebar}
        />
        <WindowChromeSafeArea
          placement="inline"
          pointerEvents="box-none"
          style={styles.mobileCloseButtonRow}
        >
          <Pressable
            style={styles.mobileCloseButton}
            onPress={closeSidebar}
            testID="sidebar-close"
            nativeID="sidebar-close"
            accessible
            accessibilityRole="button"
            accessibilityLabel={labels.closeSidebar}
            hitSlop={8}
          >
            {({ hovered, pressed }) => (
              <X
                size={theme.iconSize.md}
                color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </WindowChromeSafeArea>

        <SidebarFooter
          theme={theme}
          handleSettings={handleSettings}
          labels={labels}
          onBeforeNavigate={closeSidebar}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({ theme, labels, handleSettings, insetsTop, active }: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });

  const startWidthRef = useRef(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the child-thread list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [styles.desktopSidebarBorder, { flex: 1, paddingTop: insetsTop }],
    [insetsTop],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  return (
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
      <View style={desktopSidebarBorderStyle}>
        <View style={styles.sidebarDragArea}>
          {ownsTopLeft || DEV_BUILD_LABEL ? (
            <View style={styles.desktopChromeRow}>
              <TitlebarDragRegion />
              {DEV_BUILD_LABEL ? (
                <View
                  pointerEvents="none"
                  style={styles.devBuildBadge}
                  testID="dev-build-label"
                  accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
                >
                  <GitBranch size={12} color={theme.colors.accentForeground} />
                  <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                    {DEV_BUILD_LABEL}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <TitlebarDragRegion />
          )}
          <SidebarNavRows style={sidebarHeaderGroupStyle} only={NAV_IDS_IN_USE} />
        </View>

        <SidebarCalloutSlot />

        <SidebarFooter theme={theme} handleSettings={handleSettings} labels={labels} />

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="left-sidebar-resize-handle"
        />
      </View>
    </Animated.View>
  );
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
  desktopSidebarHidden: {
    display: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    // The Topos child-thread list is the sidebar's thread list now, so this group owns the
    // remaining height: it fills the space the vanilla workspace list used to take and scrolls
    // on its own instead of pushing the footer off screen.
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButtonRow: {
    position: "absolute",
    top: theme.spacing[3],
    left: 0,
    right: 0,
    zIndex: 2,
    alignItems: "flex-end",
  },
  mobileCloseButton: {
    // The 16px X paints farther inside its 32px hit target than the 14px Settings2 glyph.
    // This optical inset puts their painted right edges on the same sidebar rail.
    marginRight: theme.spacing[2] + 1.5,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarDragArea: {
    position: "relative",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs. The horizontal inset is tight
  // because six plugin items plus Settings share this line in a sidebar that can be 200px wide.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
  },
  // The item row scrolls sideways (7 buttons can exceed a narrow sidebar) instead of clipping
  // Settings. Grows into spare room so Settings trails the items when the sidebar is wide enough.
  footerBarScroll: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  footerBarOverflowing: {
    overflowX: "auto",
  },
  footerBarItems: {
    flexGrow: 1,
  },
  footerBarGroup: {
    flexDirection: "row",
    alignItems: "center",
  },
  // Usage and plugin rows sit above the footer's icon line, spaced like the header nav rows.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: (isCompact: boolean) => ({
    // 32 rather than 36: the six 32px items need every pixel the line has at the default width.
    width: isCompact ? 36 : 32,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  }),
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
