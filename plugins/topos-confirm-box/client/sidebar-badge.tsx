/**
 * サイドバー行末の状態ラベル。
 *
 * ホストの `trailing` は `Pressable` の中で色を持たないので、中のテキストに色を書かないと
 * ブラウザ既定の黒になる(ライトでは見えるが、ダークでは背景に溶けて読めない=2026-10-23の不具合)。
 * 色は**状態ごとにこのファイルで固定**し、テーマに依存させない(起動時のテーマ推測が外れても読める)。
 *
 * 実測(WCAG比): 文字/帯 = 判断待ち5.0・実装中6.7・完了5.0・終了7.7(すべてAA 4.5以上)。
 * 帯/サイドバー背景 = ライト(#f4f4f5)で4.6〜7.0、ダーク(#141716)で2.3〜3.6(帯として判別できる)。
 */
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { StatusKind, StatusLabel } from "../shared/thread-status-label.js";

export const STATUS_STYLE: Record<StatusKind, { background: string; text: string }> = {
  waiting: { background: "#b45309", text: "#ffffff" }, // amber-700
  running: { background: "#1d4ed8", text: "#ffffff" }, // blue-700
  done: { background: "#15803d", text: "#ffffff" }, // green-700
  closed: { background: "#52525b", text: "#ffffff" }, // zinc-600
  // 動いていないが終わってもいないスレ(登録簿に載らないスレの待機)。実装中(青)と混ざらない灰色。
  idle: { background: "#e4e4e7", text: "#3f3f46" }, // zinc-200 / zinc-700(比 8.0)
};

type StatusLabelProps = StatusLabel & {
  testID?: string;
  /**
   * 押したときの動作。渡すと帯そのものがボタンになる(ピン/アーカイブの操作メニューの入口、
   * 2026-10-24 ユーザー指示)。渡さない行の帯は従来どおり表示だけ(行の押下は行本体が担う)。
   */
  onPress?: () => void;
};

/** 状態の帯。文字色は必ずここで与える(親の色を継承させない)。 */
export function StatusBadge({ text, kind, testID, onPress }: StatusLabelProps) {
  const tone = STATUS_STYLE[kind];
  const boxStyle = useMemo(() => [styles.badge, { backgroundColor: tone.background }], [tone]);
  const labelStyle = useMemo(() => [styles.text, { color: tone.text }], [tone]);
  // `style` に毎回新しい関数を渡さない(react-perf)ので、押下時の見た目はフックで1つ作る
  // (フックは早期 return より前で呼ぶ)。
  const pressableStyle = usePressableStyle(boxStyle);
  const label = (
    <Text style={labelStyle} numberOfLines={1}>
      {text}
    </Text>
  );
  if (!onPress) {
    return (
      <View testID={testID} accessible accessibilityLabel={`状態: ${text}`} style={boxStyle}>
        {label}
      </View>
    );
  }
  // 帯の押下でメニューを開く。タッチ端末の当たり判定が細くなりすぎないよう最小高さを持たせる。
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`状態: ${text}(押すとピン止め・アーカイブのメニュー)`}
      onPress={onPress}
      hitSlop={6}
      style={pressableStyle}
    >
      {label}
    </Pressable>
  );
}

/**
 * 行末の「⋯」ボタン。ピン止め・アーカイブのメニューを開く常時見えるボタン
 * (帯を押さないとメニューが出ないのは気づけない、という指摘: 台帳 ui-abf449bfaa)。
 */
export function MenuButton({ testID, onPress }: { testID?: string; onPress: () => void }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="ピン止め・アーカイブのメニューを開く"
      onPress={onPress}
      hitSlop={6}
      style={styles.menuButton}
    >
      <Text style={styles.menuGlyph}>⋯</Text>
    </Pressable>
  );
}

/** `Pressable` の style プロパティ用(押下中だけ薄くする)。 */
function usePressableStyle(base: object): (state: { pressed: boolean }) => object | object[] {
  return useMemo(() => (state) => (state.pressed ? [base, styles.pressed] : base), [base]);
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    // 状態名が長くても行末で抑え、題名の幅を食い尽くさない
    maxWidth: 110,
  },
  text: {
    // 11pxでは読めないという指摘が3回(台帳 ui-be238b34bf)。13pxに上げる。
    fontSize: 13,
    fontWeight: "700",
  },
  menuButton: {
    minWidth: 24,
    minHeight: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  menuGlyph: {
    fontSize: 16,
    fontWeight: "700",
    color: "#52525b",
  },
  pressed: {
    opacity: 0.6,
  },
});
