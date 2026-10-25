import type { SidebarIcon, SidebarRowProps } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarSeparator as AppSidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { useIsCompactFormFactor } from "@/constants/layout";
import { resolvePluginIcon } from "../icons";
import { useSidebarItemFrame } from "./frame";

function resolveIcon(icon: SidebarIcon) {
  return typeof icon === "string" ? resolvePluginIcon(icon) : icon;
}

type BarIconComponent = ComponentType<{ size: number; color: string }>;

function BarIconInner({
  Icon,
  size,
  color,
  large,
}: {
  Icon: BarIconComponent;
  size: number;
  color: string;
  large?: boolean;
}) {
  return <Icon size={large ? COMPACT_BAR_ICON_SIZE : size} color={color} />;
}
// Phone drawer: bigger glyphs than the 16px desktop ones, in a taller bar.
const COMPACT_BAR_ICON_SIZE = 24;
const MutedBarIcon = withUnistyles(BarIconInner, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));
const ActiveBarIcon = withUnistyles(BarIconInner, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foreground,
}));
function BarIcon({
  Icon,
  active,
  large,
}: {
  Icon: BarIconComponent;
  active: boolean;
  large: boolean;
}) {
  return active ? (
    <ActiveBarIcon Icon={Icon} large={large} />
  ) : (
    <MutedBarIcon Icon={Icon} large={large} />
  );
}

/**
 * An item may render several rows. Any press inside a row, on the row or on its trailing content,
 * makes that row the popover anchor: the capture-phase responder check runs before the pressed
 * child claims the touch (native and web), and returns false so the child still handles it.
 */
export function SidebarRow({ id, icon, label, onPress, active, trailing }: SidebarRowProps) {
  const frame = useSidebarItemFrame("SidebarRow");
  const isCompact = useIsCompactFormFactor();
  const { anchorTo, offerAnchor, releaseAnchor } = frame;
  const rowRef = useRef<View | null>(null);
  useEffect(() => {
    const node = rowRef.current;
    offerAnchor(node);
    return () => releaseAnchor(node);
  }, [offerAnchor, releaseAnchor]);
  const anchorHere = useCallback(() => {
    anchorTo(rowRef.current);
    return false;
  }, [anchorTo]);
  // Keyboard activation skips the responder system, so the row's own press anchors as well.
  const handlePress = useCallback(() => {
    anchorTo(rowRef.current);
    onPress();
  }, [anchorTo, onPress]);
  if (frame.bar) {
    const Icon = icon ? resolveIcon(icon) : null;
    return (
      <View ref={rowRef} collapsable={false} onStartShouldSetResponderCapture={anchorHere}>
        <Pressable
          style={isCompact ? styles.barButtonCompact : styles.barButton}
          testID={id ? `${frame.testID}-${id}` : frame.testID}
          accessibilityRole="button"
          accessibilityLabel={label ?? frame.title}
          onPress={handlePress}
        >
          {Icon ? <BarIcon Icon={Icon} active={Boolean(active)} large={isCompact} /> : null}
          {trailing ? (
            <View style={styles.barBadge} pointerEvents="none">
              {trailing}
            </View>
          ) : null}
        </Pressable>
      </View>
    );
  }
  return (
    <View ref={rowRef} collapsable={false} onStartShouldSetResponderCapture={anchorHere}>
      <SidebarHeaderRow
        icon={icon ? resolveIcon(icon) : null}
        label={label ?? frame.title}
        onPress={handlePress}
        isActive={active}
        trailing={trailing}
        testID={id ? `${frame.testID}-${id}` : frame.testID}
        variant={frame.section === "footer" ? "inline" : "compact"}
      />
    </View>
  );
}

/** The sidebar's separator line, run edge to edge across the section like the app's own. */
export function SidebarSeparator() {
  const frame = useSidebarItemFrame("SidebarSeparator");
  return (
    <View style={frame.section === "footer" ? styles.footer : styles.header}>
      <AppSidebarSeparator />
    </View>
  );
}

export interface SidebarReorderableListProps<T> {
  data: readonly T[];
  keyExtractor(item: T): string;
  renderItem(item: T, info: { isDragging: boolean }): ReactNode;
  onReorder(keys: string[]): void;
  onDragBegin?: () => void;
  testID?: string;
}

/**
 * プラグインのサイドバー行を並べ替え可能にする。アプリ標準の `DraggableList` をそのまま使うので、
 * 固定済み/プロジェクト一覧のドラッグと同じ操作感(Web=6px動かすと開始 / ネイティブ=長押し)になる。
 * スクロールはサイドバー本体に任せる(`scrollEnabled={false}`)。
 */
export function SidebarReorderableList<T>({
  data,
  keyExtractor,
  renderItem,
  onReorder,
  onDragBegin,
  testID,
}: SidebarReorderableListProps<T>) {
  const items = useMemo(() => [...data], [data]);
  const renderRow = useCallback(
    ({ item, isActive, drag, dragHandleProps }: DraggableRenderItemInfo<T>) => (
      <ReorderableRow drag={drag} dragHandleProps={dragHandleProps}>
        {renderItem(item, { isDragging: isActive })}
      </ReorderableRow>
    ),
    [renderItem],
  );
  const getKey = useCallback((item: T) => keyExtractor(item), [keyExtractor]);
  const handleDragEnd = useCallback(
    (next: T[]) => onReorder(next.map((item) => keyExtractor(item))),
    [keyExtractor, onReorder],
  );
  return (
    <DraggableList
      testID={testID}
      data={items}
      keyExtractor={getKey}
      renderItem={renderRow}
      onDragBegin={onDragBegin}
      onDragEnd={handleDragEnd}
      scrollEnabled={false}
      useDragHandle
    />
  );
}

/**
 * dnd-kit のリスナーを付けるラッパー。`attributes` の role/tabIndex は行の
 * アクセシビリティ(ボタン)と衝突するので、アプリの行と同じく落とす。
 */
function ReorderableRow({
  drag,
  dragHandleProps,
  children,
}: {
  drag: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  children: ReactNode;
}) {
  if (!dragHandleProps) {
    // ネイティブ: 行の Pressable がタッチを取るので、外側の長押しでドラッグを開始する。
    return (
      <Pressable onLongPress={drag} delayLongPress={180}>
        {children}
      </Pressable>
    );
  }
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps.attributes ?? {};
  // Web では React Native Web の View がドラッグ用の DOM イベント(onMouseDown 等)を転送しないため、
  // 素の div に付ける(実測 2026-10-25: View では onMouseDown が子に付かず、ドラッグが一切開始しなかった)。
  // 行の幅・高さは子が決める(div は幅いっぱいの通常のブロックなので行間は変わらない)。
  return (
    <div
      {...(dragAttributes as Record<string, unknown>)}
      {...(dragHandleProps.listeners ?? {})}
      ref={dragHandleProps.setActivatorNodeRef as unknown as (node: HTMLDivElement | null) => void}
    >
      {children}
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  barButton: {
    // Six of these plus the Settings gear share one line in a sidebar that can be 200px wide, so
    // 32 rather than 36 (192px of the 194px the line has at the default 234px sidebar width).
    width: 32,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  barButtonCompact: {
    width: 44,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  barBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.statusDanger,
  },
  // Header rows fill the sidebar width; the gap between them is 2px.
  header: {
    marginVertical: theme.spacing[1],
  },
  // The footer pads its rows by `spacing[2]` and spaces them `spacing[1]` apart.
  footer: {
    marginHorizontal: -theme.spacing[2],
    marginVertical: theme.spacing[0.5],
  },
}));
