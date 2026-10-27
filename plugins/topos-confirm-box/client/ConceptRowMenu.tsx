/**
 * 構想一覧の行の操作メニュー(行末の「⋯」を押すと、その行のすぐ下に開く小さな浮きパネル)。
 *
 * 2026-10-24 ユーザー指示「今は見たくない構想を寝かせたい」向けに、「あとで」/「検討中に戻す」を
 * 1項目だけ出す。見た目は既存のスレ行メニュー(`client/ThreadMenu.tsx`)に揃えた
 * (PC で全画面にならず、行のすぐ下で選べる)。
 *
 * `SidebarRow` の右端(`trailing`)は行の押下領域とは別に押せるので、入口はそこに置く。
 */
import { useMemo } from "react";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { deferMenuLabel } from "../shared/concept-row.js";
import type { ConceptZone } from "../shared/concept-places.js";

type SidebarColors = PluginSidebarItemProps["theme"]["colors"];

/** 行末の入口(⋯)。`moving` の間は回転中の印を出す。 */
export function ConceptMenuButton({
  title,
  open,
  moving,
  color,
  onPress,
}: {
  title: string;
  open: boolean;
  moving: boolean;
  color: string;
  onPress: () => void;
}) {
  const style = useMemo(() => ({ color }), [color]);
  return (
    <Pressable
      testID="concept-row-menu-button"
      accessibilityRole="button"
      accessibilityLabel={`${title}の操作(あとで/検討中に戻す)`}
      aria-expanded={open}
      hitSlop={6}
      onPress={onPress}
      style={styles.hit}
    >
      {moving ? (
        <ActivityIndicator size="small" />
      ) : (
        <Icon name="Ellipsis" size={16} color={style.color} />
      )}
    </Pressable>
  );
}

/** メニュー本体。開いていない間は何も出さない。 */
export function ConceptRowMenu({
  zone,
  title,
  busy,
  colors,
  onMove,
  onThread,
  movable,
}: {
  zone: ConceptZone;
  /** 行に出ている題名(読み上げの文言に使う)。 */
  title: string;
  busy: boolean;
  colors: SidebarColors;
  onMove: () => void;
  /** 壁打ち(深掘りスレを開く/作る)。 */
  onThread: () => void;
  /** 「あとで/検討中」へ移せる行か。 */
  movable: boolean;
}) {
  const panelStyle = useMemo(
    () => [styles.panel, { backgroundColor: colors.surface1, borderColor: colors.border }],
    [colors],
  );
  const textStyle = useMemo(() => [styles.itemText, { color: colors.foreground }], [colors]);
  const noteStyle = useMemo(() => [styles.noteText, { color: colors.foregroundMuted }], [colors]);
  return (
    <View testID="concept-row-menu" style={panelStyle}>
      <Pressable
        testID="concept-row-menu-thread"
        accessibilityRole="button"
        accessibilityLabel={`${title}を壁打ちする`}
        onPress={onThread}
        style={styles.item}
      >
        <Text style={textStyle}>壁打ちする(スレを開く)</Text>
      </Pressable>
      {movable ? (
        <MoveItems
          zone={zone}
          title={title}
          busy={busy}
          onMove={onMove}
          textStyle={textStyle}
          noteStyle={noteStyle}
        />
      ) : null}
    </View>
  );
}

function MoveItems({
  zone,
  title,
  busy,
  onMove,
  textStyle,
  noteStyle,
}: {
  zone: ConceptZone;
  title: string;
  busy: boolean;
  onMove: () => void;
  textStyle: object;
  noteStyle: object;
}) {
  if (busy) return <Text style={noteStyle}>移しています…</Text>;
  return (
    <>
      <Pressable
        testID="concept-row-menu-defer"
        accessibilityRole="button"
        accessibilityLabel={`${title}を${deferMenuLabel(zone)}`}
        onPress={onMove}
        style={styles.item}
      >
        <Text style={textStyle}>{deferMenuLabel(zone)}</Text>
      </Pressable>
      <Text style={noteStyle}>
        {zone === "active"
          ? "検討中の一覧から外して「あとで」へ移します(Vault の Paseo/構想)"
          : "「検討中」の一覧へ戻します(Vault の Paseo/構想)"}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  hit: { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" },
  // 純正のドロップダウンに合わせた小さな浮きパネル(行の直下・サイドバー幅に収まる)
  panel: {
    marginHorizontal: 8,
    marginTop: 2,
    marginBottom: 4,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 8,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  item: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 6,
    marginHorizontal: 4,
  },
  itemText: { fontSize: 13 },
  noteText: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
});
