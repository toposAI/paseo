import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PanelLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";
import { HeaderToggleButton, headerIconSlotStyle } from "./header-toggle-button";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { useSettings } from "@/hooks/use-settings";
import { useToposSidebarCounts } from "@/hooks/use-topos-sidebar-counts";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useHasWindowChromeObstruction, useOwnsWindowChromeCorner } from "@/utils/desktop-window";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  borderless?: boolean;
}

interface SidebarMenuToggleProps {
  style?: StyleProp<ViewStyle>;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  testID?: string;
  nativeID?: string;
}

const MOBILE_MENU_LINE_WIDTH = 16;
const MOBILE_MENU_LINE_SHORT_WIDTH = 8;
const MOBILE_MENU_LINE_HEIGHT = 1.5;

function MobileMenuIcon({ color }: { color: string }) {
  const lineStyle = useMemo(() => [styles.mobileMenuLine, { backgroundColor: color }], [color]);
  const shortLineStyle = useMemo(
    () => [styles.mobileMenuLine, styles.mobileMenuLineShort, { backgroundColor: color }],
    [color],
  );
  return (
    <View style={styles.mobileMenuIcon} pointerEvents="none">
      <View style={lineStyle} />
      <View style={lineStyle} />
      <View style={shortLineStyle} />
    </View>
  );
}

function ToposThreadCounts() {
  const enabled = useSettings((settings) => settings.toposChatStyle);
  const { ask, fresh } = useToposSidebarCounts();
  if (!enabled || (ask === 0 && fresh === 0)) return null;
  return (
    <View style={styles.countsRow} pointerEvents="none" testID="topos-thread-counts">
      {ask > 0 ? (
        <View style={[styles.countPill, styles.countPillAsk]} testID="topos-thread-count-ask">
          <Text style={styles.countText}>{ask}</Text>
        </View>
      ) : null}
      {fresh > 0 ? (
        <View style={[styles.countPill, styles.countPillFresh]} testID="topos-thread-count-new">
          <Text style={styles.countText}>{fresh}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SidebarMenuToggleButton({
  isMobile,
  extraMutedIdleIcon = false,
  resolvedStyle,
  tooltipSide = "right",
  testID = "menu-button",
  nativeID = "menu-button",
}: Omit<SidebarMenuToggleProps, "style"> & {
  isMobile: boolean;
  extraMutedIdleIcon?: boolean;
  resolvedStyle: StyleProp<ViewStyle>;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isOpen = usePanelStore((state) => selectIsAgentListOpen(state, { isCompact: isMobile }));
  const toggleAgentListForLayout = usePanelStore((state) => state.toggleAgentListForLayout);
  const toggleShortcutKeys = useMemo(
    () => (getShortcutOs() === "mac" ? ["mod", "B"] : ["mod", "."]),
    [],
  );

  const handlePress = useCallback(() => {
    toggleAgentListForLayout({ isCompact: isMobile });
  }, [toggleAgentListForLayout, isMobile]);

  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);

  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("shell.menu.toggleSidebar")}
      tooltipKeys={toggleShortcutKeys}
      tooltipSide={tooltipSide}
      testID={testID}
      nativeID={nativeID}
      style={resolvedStyle}
      accessible
      accessibilityRole="button"
      accessibilityLabel={isOpen ? t("shell.menu.close") : t("shell.menu.open")}
      accessibilityState={accessibilityState}
    >
      <ToposThreadCounts />
      {isMobile ? (
        <MobileMenuIcon
          color={
            extraMutedIdleIcon ? theme.colors.foregroundExtraMuted : theme.colors.foregroundMuted
          }
        />
      ) : (
        <PanelLeft
          size={iconButtonChromeGlyphSize("large")}
          strokeWidth={1.5}
          color={
            extraMutedIdleIcon ? theme.colors.foregroundExtraMuted : theme.colors.foregroundMuted
          }
        />
      )}
    </HeaderToggleButton>
  );
}

export function SidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const isMobile = useIsCompactFormFactor();
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  const placeholderStyle = useMemo(
    () => [headerIconSlotStyle.slot, resolvedStyle],
    [resolvedStyle],
  );

  if (!isMobile && !ownsTopLeft) {
    return null;
  }

  if (!isMobile && hasTopLeftWindowControls) {
    return (
      <View pointerEvents="none" style={placeholderStyle}>
        <View style={styles.desktopMenuIconSpace} />
      </View>
    );
  }

  return <SidebarMenuToggleButton {...props} isMobile={isMobile} resolvedStyle={resolvedStyle} />;
}

export function WindowSidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  return (
    <SidebarMenuToggleButton
      {...props}
      isMobile={false}
      extraMutedIdleIcon
      resolvedStyle={resolvedStyle}
    />
  );
}

export function MenuHeader({ title, rightContent, borderless }: MenuHeaderProps) {
  return (
    <ScreenHeader
      left={
        <>
          <SidebarMenuToggle />
          {title && <ScreenTitle>{title}</ScreenTitle>}
        </>
      }
      right={rightContent}
      leftStyle={styles.left}
      borderless={borderless}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  leadingToggle: {
    marginLeft: {
      xs: 0,
      md: -theme.spacing[2],
    },
  },
  left: {
    gap: theme.spacing[2],
  },
  mobileMenuIcon: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: 12,
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  desktopMenuIconSpace: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
  },
  mobileMenuLine: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: MOBILE_MENU_LINE_HEIGHT,
    borderRadius: theme.borderRadius.full,
  },
  mobileMenuLineShort: {
    width: MOBILE_MENU_LINE_SHORT_WIDTH,
  },
  countsRow: {
    position: "absolute",
    right: 1,
    bottom: 3,
    flexDirection: "row",
    gap: 2,
  },
  countPill: {
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  countPillAsk: {
    backgroundColor: "#f97316",
  },
  countPillFresh: {
    backgroundColor: "#22c55e",
  },
  countText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
    lineHeight: 12,
  },
}));
