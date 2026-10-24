/**
 * サイドバー行の操作メニュー(**他の行の位置を動かさない**小さなポップアップの中身)。
 *
 * 行末のピン/アーカイブのアイコンは廃止し、状態の帯(`child-thread-status-*`)そのものを入口にした
 * (2026-10-24 ユーザー指示)。当初は `Modal` で全画面、続いて行の直下に差し込むドロップダウンに
 * したが、**開くたびに下の行を押し下げてサイドバーに割り込む**とユーザーから指摘された
 * (2026-10-24)。いまはホストの `openPopover`(`client/ChildThreadsSidebar.tsx` の `onMenuOpen`)に
 * この中身を渡し、**サイドバーの一覧の外**(PC=押した行の右横の浮きパネル、スマホ=ホスト標準の
 * ボトムシート)に出す。一覧のレイアウトには一切参加しないので、開いても他の行は動かない。
 * 外側タップ/Esc/戻るでの閉じはホストが付けてくれる(こちらは `onClose` を渡すだけ)。
 *
 * 状態遷移(アーカイブの2段階確認)は `shared/thread-menu.ts` の純粋関数が正で、ここは描画と
 * 「押されたら次の状態へ」だけ。副作用(ピンの保存・アーカイブ実行・スレを開く)は親へ返す。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChildThread } from "../shared/child-threads.js";
import {
  OPEN_MENU,
  archiveMenuLabel,
  nextMenu,
  pinMenuLabel,
  type ThreadMenuAction,
  type ThreadMenuIntent,
  type ThreadMenuState,
} from "../shared/thread-menu.js";

type SidebarColors = PluginSidebarItemProps["theme"]["colors"];

/** 項目の高さ。スマホ(タッチ)では指で押しやすい高さにする(PC は純正メニュー寄りの詰まった行)。 */
const ITEM_HEIGHT = { wide: 32, compact: 44 };

export interface ThreadMenuProps {
  thread: ChildThread;
  /** 行に出ている題名(ノートがあればノートの題名)。読み上げ文言に使う。 */
  title: string;
  /**
   * アーカイブ項目を出すか。司令塔(子を持つ行)は false(誤って親を畳まない安全側。
   * 2026-10-24 子司令塔の決定)。項目ごと出さないので、確認の2回目にも届かない。
   */
  canArchive?: boolean;
  colors: SidebarColors;
  /** スマホ幅(タッチ)か。項目の高さを変える。 */
  compact?: boolean;
  /** 実行すべき副作用を親へ返す(状態遷移はこの中で決める)。 */
  onAction: (intent: ThreadMenuIntent) => void;
  /** ポップアップを閉じる(ホストが渡す `close`)。 */
  onClose: () => void;
  /**
   * 閉じる手段を親へ登録する(タブ切替・一覧からの消滅で親から閉じるため)。
   * アンマウント時に null で解除する。
   */
  registerClose?: (close: (() => void) | null) => void;
}

