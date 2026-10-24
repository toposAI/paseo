/**
 * サイドバー行の操作メニュー(状態の帯を押すと、その行のすぐ下に開くドロップダウン)。
 *
 * 行末のピン/アーカイブのアイコンは廃止し、状態の帯(`child-thread-status-*`)そのものを入口にした
 * (2026-10-24 ユーザー指示)。当初は `Modal` だったが PC で全画面になり使いづらいため、
 * 純正 Paseo のメニューに寄せた小さな浮きパネルにした(2026-10-24 ユーザー指示)。
 * プラグイン SDK の `openPopover` は項目全体(サイドバーのスレ一覧そのもの)に固定され、
 * 押した帯には固定できないので、行の直下にパネルを差し込む形にしている。
 *
 * 状態遷移(アーカイブの2段階確認)は `shared/thread-menu.ts` の純粋関数が正で、ここは描画だけ。
 */
import { useCallback, useMemo } from "react";
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
  /** 行に出ている題名(ノートがあればノートの題名)。アクセシビリティ文言に使う。 */
  title: string;
  state: ThreadMenuState;
  /**
   * アーカイブ項目を出すか。司令塔(子を持つ行)は false(誤って親を畳まない安全側。
   * 2026-10-24 子司令塔の決定)。項目ごと出さないので、確認の2回目にも届かない。
   */
  canArchive?: boolean;
  colors: SidebarColors;
  /** 状態遷移を親へ返す(親が `nextMenu` で次状態を決め、実行すべき副作用を走らせる)。 */
  onAction: (action: ThreadMenuAction) => void;
}

/** メニュー本体。開いていない間は何も出さない。 */
export function ThreadMenu({
  thread,
  title,
  state,
  canArchive = true,
  colors,
  onAction,
}: ThreadMenuProps) {
  const togglePin = useCallback(() => onAction("toggle-pin"), [onAction]);
  const archive = useCallback(() => onAction("archive"), [onAction]);
  const openThread = useCallback(() => onAction("open-thread"), [onAction]);

  const panelStyle = useMemo(
    () => [styles.panel, { backgroundColor: colors.surface1, borderColor: colors.border }],
    [colors],
  );
  const labelStyle = useMemo(() => ({ color: colors.foreground }), [colors]);
  const mutedStyle = useMemo(() => ({ color: colors.foregroundMuted }), [colors]);
  const textStyle = useMemo(() => [styles.itemText, labelStyle], [labelStyle]);
  const noteStyle = useMemo(() => [styles.noteText, mutedStyle], [mutedStyle]);
  const pinTextStyle = useMemo(
    () => (thread.pinned ? [styles.itemText, labelStyle, styles.itemTextStrong] : textStyle),
    [labelStyle, textStyle, thread.pinned],
  );
  // 確認待ち(1回目)のときだけ赤く塗る。2回目で実行されることは文言で示す
  const archiveStyle = useMemo(
    () => (state.confirmingArchive ? [styles.item, styles.dangerArmed] : styles.item),
    [state.confirmingArchive],
  );
  const archiveTextStyle = useMemo(
    () => (state.confirmingArchive ? [styles.itemText, styles.dangerText] : textStyle),
    [state.confirmingArchive, textStyle],
  );

  if (!state.open) return null;
  return (
    <View testID={`child-thread-menu-${thread.agentId}`} style={panelStyle}>
      <MenuItem
        testID={`child-thread-menu-pin-${thread.agentId}`}
        label={pinMenuLabel(thread.pinned)}
        accessibilityLabel={thread.pinned ? `${title}のピン止めを外す` : `${title}をピン止め`}
        style={styles.item}
        textStyle={pinTextStyle}
        onPress={togglePin}
      />
      {canArchive ? (
        <MenuItem
          testID={`child-thread-menu-archive-${thread.agentId}`}
          label={archiveMenuLabel(state.confirmingArchive)}
          accessibilityLabel={
            state.confirmingArchive
              ? `${title}をアーカイブする(もう一度押す)`
              : `${title}をアーカイブ`
          }
          style={archiveStyle}
          textStyle={archiveTextStyle}
          onPress={archive}
        />
      ) : (
        // 司令塔の行にアーカイブが出ない理由を1行だけ示す(消えた理由を聞き返さずに済む)
        <Text testID={`child-thread-menu-archive-hidden-${thread.agentId}`} style={noteStyle}>
          司令塔のスレはアーカイブできません
        </Text>
      )}
      <MenuItem
        testID={`child-thread-menu-open-${thread.agentId}`}
        label="スレを開く"
        accessibilityLabel={`${title}を開く`}
        style={styles.item}
        textStyle={textStyle}
        onPress={openThread}
      />
    </View>
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
  dangerArmed: {
    backgroundColor: "#fee2e2",
  },
  dangerText: {
    color: "#b91c1c",
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.6,
  },
  itemText: {
    fontSize: 13,
  },
  itemTextStrong: {
    fontWeight: "600",
  },
  noteText: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
});
