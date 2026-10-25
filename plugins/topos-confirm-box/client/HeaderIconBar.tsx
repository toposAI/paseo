/**
 * 確認箱の画面の最上部に置く、画面切替のアイコン列+更新ボタン(2026-10-25 ユーザー依頼)。
 *
 * 下部バーから「ユーザー判断」「子スレ完了」「バグ報告」を開いた画面で、**どの画面へも1タップで移れる**ように、
 * 5つの画面(ユーザー判断・子スレ完了・バグ報告・通知・優先順位)をアイコンだけで並べる。現在の画面は強調し、
 * 件数のあるものは右上にバッジを付ける。更新ボタンは同じ行の右端(旧: 一覧の下の行に孤立していた)。
 * アイコンだけで意味が分かるよう、各ボタンに accessibilityLabel(名前+件数)を付ける。
 */
import { useCallback, useMemo } from "react";
import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { BellIcon, BugIcon, CheckCircleIcon, InboxIcon, ListIcon } from "./Icons.js";
import { ReloadButton } from "./ReloadButton.js";

export type HeaderTabId = "items" | "childdone" | "bugs" | "notify" | "priority";

/** 並びは下部バーと同じ順(ユーザー判断 → 子スレ完了 → バグ報告)の後ろに 通知・優先順位。 */
export const HEADER_TABS: {
  id: HeaderTabId;
  label: string;
  Icon: ComponentType<{ color: string; size?: number }>;
}[] = [
  { id: "items", label: "ユーザー判断", Icon: InboxIcon },
  { id: "childdone", label: "子スレ完了", Icon: CheckCircleIcon },
  { id: "bugs", label: "バグ報告", Icon: BugIcon },
  { id: "notify", label: "通知", Icon: BellIcon },
  { id: "priority", label: "優先順位", Icon: ListIcon },
];

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

type BarColors = Pick<
  PluginTheme["colors"],
  | "accent"
  | "accentForeground"
  | "border"
  | "foreground"
  | "foregroundMuted"
  | "statusWarning"
  | "surface1"
  | "surface2"
>;

function HeaderTab({
  tab,
  on,
  count,
  colors,
  onSelect,
}: {
  tab: (typeof HEADER_TABS)[number];
  on: boolean;
  count: number;
  colors: BarColors;
  onSelect: (id: HeaderTabId) => void;
}) {
  const press = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
  const label = count > 0 ? `${tab.label}(${count})` : tab.label;
  const s = useMemo(
    () => ({
      btn: {
        width: 44,
        height: 44,
        borderRadius: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: on ? colors.surface2 : "transparent",
      },
      icon: {
        width: 24,
        height: 24,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      badge: {
        position: "absolute" as const,
        top: -7,
        right: -9,
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 4,
        backgroundColor: colors.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      badgeText: { color: colors.accentForeground, fontSize: 10, fontWeight: "700" as const },
    }),
    [on, colors],
  );
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={on ? SELECTED : UNSELECTED}
      style={s.btn}
      onPress={press}
    >
      <View style={s.icon}>
        <tab.Icon color={on ? colors.accent : colors.foregroundMuted} size={22} />
        {count > 0 ? (
          <View style={s.badge}>
            <Text style={s.badgeText} numberOfLines={1}>
              {count > 99 ? "99+" : count}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** 画面ごとの絞り込み切替(確認済み/完了済みを出す・隠す)。更新ボタンの左に出す。 */
export interface HeaderToggle {
  label: string;
  a11y: string;
  onPress: () => void;
}

export type ToggleInfo = Omit<HeaderToggle, "onPress">;

export function HeaderIconBar({
  active,
  counts,
  colors,
  onSelect,
  onRefresh,
  toggle,
  touch,
}: {
  active: HeaderTabId;
  counts: Partial<Record<HeaderTabId, number>>;
  colors: BarColors;
  onSelect: (id: HeaderTabId) => void;
  onRefresh: () => Promise<boolean>;
  toggle?: HeaderToggle | null;
  /** タッチ幅(iPhone 等)。行を少し高くして押しやすくする。 */
  touch: boolean;
}) {
  const s = useMemo(
    () => ({
      bar: {
        flexDirection: "row" as const,
        flexWrap: "nowrap" as const,
        alignItems: "center" as const,
        paddingHorizontal: 8,
        paddingVertical: touch ? 10 : 8,
        gap: 4,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
      },
      // 更新ボタンは右端。狭い幅でもアイコン列を折り返さない(各ボタンは縮めない)。
      reload: { flexShrink: 0, paddingLeft: 4 },
      // 切替ボタンは更新ボタンの左。幅が足りない時はこれだけ縮める(アイコン列は折り返さない)。
      toggle: {
        marginLeft: "auto" as const,
        flexShrink: 1,
        minWidth: 0,
        backgroundColor: colors.surface2,
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 8,
      },
      toggleText: { color: colors.foreground, fontSize: 12 },
      spacer: { flex: 1 },
    }),
    [colors.border, colors.surface1, colors.surface2, colors.foreground, touch],
  );
  return (
    <View style={s.bar} accessibilityRole="tablist">
      {HEADER_TABS.map((tab) => (
        <HeaderTab
          key={tab.id}
          tab={tab}
          on={active === tab.id}
          count={counts[tab.id] ?? 0}
          colors={colors}
          onSelect={onSelect}
        />
      ))}
      {toggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toggle.a11y}
          style={s.toggle}
          onPress={toggle.onPress}
          testID="header-toggle"
        >
          <Text style={s.toggleText} numberOfLines={1}>
            {toggle.label}
          </Text>
        </Pressable>
      ) : (
        <View style={s.spacer} />
      )}
      <View style={s.reload}>
        <ReloadButton colors={colors} onRefresh={onRefresh} testID="header-reload" />
      </View>
    </View>
  );
}
