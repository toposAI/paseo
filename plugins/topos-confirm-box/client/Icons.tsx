/**
 * 確認箱用のフラットアイコン(絵文字は使わない)。プラグインAPIにアイコン部品が無いため
 * View の組み合わせで描く。色は呼び出し側が渡す単色。
 */
import { useMemo } from "react";
import { View } from "react-native";

interface IconProps {
  color: string;
  size?: number;
}

export function InboxIcon({ color, size = 24 }: IconProps) {
  const st = useMemo(
    () => ({
      box: {
        width: size,
        height: size * 0.75,
        borderWidth: 2,
        borderColor: color,
        borderRadius: 4,
        justifyContent: "center" as const,
        alignItems: "center" as const,
      },
      slot: { width: size * 0.45, height: 2, backgroundColor: color, borderRadius: 1 },
    }),
    [color, size],
  );
  return (
    <View style={st.box}>
      <View style={st.slot} />
    </View>
  );
}

export function ListIcon({ color, size = 24 }: IconProps) {
  const st = useMemo(
    () => ({
      wrap: { width: size, gap: size * 0.16 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: size * 0.14 },
      dot: {
        width: size * 0.16,
        height: size * 0.16,
        borderRadius: size * 0.08,
        backgroundColor: color,
      },
      bar: { flex: 1, height: 2.5, borderRadius: 1.25, backgroundColor: color },
    }),
    [color, size],
  );
  return (
    <View style={st.wrap}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={st.row}>
          <View style={st.dot} />
          <View style={st.bar} />
        </View>
      ))}
    </View>
  );
}

/** 吹き出し(塗り単色+左下のしっぽ)。 */
export function BubbleIcon({ color, size = 24 }: IconProps) {
  const st = useMemo(
    () => ({
      wrap: { width: size, height: size },
      body: {
        position: "absolute" as const,
        left: 0,
        top: 0,
        width: size,
        height: size * 0.78,
        borderRadius: size * 0.28,
        backgroundColor: color,
      },
      tail: {
        position: "absolute" as const,
        left: size * 0.18,
        top: size * 0.66,
        width: 0,
        height: 0,
        borderTopWidth: size * 0.3,
        borderTopColor: color,
        borderRightWidth: size * 0.26,
        borderRightColor: "transparent",
      },
    }),
    [color, size],
  );
  return (
    <View style={st.wrap}>
      <View style={st.body} />
      <View style={st.tail} />
    </View>
  );
}
