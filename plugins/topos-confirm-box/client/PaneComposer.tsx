/**
 * 入力欄(＋添付・🎤音声入力・複数行の入力・送る)。右ペイン(CardChatPane)の入力欄をそのまま部品にしたもの。
 * 「UIの最終チェック」カードと画像ビューアも同じ部品を使う(別の作りを増やさない)。
 * Paseo本体の composer はプラグインから import できない(ChatDock.tsx 冒頭)ため、**見た目・並び・ボタンの大きさを
 * 本体の composer に合わせて**ここ1か所に集める(2026-11-07 ユーザー指摘2回目「確認箱のチャット欄もメインの
 * チャット欄と同じ構造にして」)。本体と同じ「入力欄が上段・ボタン行が下段」の2段、＋/🎤/送るは 28×28 の
 * 丸いアイコンボタン。複数行は maxHeight 120 まで縦に伸びる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
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
  /** 録音中のマイクの背景。無ければ赤系の既定色。 */
  destructive?: string;
}

type KeyPressHandler = (e: {
  nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
  preventDefault?: () => void;
}) => void;

/** 本体 composer と同じ寸法(28×28)。アイコンは点検で「小さくて薄い」と差し戻されたので18にする。 */
const TOOL_SIZE = 28;
const TOOL_ICON = 18;

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
    const iconBtn = {
      width: TOOL_SIZE,
      height: TOOL_SIZE,
      borderRadius: TOOL_SIZE / 2,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    };
    return {
      wrap: {
        paddingTop: 8,
        paddingHorizontal: 12,
        paddingBottom: 8,
        gap: 4,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface1,
      },
      input: {
        minHeight: 44,
        maxHeight: 120,
        color: colors.foreground,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 15,
      },
      inputOff: { opacity: 0.5 },
      buttonRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      group: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      // ＋とマイクは背景を敷いて「押せる丸」に見せる(透明だと送るだけが浮いて見え、点検で不揃いと差し戻された)。
      toolBtn: { ...iconBtn, backgroundColor: colors.surface2 },
      toolBtnPressed: { ...iconBtn, backgroundColor: colors.border },
      toolBtnOff: { ...iconBtn, backgroundColor: colors.surface2, opacity: 0.5 },
      micOn: { ...iconBtn, backgroundColor: colors.destructive ?? "#ef4444" },
      sendBtn: { ...iconBtn, backgroundColor: colors.accent },
      sendBtnOff: { ...iconBtn, backgroundColor: colors.accent, opacity: 0.5 },
    };
  }, [colors]);
  const inputStyle = useMemo(() => {
    // 送れない理由は入力欄の案内文として出す。長い理由(「総司令塔も閉じています(送信できません)」)は
    // 狭い幅で2行に折り返すので、1行分の高さのままだと2行目が切れる(2026-11-05 UI点検 iPhone幅)。
    return disabledReason
      ? [st.input, st.inputOff, { height: grownHeight, minHeight: 60 }]
      : [st.input, { height: grownHeight }];
  }, [disabledReason, grownHeight, st.input, st.inputOff]);
  const toolsDisabled = Boolean(disabledReason);
  // 押したときの見た目は関数で渡す必要があるため useCallback で固定する(lint: jsx-no-new-function-as-prop)。
  const toolBtnStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      pressed && !toolsDisabled ? st.toolBtnPressed : st.toolBtn,
      toolsDisabled ? st.toolBtnOff : null,
    ],
    [st.toolBtn, st.toolBtnOff, st.toolBtnPressed, toolsDisabled],
  );
  const micBtnStyle = useCallback(
    ({ pressed }: { pressed: boolean }) =>
      tools.listening
        ? st.micOn
        : [
            pressed && !toolsDisabled ? st.toolBtnPressed : st.toolBtn,
            toolsDisabled ? st.toolBtnOff : null,
          ],
    [st.micOn, st.toolBtn, st.toolBtnOff, st.toolBtnPressed, tools.listening, toolsDisabled],
  );
  return (
    <View style={st.wrap} testID={testID}>
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
      <View style={st.buttonRow}>
        <View style={st.group}>
          {tools.attachSupported ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="画像を添付"
              disabled={toolsDisabled}
              style={toolBtnStyle}
              onPress={tools.pickImages}
            >
              <Icon name="Plus" size={TOOL_ICON} color={colors.foreground} />
            </Pressable>
          ) : null}
        </View>
        <View style={st.group}>
          {/* マイクは常に出す(環境で隠すと「マイクが無い」と言われる)。押せない環境では押した時に理由を出す。 */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tools.listening ? "音声入力を止める" : "音声入力"}
            disabled={toolsDisabled}
            style={micBtnStyle}
            onPress={tools.toggleMic}
          >
            <Icon
              name={tools.listening ? "Square" : "Mic"}
              size={TOOL_ICON}
              color={tools.listening ? "#ffffff" : colors.foreground}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="送る"
            disabled={!sendable}
            style={sendable ? st.sendBtn : st.sendBtnOff}
            onPress={onSend}
          >
            <Icon name="ArrowUp" size={TOOL_ICON} color={colors.accentForeground} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
