/**
 * サイドバー行の先頭に出す「状態の点」(純正 Paseo と同じ意味・同じ色)。
 *
 * `SidebarRow` の `icon` は「アイコン名 or `{size, color}` を受けるコンポーネント」しか受けない
 * (`packages/app/src/plugins/sidebar-items/kit.tsx`)。ここではその形に合わせた成分を作り、
 * アイコン枠(14px)の中央に点を置く。判定・色・大きさの正は `shared/state-dot.ts`。
 */
import { useMemo } from "react";
import type React from "react";
import { StyleSheet, View } from "react-native";
import { stateDotStyle } from "../shared/state-dot.js";
import type { DotAppearance, StateDotKind } from "../shared/state-dot.js";

/** 行の先頭に置くコンポーネント(ホストが `size`=14 と文字色を渡す。どちらも色には使わない)。 */
export type StateDotIcon = (props: { size?: number; color?: string }) => React.ReactElement;

/**
 * 点の種類と明暗から、`SidebarRow icon` に渡すコンポーネントを作る。
 * 毎回新しい成分を作ると行の再マウントを招くので、呼び出し側は `useMemo` で種類ごとに保持する
 * (`stateDotIcons()` がその形)。
 */
export function makeStateDotIcon(kind: StateDotKind, appearance: DotAppearance): StateDotIcon {
  const s = stateDotStyle(kind, appearance);
  const dot = {
    width: s.size,
    height: s.size,
    borderRadius: s.size / 2,
    opacity: s.opacity,
  } as const;
  // アイコン枠は種類に依らず同じなので、StyleSheet に1つだけ置く。
  function StateDotIcon({ color }: { size?: number; color?: string }) {
    // 色だけ差し替えても、スタイル定義は毎回作らない。
    const styled = useMemo(
      () => StyleSheet.create({ dot: { ...dot, backgroundColor: s.color ?? color ?? "#888888" } }),
      // `color` は done の点だけで使う(ホストの文字色)。
      [color],
    );
    return (
      <View style={styles.box}>
        <View testID={`state-dot-${kind}`} style={styled.dot} />
      </View>
    );
  }
  StateDotIcon.displayName = `StateDot(${kind})`;
  return StateDotIcon;
}

/** すべての種類の成分(種類 × 明暗ごとに1つ。明暗は起動中に変わらない前提)。 */
export function stateDotIcons(appearance: DotAppearance): Record<StateDotKind, StateDotIcon> {
  return {
    needs_input: makeStateDotIcon("needs_input", appearance),
    failed: makeStateDotIcon("failed", appearance),
    running: makeStateDotIcon("running", appearance),
    attention: makeStateDotIcon("attention", appearance),
    done: makeStateDotIcon("done", appearance),
  };
}

const styles = StyleSheet.create({
  box: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
});
