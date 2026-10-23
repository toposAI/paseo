/**
 * サイドバー行の操作メニュー(状態の帯を押すと開くポップアップ)。
 *
 * 行末のピン/アーカイブのアイコンは廃止し、状態の帯(`child-thread-status-*`)そのものを入口にした
 * (2026-10-24 ユーザー指示)。`Alert.alert` は Web/iOS で見た目が揃わないので、プラグイン向けに
 * 露出しているホストの `Modal`(`@getpaseo/plugin/client/react-native`)を使う。
 *
 * 状態遷移(アーカイブの2段階確認)は `shared/thread-menu.ts` の純粋関数が正で、ここは描画だけ。
 */
import { useCallback, useMemo } from "react";
import { Modal } from "@getpaseo/plugin/client/react-native";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChildThread } from "../shared/child-threads.js";
import {
  archiveMenuLabel,
  pinMenuLabel,
  type ThreadMenuAction,
  type ThreadMenuState,
} from "../shared/thread-menu.js";

type SidebarColors = PluginSidebarItemProps["theme"]["colors"];

export interface ThreadMenuProps {
  thread: ChildThread;
  state: ThreadMenuState;
  colors: SidebarColors;
  /** 状態遷移を親へ返す(親が `nextMenu` で次状態を決め、実行すべき副作用を走らせる)。 */
  onAction: (action: ThreadMenuAction) => void;
}

/**
 * メニュー本体。開いていない間は何も出さない。題名はアクセシビリティ用にだけ持たせ、
 * 画面側でどれのメニューか分かるようにする。
 */
export function ThreadMenu({ thread, state, colors, onAction }: ThreadMenuProps) {
  const onOpenChange = useCallback(
    (open: boolean) => {
      // 背景タップ・戻る・×で閉じたときも「閉じる」と同じ意味(確認は捨てる)
      if (!open) onAction("close");
    },
    [onAction],
  );
  const close = useCallback(() => onAction("close"), [onAction]);
  const togglePin = useCallback(() => onAction("toggle-pin"), [onAction]);
  const archive = useCallback(() => onAction("archive"), [onAction]);
  const openThread = useCallback(() => onAction("open-thread"), [onAction]);

  const bodyStyle = useMemo(() => ({ backgroundColor: colors.surface1 }), [colors]);
  const itemStyle = useMemo(
    () => [styles.item, { borderColor: colors.border, backgroundColor: colors.surface2 }],
    [colors],
  );
  const labelStyle = useMemo(() => ({ color: colors.foreground }), [colors]);
  const mutedStyle = useMemo(() => ({ color: colors.foregroundMuted }), [colors]);
  const openTextStyle = useMemo(() => [styles.itemText, labelStyle], [labelStyle]);
  const closeTextStyle = useMemo(() => [styles.itemText, mutedStyle], [mutedStyle]);
  const dangerStyle = useMemo(() => [styles.item, { borderColor: "#b91c1c" }], []);
  const dangerTextStyle = useMemo(() => ({ color: "#b91c1c", fontWeight: "600" as const }), []);
  // 確認待ち(1回目)のときだけ背景を薄赤にする。2回目で押せることは文言で示す
  const archiveStyle = useMemo(
    () => (state.confirmingArchive ? [dangerStyle, styles.dangerArmed] : itemStyle),
    [dangerStyle, itemStyle, state.confirmingArchive],
  );
  const archiveTextStyle = useMemo(
    () =>
      state.confirmingArchive ? [styles.itemText, labelStyle, dangerTextStyle] : openTextStyle,
    [dangerTextStyle, labelStyle, openTextStyle, state.confirmingArchive],
  );
  const pinTextStyle = useMemo(
    () => (thread.pinned ? [styles.itemText, labelStyle, styles.itemTextStrong] : openTextStyle),
    [labelStyle, openTextStyle, thread.pinned],
  );

  return (
    <Modal
      title={thread.title}
      open={state.open}
      onOpenChange={onOpenChange}
      // 題名にスレ側の古い値を混ぜない: ノートの題名は呼び出し元が決める(ここはスレの題名)
    >
      <Modal.Content style={bodyStyle} contentContainerStyle={styles.content} scrollable={false}>
        <View testID={`child-thread-menu-${thread.agentId}`} style={styles.items}>
          <MenuItem
            testID={`child-thread-menu-pin-${thread.agentId}`}
            label={pinMenuLabel(thread.pinned)}
            accessibilityLabel={
              thread.pinned ? `${thread.title}のピン止めを外す` : `${thread.title}をピン止め`
            }
            style={itemStyle}
            textStyle={pinTextStyle}
            onPress={togglePin}
          />
          <MenuItem
            testID={`child-thread-menu-archive-${thread.agentId}`}
            label={archiveMenuLabel(state.confirmingArchive)}
            accessibilityLabel={
              state.confirmingArchive
                ? `${thread.title}をアーカイブする(もう一度押す)`
                : `${thread.title}をアーカイブ`
            }
            style={archiveStyle}
            textStyle={archiveTextStyle}
            onPress={archive}
          />
          <MenuItem
            testID={`child-thread-menu-open-${thread.agentId}`}
            label="スレを開く"
            accessibilityLabel={`${thread.title}を開く`}
            style={itemStyle}
            textStyle={openTextStyle}
            onPress={openThread}
          />
          <MenuItem
            testID={`child-thread-menu-close-${thread.agentId}`}
            label="閉じる"
            accessibilityLabel="メニューを閉じる"
            style={styles.closeItem}
            textStyle={closeTextStyle}
            onPress={close}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/**
 * 項目の押下時の見た目。`Pressable` の `style` に毎回新しい関数を渡さないようモジュール定数にする
 * (react-perf の jsx-no-new-function-as-prop)。
 */
function pressedStyle(style: object): (state: { pressed: boolean }) => object | object[] {
  return (state) => (state.pressed ? [style, styles.pressed] : style);
}

function MenuItem({
  testID,
  label,
  accessibilityLabel,
  style,
  textStyle,
  onPress,
}: {
  testID: string;
  label: string;
  accessibilityLabel: string;
  style: object;
  textStyle: object;
  onPress: () => void;
}) {
  const pressStyle = useMemo(() => pressedStyle(style), [style]);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={pressStyle}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 12,
    gap: 8,
    // 行の中身ではなくメニューだけを出す(外側の余白はモーダル側が持つ)
    justifyContent: "flex-start",
  },
  items: {
    gap: 8,
  },
  item: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 10,
  },
  dangerArmed: {
    backgroundColor: "#fee2e2",
  },
  closeItem: {
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  pressed: {
    opacity: 0.6,
  },
  itemText: {
    fontSize: 15,
  },
  itemTextStrong: {
    fontWeight: "600",
  },
});
