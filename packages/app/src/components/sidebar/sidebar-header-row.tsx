import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";

/**
 * Roomy row height by breakpoint: finger-sized on the phone drawer / narrow web view, and still
 * 44px (the smallest comfortable touch target) on desktop. A two-line roomy label (40px) grows
 * the row to 40 + 2 × 6px padding = 52px.
 */
const ROOMY_MIN_HEIGHT = { xs: 48, md: 44 } as const;

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type SidebarHeaderRowVariant = "header" | "compact" | "inline";

export type SidebarRowIcon = ComponentType<{ size: number; color: string }>;

interface SidebarHeaderRowProps {
  icon: SidebarRowIcon | null;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   * "inline": a full-width row with no inset, for a row inside a padded container such as the
   * sidebar footer.
   */
  variant?: SidebarHeaderRowVariant;
  /** Shown in the right slot while the row is hovered, when `trailing` is not set. */
  shortcutKeys?: ShortcutKey[][] | null;
  /**
   * The right slot. A sibling of the row's button, never inside it (web cannot nest buttons). A
   * press on the slot presses the row; a button inside it presses on its own.
   */
  trailing?: ReactNode;
  rowRef?: Ref<View>;
  /**
   * "compact" (default): unchanged — the 28px row, label wraps as before.
   * "roomy": a finger-sized row (≥44px) whose label is clipped to two lines, for plugin list rows.
   */
  size?: "compact" | "roomy";
}

// Style lists are prepared outside the component so its branch count stays low (oxlint complexity).
function rowStyle(roomy: boolean, isHighlighted: boolean) {
  return [styles.row, roomy && styles.rowRoomy, isHighlighted && styles.rowHighlighted];
}
function buttonStyle(roomy: boolean) {
  return [styles.button, roomy && styles.buttonRoomy];
}
function labelStyle(roomy: boolean, isHighlighted: boolean) {
  return [styles.label, roomy && styles.labelRoomy, isHighlighted && styles.labelHighlighted];
}
function trailingStyle(roomy: boolean) {
  return roomy ? styles.trailingRoomy : styles.trailing;
}
function iconSpacerStyle(variant: SidebarHeaderRowVariant) {
  return variant === "header" ? styles.iconSpacer : styles.iconSpacerCompact;
}

export function SidebarHeaderRow({
  icon: Icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  shortcutKeys = null,
  trailing,
  rowRef,
  size = "compact",
}: SidebarHeaderRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const ThemedIcon = useMemo(() => (Icon ? withUnistyles(Icon) : null), [Icon]);
  const isHighlighted = isHovered || isActive;
  const iconSize = variant === "header" ? ICON_SIZE.md : ICON_SIZE.sm;
  const roomy = size === "roomy";

  let right = trailing ?? null;
  if (right === null && shortcutKeys && isHovered) {
    right = <Shortcut chord={shortcutKeys} />;
  }

  return (
    <View ref={rowRef} collapsable={false} style={getContainerStyle(variant)}>
      <View
        style={rowStyle(roomy, isHighlighted)}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <Pressable
          onPress={onPress}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={isActive ? SELECTED_STATE : undefined}
          aria-selected={isActive}
          style={buttonStyle(roomy)}
        >
          {ThemedIcon ? (
            <ThemedIcon
              size={iconSize}
              uniProps={isHighlighted ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          ) : (
            <View style={iconSpacerStyle(variant)} />
          )}
          <Text style={labelStyle(roomy, isHighlighted)} numberOfLines={roomy ? 2 : undefined}>
            {label}
          </Text>
        </Pressable>
        {right === null ? null : (
          <Pressable
            onPress={onPress}
            accessible={false}
            focusable={false}
            style={trailingStyle(roomy)}
          >
            {right}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const SELECTED_STATE = { selected: true } as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  containerInline: {
    width: "100%",
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: 28,
    borderRadius: theme.borderRadius.lg,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // Finger-sized list row (plugin items).
  rowRoomy: {
    minHeight: ROOMY_MIN_HEIGHT,
  },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
  },
  buttonRoomy: {
    minHeight: ROOMY_MIN_HEIGHT,
    paddingVertical: theme.spacing[1.5],
  },
  iconSpacer: { width: ICON_SIZE.md, height: ICON_SIZE.md },
  iconSpacerCompact: { width: ICON_SIZE.sm, height: ICON_SIZE.sm },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  // A roomy label may wrap: up to two lines of 20px.
  labelRoomy: {
    lineHeight: 20,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
  // Stretch to the row's full height so the right end (and a trailing badge) is pressable too.
  trailingRoomy: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
}));

function getContainerStyle(variant: SidebarHeaderRowVariant) {
  switch (variant) {
    case "header":
      return styles.container;
    case "compact":
      return styles.containerCompact;
    case "inline":
      return styles.containerInline;
  }
}
