/**
 * 入力欄(＋添付・🎤音声入力・複数行の入力・送る)。右ペイン(CardChatPane)の入力欄をそのまま部品にしたもの。
 * 「UIの最終チェック」カードと画像ビューアも同じ部品を使う(別の作りを増やさない)。
 * Paseo本体の composer はプラグインから import できない(ChatDock.tsx 冒頭)ため、見た目・高さ・ボタン並びを
 * ここ1か所に集め、複数行は maxHeight 120 まで縦に伸びる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { usePaneInputTools } from "./usePaneInputTools.js";

export interface ComposerColors {
  foreground: string;
  foregroundMuted: string;
  border: string;
  surface0: string;
  surface1: string;
  surface2: string;
  accent: string;
  accentForeground: string;
}

type KeyPressHandler = (e: {
  nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
  preventDefault?: () => void;
}) => void;

export function PaneComposer({
  colors,
  text,
  onChangeText,
  onKeyPress,
  tools,
  disabledReason,
  placeholder,
  maxLength,
  sendable,
  onSend,
  focusSignal,
  testID,
}: {
  colors: ComposerColors;
  text: string;
  onChangeText: (text: string) => void;
  onKeyPress?: KeyPressHandler;
  tools: ReturnType<typeof usePaneInputTools>;
  /** 送れない理由(あれば入力欄・ボタンを止めて、案内文に出す)。 */
  disabledReason: string | null;
  placeholder: string;
  maxLength: number;
  sendable: boolean;
  onSend: () => void;
  /** 値が変わるたびに入力欄へフォーカスを移す。 */
  focusSignal?: number;
  testID?: string;
}): ReactNode {
  const inputRef = useRef<TextInput | null>(null);
  // 複数行は内容の高さに合わせて maxHeight まで縦に伸ばす(web の textarea は高さを自動で増やさないため)。
  const [grownHeight, setGrownHeight] = useState(44);
  // 幅が狭い(PC のポップオーバー等)ときは、入力欄を1段目いっぱいに出し、マイクと送るを2段目に置く。
  const [narrow, setNarrow] = useState(false);
  const onRowLayout = useCallback((e: { nativeEvent: { layout: { width: number } } }) => {
    setNarrow(e.nativeEvent.layout.width < 300);
  }, []);
  useEffect(() => {
    if (text === "") setGrownHeight(44);
  }, [text]);
  const onContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      const h = Math.ceil(e.nativeEvent.contentSize.height) + 18;
      setGrownHeight(Math.min(120, Math.max(44, h)));
    },
    [],
  );
  useEffect(() => {
    if (focusSignal) inputRef.current?.focus();
  }, [focusSignal]);
  const st = useMemo(() => {
    const tool = {
      minHeight: 44,
      minWidth: 44,
      borderRadius: 8,
      borderWidth: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    };
    const send = {
      minHeight: 44,
      minWidth: 56,
      marginLeft: "auto" as const,
      borderRadius: 8,
      backgroundColor: colors.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    };
    return {
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "flex-end" as const,
        gap: 8,
        padding: 10,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface1,
        paddingBottom: "env(safe-area-inset-bottom)" as unknown as number,
      },
      input: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 72,
        minWidth: 72,
        minHeight: 44,
        maxHeight: 120,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
      inputOff: { opacity: 0.5 },
      toolBtn: { ...tool, borderColor: colors.border },
      toolBtnOn: { ...tool, borderColor: colors.accent, backgroundColor: colors.surface2 },
      toolText: { color: colors.foreground, fontSize: 18 },
      sendBtn: send,
      sendBtnOff: { ...send, opacity: 0.5 },
      sendText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
    };
  }, [colors]);
  const inputStyle = useMemo(() => {
    const base = narrow ? [st.input, { flexBasis: "100%" as unknown as number }] : [st.input];
    return disabledReason
      ? [...base, st.inputOff, { height: grownHeight }]
      : [...base, { height: grownHeight }];
  }, [disabledReason, grownHeight, narrow, st.input, st.inputOff]);
  const inputEl = (
    <TextInput
      ref={inputRef}
      value={text}
      onChangeText={onChangeText}
      onKeyPress={onKeyPress}
      editable={!disabledReason}
      placeholder={disabledReason ?? placeholder}
      placeholderTextColor={colors.foregroundMuted}
      multiline
      onContentSizeChange={onContentSizeChange}
      maxLength={maxLength}
      style={inputStyle}
    />
  );
  return (
    <View style={st.row} testID={testID} onLayout={onRowLayout}>
      {narrow ? inputEl : null}
      {tools.attachSupported ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="画像を添付"
          disabled={Boolean(disabledReason)}
          style={st.toolBtn}
          onPress={tools.pickImages}
        >
          <Text style={st.toolText}>＋</Text>
        </Pressable>
      ) : null}
      {tools.micSupported ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tools.listening ? "音声入力を止める" : "音声入力"}
          disabled={Boolean(disabledReason)}
          style={tools.listening ? st.toolBtnOn : st.toolBtn}
          onPress={tools.toggleMic}
        >
          <Text style={st.toolText}>🎤</Text>
        </Pressable>
      ) : null}
      {narrow ? null : inputEl}
      <Pressable
        accessibilityRole="button"
        disabled={!sendable}
        style={sendable ? st.sendBtn : st.sendBtnOff}
        onPress={onSend}
      >
        <Text style={st.sendText}>送る</Text>
      </Pressable>
    </View>
  );
}