/** ポップアップの中身。開いた時点で `OPEN_MENU`(確認待ちは無し)から始まる。 */
export function ThreadMenu({
  thread,
  title,
  canArchive = true,
  colors,
  compact = false,
  onAction,
  onClose,
  registerClose,
}: ThreadMenuProps) {
  const [state, setState] = useState<ThreadMenuState>(OPEN_MENU);

  // 親(サイドバー)から閉じられるようにする。外側タップ/Esc でホストが閉じたときは
  // アンマウントになるので、ここで解除される(古い close を掴んだままにしない)。
  useEffect(() => {
    registerClose?.(onClose);
    return () => registerClose?.(null);
  }, [onClose, registerClose]);

  /**
   * 項目が押された。状態遷移は純粋関数(`nextMenu`)が正で、実行すべき副作用だけを親へ返す。
   * 閉じる遷移のときは先にポップアップを閉じる(アーカイブの2回目・ピン・スレを開く)。
   */
  const run = useCallback(
    (action: ThreadMenuAction) => {
      const step = nextMenu(state, action);
      setState(step.state);
      if (!step.state.open) onClose();
      if (step.intent) onAction(step.intent);
    },
    [state, onAction, onClose],
  );
  const togglePin = useCallback(() => run("toggle-pin"), [run]);
  const archive = useCallback(() => run("archive"), [run]);
  const openThread = useCallback(() => run("open-thread"), [run]);

  const itemStyle = useMemo(
    () => [styles.item, { minHeight: compact ? ITEM_HEIGHT.compact : ITEM_HEIGHT.wide }],
    [compact],
  );
  // 押下中の見た目(純正メニューと同じく、押している間だけ背景を敷く)。
  const pressedItemStyle = useMemo(() => [itemStyle, styles.pressed], [itemStyle]);
  const pressedPinStyle = useMemo(
    () => [itemStyle, styles.pressed, thread.pinned ? styles.itemStrong : null],
    [itemStyle, thread.pinned],
  );
  // 確認待ち(1回目)のときだけ赤く塗る。2回目で実行されることは文言で示す。
  const archiveItemStyle = useMemo(
    () =>
      state.confirmingArchive
        ? [itemStyle, styles.dangerArmed]
        : itemStyle,
    [itemStyle, state.confirmingArchive],
  );
  const pressedArchiveStyle = useMemo(
    () => [archiveItemStyle, styles.pressed],
    [archiveItemStyle],
  );
  const labelStyle = useMemo(() => ({ color: colors.foreground }), [colors]);
  const mutedStyle = useMemo(() => ({ color: colors.foregroundMuted }), [colors]);
  const textStyle = useMemo(() => [styles.itemText, labelStyle], [labelStyle]);
  const noteStyle = useMemo(() => [styles.noteText, mutedStyle], [mutedStyle]);
  const pinTextStyle = useMemo(
    () => (thread.pinned ? [styles.itemText, labelStyle, styles.itemStrong] : textStyle),
    [labelStyle, textStyle, thread.pinned],
  );
  const archiveTextStyle = useMemo(
    () => (state.confirmingArchive ? [styles.itemText, styles.dangerText] : textStyle),
    [state.confirmingArchive, textStyle],
  );

  return (
    <View testID={`child-thread-menu-${thread.agentId}`} style={styles.menu}>
      <MenuItem
        testID={`child-thread-menu-pin-${thread.agentId}`}
        label={pinMenuLabel(thread.pinned)}
        accessibilityLabel={thread.pinned ? `${title}のピン止めを外す` : `${title}をピン止め`}
        style={itemStyle}
        pressedStyle={pressedPinStyle}
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
          style={archiveItemStyle}
          pressedStyle={pressedArchiveStyle}
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
        style={itemStyle}
        pressedStyle={pressedItemStyle}
        textStyle={textStyle}
        onPress={openThread}
      />
    </View>
  );
}

/**
 * 項目の押下時の見た目。`Pressable` の `style` に毎回新しい関数を渡さないよう
 * モジュール側で組み立てる(react-perf の jsx-no-new-function-as-prop)。
 */
function MenuItem({
  testID,
  label,
  accessibilityLabel,
  style,
  pressedStyle,
  textStyle,
  onPress,
}: {
  testID: string;
  label: string;
  accessibilityLabel: string;
  style: object;
  pressedStyle: object;
  textStyle: object;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => (pressed ? pressedStyle : style)}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 背景・枠・影はホストのポップアップ面が持つ。ここは項目を縦に並べるだけ。
  menu: {
    minWidth: 180,
  },
  item: {
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  pressed: {
    backgroundColor: "rgba(127,127,127,0.18)",
  },
  itemStrong: {
    fontWeight: "600",
  },
  dangerArmed: {
    backgroundColor: "#fee2e2",
  },
  dangerText: {
    color: "#b91c1c",
    fontWeight: "600",
  },
  itemText: {
    fontSize: 13,
  },
  noteText: {
    fontSize: 12,
    paddingVertical: 6,
  },
});
