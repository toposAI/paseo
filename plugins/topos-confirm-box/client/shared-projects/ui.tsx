/**
 * 共有プロジェクト画面で共通の小さな部品と配色。Paseo のテーマ色(surface0/1/2・foreground・border・accent)だけを使い、
 * 他のタブ(確認箱・構想ノート)と同じ見た目に揃える。
 *
 * lint 規約(JSX・関数・オブジェクトを prop に直書きしない)のため、スタイルは `makeStyles` で1回作り、
 * 押下の引数は `value` で渡して部品の中で `useCallback` にする。
 */
import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";

export type Colors = PluginHostProps["theme"]["colors"];

export const DANGER = "#c0392b";
export const ON_ACCENT = "#ffffff";

export function makeStyles(c: Colors) {
  const btn = {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface1,
  } as const;
  const chip = {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface1,
  } as const;
  const text = { color: c.foreground, fontSize: 14, lineHeight: 21 } as const;
  const input = {
    color: c.foreground,
    backgroundColor: c.surface1,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  } as const;
  return {
    root: { flex: 1, backgroundColor: c.surface0 },
    fill: { flex: 1 },
    page: {
      padding: 14,
      gap: 12,
      maxWidth: 820,
      alignSelf: "center",
      width: "100%",
    },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    rowWrap: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
    rowBetween: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    grow: { flex: 1, flexShrink: 1 },
    title: { color: c.foreground, fontSize: 18, fontWeight: "700", flexShrink: 1 },
    h2: { color: c.foreground, fontSize: 15, fontWeight: "700" },
    text,
    muted: { color: c.foregroundMuted, fontSize: 12, lineHeight: 18, flexShrink: 1 },
    error: { color: DANGER, fontSize: 13, lineHeight: 19 },
    ok: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 },
    card: {
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      gap: 8,
    },
    cardRow: {
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 2,
    },
    banner: {
      backgroundColor: c.surface2,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    // 警告(エラー・AI失敗・上限超過)は全て同じ見た目: 赤い枠と文字
    bannerWarn: {
      backgroundColor: c.surface2,
      borderColor: DANGER,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    bannerText: { color: c.foreground, fontSize: 13, lineHeight: 19 },
    btn,
    btnOn: { ...btn, backgroundColor: c.accent, borderColor: c.accent },
    btnDanger: { ...btn, borderColor: DANGER },
    // 無効ボタンは透過で背景に溶かさず、淡い面と読める文字色にする
    btnOff: { ...btn, backgroundColor: c.surface2 },
    btnTextOff: { color: c.foregroundMuted, fontSize: 13 },
    btnText: { color: c.foreground, fontSize: 13 },
    btnTextOn: { color: ON_ACCENT, fontSize: 13, fontWeight: "700" },
    btnTextDanger: { color: DANGER, fontSize: 13, fontWeight: "700" },
    chip,
    chipOn: { ...chip, backgroundColor: c.accent, borderColor: c.accent },
    chipText: { color: c.foreground, fontSize: 12 },
    chipTextOn: { color: ON_ACCENT, fontSize: 12, fontWeight: "700" },
    tabs: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingHorizontal: 8,
    },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 2,
      borderColor: "transparent",
    },
    tabOn: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 2,
      borderColor: c.accent,
    },
    tabText: { color: c.foregroundMuted, fontSize: 14 },
    tabTextOn: { color: c.foreground, fontSize: 14, fontWeight: "700" },
    input,
    inputMulti: { ...input, minHeight: 90, textAlignVertical: "top" },
    inputNote: {
      ...input,
      minHeight: 260,
      textAlignVertical: "top",
      fontFamily: "Menlo",
      fontSize: 13,
      lineHeight: 20,
    },
    label: { color: c.foregroundMuted, fontSize: 12 },
    sep: { height: 1, backgroundColor: c.border, marginVertical: 4 },
    // スレッド
    msgList: { padding: 12, gap: 10, maxWidth: 820, alignSelf: "center", width: "100%" },
    bubbleMine: {
      alignSelf: "flex-end",
      maxWidth: "92%",
      backgroundColor: c.surface2,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
      gap: 6,
    },
    bubbleOther: {
      alignSelf: "flex-start",
      maxWidth: "92%",
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
      gap: 6,
    },
    bubbleAi: {
      alignSelf: "flex-start",
      maxWidth: "92%",
      backgroundColor: c.surface1,
      borderColor: c.accent,
      borderWidth: 1,
      borderRadius: 10,
      padding: 10,
      gap: 6,
    },
    msgHead: { color: c.foregroundMuted, fontSize: 11, lineHeight: 16 },
    mention: { color: c.accent, fontWeight: "700" },
    thumb: { width: 160, height: 120, borderRadius: 8, backgroundColor: c.surface2 },
    thumbSmall: { width: 64, height: 64, borderRadius: 6, backgroundColor: c.surface2 },
    fileTag: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: c.surface0,
    },
    composer: {
      borderTopWidth: 1,
      borderTopColor: c.border,
      padding: 10,
      gap: 8,
      backgroundColor: c.surface0,
      maxWidth: 820,
      alignSelf: "center",
      width: "100%",
    },
    overlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.88)",
      alignItems: "center",
      justifyContent: "center",
      padding: 12,
      zIndex: 20,
    },
    zoomImg: { width: "100%", height: "100%" },
    inputLine: { ...input, minHeight: 44, maxHeight: 160 },
  } as const;
}

export type S = ReturnType<typeof makeStyles>;

interface BtnProps {
  s: S;
  label: string;
  onPress: (value: string) => void;
  value?: string;
  tone?: "plain" | "primary" | "danger";
  disabled?: boolean;
  a11y?: string;
}

/** 押せるボタン。引数は value で渡す(onPress(value))。 */
export function Btn({ s, label, onPress, value = "", tone = "plain", disabled, a11y }: BtnProps) {
  const press = useCallback(() => onPress(value), [onPress, value]);
  const boxes = { plain: s.btn, primary: s.btnOn, danger: s.btnDanger } as const;
  const texts = { plain: s.btnText, primary: s.btnTextOn, danger: s.btnTextDanger } as const;
  const box = disabled ? s.btnOff : boxes[tone];
  const txt = disabled ? s.btnTextOff : texts[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      disabled={disabled}
      onPress={press}
      style={box}
    >
      <Text style={txt}>{label}</Text>
    </Pressable>
  );
}

interface ChipProps {
  s: S;
  label: string;
  on: boolean;
  onPress: (value: string) => void;
  value?: string;
  disabled?: boolean;
}

/** 選択式のチップ(宛先・招待相手など)。 */
export function Chip({ s, label, on, onPress, value = "", disabled }: ChipProps) {
  const press = useCallback(() => onPress(value), [onPress, value]);
  const state = useMemo(() => ({ selected: on }), [on]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={state}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={press}
      style={on ? s.chipOn : s.chip}
    >
      <Text style={on ? s.chipTextOn : s.chipText}>{label}</Text>
    </Pressable>
  );
}

/** 画面上部の注意書き。error なら赤、それ以外は目立たない枠。 */
export function Banner({
  s,
  text,
  error,
}: {
  s: S;
  text: string;
  error?: boolean;
}): ReactElement | null {
  if (!text) return null;
  return (
    <View style={error ? s.bannerWarn : s.banner}>
      <Text style={error ? s.error : s.bannerText}>{text}</Text>
    </View>
  );
}

export function nameOfUser(
  id: string,
  members: readonly { userId: string; name: string }[],
): string {
  if (id === "llm") return "AI";
  return members.find((m) => m.userId === id)?.name ?? id;
}
