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
import { StyleSheet, Text, View } from "react-native";
import type { StatusKind, StatusLabel } from "../shared/thread-status-label.js";

export const STATUS_STYLE: Record<StatusKind, { background: string; text: string }> = {
  waiting: { background: "#b45309", text: "#ffffff" }, // amber-700
  running: { background: "#1d4ed8", text: "#ffffff" }, // blue-700
  done: { background: "#15803d", text: "#ffffff" }, // green-700
  closed: { background: "#52525b", text: "#ffffff" }, // zinc-600
};

type StatusLabelProps = StatusLabel & { testID?: string };

/** 状態の帯。文字色は必ずここで与える(親の色を継承させない)。 */
export function StatusBadge({ text, kind, testID }: StatusLabelProps) {
  const tone = STATUS_STYLE[kind];
  const boxStyle = useMemo(() => [styles.badge, { backgroundColor: tone.background }], [tone]);
  const labelStyle = useMemo(() => [styles.text, { color: tone.text }], [tone]);
  return (
    <View testID={testID} accessible accessibilityLabel={`状態: ${text}`} style={boxStyle}>
      <Text style={labelStyle} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    // 状態名が長くても行末で抑え、題名の幅を食い尽くさない
    maxWidth: 96,
  },
  text: {
    fontSize: 11,
    fontWeight: "600",
  },
});
