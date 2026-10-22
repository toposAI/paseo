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

/**
 * 虫(バグ報告)。**家族版/試用版 Topos のバグ報告ボタンと同じ形**(`m.html` の
 * `#hdr-bug-btn` のインラインSVGを、この画面の他のアイコンと同じ View 描画へ写したもの)。
 * 元のSVG(`viewBox 0 0 24 24`・stroke 1.7・塗りなし):
 *   M9 7a3 3 0 016 0 / rect x7 y7 w10 h12 rx5 / M12 11v8M7 12H4M17 12h3M7 16H5M17 16h2M8 8L6 6M16 8l2-2
 * 線幅と比率は元のまま(size/24 倍)。
 */
export function BugIcon({ color, size = 24 }: IconProps) {
  const u = size / 24;
  const st = useMemo(() => {
    const line = (left: number, top: number, width: number, height: number) => ({
      position: "absolute" as const,
      left: left * u,
      top: top * u,
      width: width * u,
      height: height * u,
      backgroundColor: color,
      borderRadius: (Math.min(width, height) * u) / 2,
    });
    return {
      wrap: { width: size, height: size },
      // 胴体(角丸の矩形)
      body: {
        position: "absolute" as const,
        left: 7 * u,
        top: 7 * u,
        width: 10 * u,
        height: 12 * u,
        borderWidth: 1.7 * u,
        borderColor: color,
        borderRadius: 5 * u,
      },
      // 頭の上の弧(M9 7a3 3 0 016 0)= 上半分の半円
      head: {
        position: "absolute" as const,
        left: 9 * u,
        top: 4 * u,
        width: 6 * u,
        height: 3 * u,
        borderWidth: 1.7 * u,
        borderBottomWidth: 0,
        borderColor: color,
        borderTopLeftRadius: 3 * u,
        borderTopRightRadius: 3 * u,
      },
      spine: line(11.15, 11, 1.7, 8),
      legL1: line(4, 11.15, 3, 1.7),
      legL2: line(5, 15.15, 2, 1.7),
      legR1: line(17, 11.15, 3, 1.7),
      legR2: line(17, 15.15, 2, 1.7),
      // 触角は元の path `M8 8L6 6`(左)・`M16 8l2-2`(右)と同じ向き=外へ開く。
      // 回転は時計回りが正なので、左は +45°・右は -45°(逆にすると内側へ寄る)。
      antL: { ...line(6.4, 6.4, 3, 1.4), transform: [{ rotate: "45deg" }] },
      antR: { ...line(14.6, 6.4, 3, 1.4), transform: [{ rotate: "-45deg" }] },
    };
  }, [color, size, u]);
  return (
    <View style={st.wrap}>
      <View style={st.head} />
      <View style={st.body} />
      <View style={st.spine} />
      <View style={st.legL1} />
      <View style={st.legL2} />
      <View style={st.legR1} />
      <View style={st.legR2} />
      <View style={st.antL} />
      <View style={st.antR} />
    </View>
  );
}

/** 丸いチェック(子スレ完了報告)。 */
export function CheckCircleIcon({ color, size = 24 }: IconProps) {
  const u = size / 24;
  const st = useMemo(
    () => ({
      ring: {
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.8 * u,
        borderColor: color,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      tickWrap: { width: 10 * u, height: 8 * u, marginTop: -1 * u },
      tickShort: {
        position: "absolute" as const,
        left: 0.6 * u,
        top: 4 * u,
        width: 4.6 * u,
        height: 1.9 * u,
        backgroundColor: color,
        borderRadius: u,
        transform: [{ rotate: "45deg" }],
      },
      tickLong: {
        position: "absolute" as const,
        left: 3.2 * u,
        top: 3 * u,
        width: 7.2 * u,
        height: 1.9 * u,
        backgroundColor: color,
        borderRadius: u,
        transform: [{ rotate: "-45deg" }],
      },
    }),
    [color, size, u],
  );
  return (
    <View style={st.ring}>
      <View style={st.tickWrap}>
        <View style={st.tickShort} />
        <View style={st.tickLong} />
      </View>
    </View>
  );
}

/** ベル(通知)。 */
export function BellIcon({ color, size = 24 }: IconProps) {
  const u = size / 24;
  const st = useMemo(
    () => ({
      wrap: { width: size, height: size, alignItems: "center" as const },
      dome: {
        marginTop: 3 * u,
        width: 15 * u,
        height: 13 * u,
        borderWidth: 1.8 * u,
        borderColor: color,
        borderTopLeftRadius: 7.5 * u,
        borderTopRightRadius: 7.5 * u,
        borderBottomWidth: 0,
      },
      brim: { width: 19 * u, height: 1.8 * u, backgroundColor: color, borderRadius: u },
      clapper: {
        marginTop: 1.6 * u,
        width: 3.6 * u,
        height: 2.2 * u,
        backgroundColor: color,
        borderBottomLeftRadius: 2 * u,
        borderBottomRightRadius: 2 * u,
      },
    }),
    [color, size, u],
  );
  return (
    <View style={st.wrap}>
      <View style={st.dome} />
      <View style={st.brim} />
      <View style={st.clapper} />
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
