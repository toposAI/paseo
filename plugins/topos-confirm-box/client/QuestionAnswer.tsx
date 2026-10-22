/**
 * 承認待ちカードの質問フォーム。Claude の AskUserQuestion / opencode の question を
 * 「質問文 + 選択肢 + その他」として描き、押された内容を `answers` として返す。
 *
 * これが無かった頃は `input` の生JSONが背景欄に出るだけで、質問文も選択肢も読めず、
 * 選ぶこともできなかった(許可/拒否の2択しか無かった)。
 *
 * 回答の組み立ては `shared/questions.ts`(純粋関数)に置き、サーバー側の検証と同じ規則を使う。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  allAnswered,
  answerKeys,
  anyTruncated,
  buildAnswers,
  showsTextInput,
  uniqueOptionKeys,
} from "../shared/questions.js";
import type { QuestionItem, QuestionOption } from "../shared/questions.js";

export interface QuestionAnswerColors {
  foreground: string;
  foregroundMuted: string;
  accent: string;
  accentForeground: string;
  border: string;
  surface0: string;
  surface2: string;
}

// JSX属性に毎回新しいリテラルを渡さないための定数(react-perf の lint 対策)。
const CHECKED = { checked: true };
const UNCHECKED = { checked: false };
const DISABLED_STATE = { disabled: true };
const ENABLED_STATE = { disabled: false };

type StylesOf = ReturnType<typeof buildStyles>;

function buildStyles(colors: QuestionAnswerColors) {
  const option = {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface0,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 8,
    minHeight: 40,
  };
  const mark = {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginTop: 1,
  };
  const action = {
    backgroundColor: colors.surface2,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 40,
    justifyContent: "center" as const,
  };
  return {
    stack: { gap: 10 },
    block: { gap: 4, marginTop: 2 },
    header: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
    question: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
    option,
    optionPicked: { ...option, borderColor: colors.accent, backgroundColor: colors.surface2 },
    mark,
    markPicked: { ...mark, borderColor: colors.accent, backgroundColor: colors.accent },
    markText: { color: colors.accentForeground, fontSize: 11, fontWeight: "700" as const },
    optionBody: { flex: 1, gap: 2 },
    optionLabel: { color: colors.foreground, fontSize: 13 },
    optionDesc: { color: colors.foregroundMuted, fontSize: 11 },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface0,
      color: colors.foreground,
      borderRadius: 6,
      padding: 8,
      fontSize: 13,
      minHeight: 40,
    },
    action,
    actionReady: { ...action, backgroundColor: colors.accent },
    actionText: { color: colors.foreground, fontSize: 13 },
    actionReadyText: { color: colors.accentForeground, fontSize: 13 },
    actionRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    hint: { color: colors.foregroundMuted, fontSize: 11 },
  };
}

function OptionRow({
  option,
  selected,
  multiSelect,
  questionIndex,
  optionIndex,
  styles,
  onToggle,
}: {
  option: QuestionOption;
  selected: boolean;
  multiSelect: boolean;
  questionIndex: number;
  optionIndex: number;
  styles: StylesOf;
  onToggle: (questionIndex: number, optionIndex: number, multiSelect: boolean) => void;
}) {
  const press = useCallback(
    () => onToggle(questionIndex, optionIndex, multiSelect),
    [onToggle, questionIndex, optionIndex, multiSelect],
  );
  return (
    <Pressable
      accessibilityRole={multiSelect ? "checkbox" : "radio"}
      accessibilityState={selected ? CHECKED : UNCHECKED}
      style={selected ? styles.optionPicked : styles.option}
      onPress={press}
    >
      <View style={selected ? styles.markPicked : styles.mark}>
        {selected ? <Text style={styles.markText}>{multiSelect ? "✓" : "●"}</Text> : null}
      </View>
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{option.label}</Text>
        {option.description ? <Text style={styles.optionDesc}>{option.description}</Text> : null}
      </View>
    </Pressable>
  );
}

function OtherInput({
  value,
  placeholder,
  questionIndex,
  multiSelect,
  styles,
  placeholderColor,
  onChange,
}: {
  value: string;
  placeholder: string;
  questionIndex: number;
  multiSelect: boolean;
  styles: StylesOf;
  placeholderColor: string;
  onChange: (questionIndex: number, text: string, multiSelect: boolean) => void;
}) {
  const change = useCallback(
    (text: string) => onChange(questionIndex, text, multiSelect),
    [onChange, questionIndex, multiSelect],
  );
  return (
    <TextInput
      value={value}
      onChangeText={change}
      placeholder={placeholder}
      placeholderTextColor={placeholderColor}
      style={styles.input}
      multiline
    />
  );
}

export function QuestionAnswer({
  questions,
  colors,
  disabled,
  onAnswer,
  onDeny,
}: {
  questions: readonly QuestionItem[];
  colors: QuestionAnswerColors;
  disabled: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onDeny: () => void;
}) {
  const [selections, setSelections] = useState<Record<number, number[]>>({});
  const [others, setOthers] = useState<Record<number, string>>({});
  // 同じ描画フレーム内の二度押しは state が古いままなので ref で止める。
  const sendingRef = useRef(false);

  const toggle = useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
    setSelections((prev) => {
      const current = prev[questionIndex] ?? [];
      let next: number[];
      if (multiSelect) {
        next = current.includes(optionIndex)
          ? current.filter((index) => index !== optionIndex)
          : [...current, optionIndex];
      } else {
        next = current.length === 1 && current[0] === optionIndex ? [] : [optionIndex];
      }
      return { ...prev, [questionIndex]: next };
    });
    if (!multiSelect) {
      // 単一選択では選択肢が自由記述を置き換える(両方残ると意味が曖昧になる)。
      setOthers((prev) => (prev[questionIndex] ? { ...prev, [questionIndex]: "" } : prev));
    }
  }, []);

  const changeOther = useCallback((questionIndex: number, text: string, multiSelect: boolean) => {
    setOthers((prev) => ({ ...prev, [questionIndex]: text }));
    if (!multiSelect && text.trim().length > 0) {
      setSelections((prev) =>
        prev[questionIndex]?.length ? { ...prev, [questionIndex]: [] } : prev,
      );
    }
  }, []);

  const ready = useMemo(
    () => allAnswered(questions, selections, others),
    [questions, selections, others],
  );
  // キーは header(空/重複は質問文)。React のリストキーとしても一意になる。
  const keys = useMemo(() => answerKeys(questions), [questions]);
  const optionKeys = useMemo(
    () => questions.map((question) => uniqueOptionKeys(question.options)),
    [questions],
  );
  // 切り詰めた質問・選択肢は上流の実物と一致しない(選んでも別の選択肢になる)。
  // フォームを出さず、スレで答えてもらう。
  const truncated = useMemo(() => anyTruncated(questions), [questions]);
  const styles = useMemo(() => buildStyles(colors), [colors]);

  const submit = useCallback(() => {
    if (!ready || disabled || sendingRef.current) return;
    sendingRef.current = true;
    onAnswer(buildAnswers(questions, selections, others));
    // 失敗して項目が残った時に押し直せるようにする(成功時は項目ごと消える)。
    setTimeout(() => {
      sendingRef.current = false;
    }, 5000);
  }, [disabled, onAnswer, others, questions, ready, selections]);

  const canSubmit = ready && !disabled;

  if (truncated) {
    return (
      <View style={styles.stack}>
        <Text style={styles.header}>質問が長すぎます</Text>
        <Text style={styles.hint}>
          選択肢を完全には表示できないため、この画面からは答えられません。元のスレで答えてください。
        </Text>
        <View style={styles.actionRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="質問に答えずに拒否"
            style={styles.action}
            onPress={onDeny}
          >
            <Text style={styles.actionText}>拒否</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      {questions.map((question, questionIndex) => {
        const picked = selections[questionIndex] ?? [];
        return (
          <View key={keys[questionIndex]} style={styles.block}>
            {question.header ? <Text style={styles.header}>{question.header}</Text> : null}
            <Text style={styles.question}>{question.question}</Text>
            {question.options.map((option, optionIndex) => (
              <OptionRow
                key={optionKeys[questionIndex][optionIndex]}
                option={option}
                selected={picked.includes(optionIndex)}
                multiSelect={question.multiSelect}
                questionIndex={questionIndex}
                optionIndex={optionIndex}
                styles={styles}
                onToggle={toggle}
              />
            ))}
            {showsTextInput(question) ? (
              <OtherInput
                value={others[questionIndex] ?? ""}
                placeholder={question.options.length === 0 ? "回答を入力" : "その他(自由記述)"}
                questionIndex={questionIndex}
                multiSelect={question.multiSelect}
                styles={styles}
                placeholderColor={colors.foregroundMuted}
                onChange={changeOther}
              />
            ) : null}
          </View>
        );
      })}
      <View style={styles.actionRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="回答を送信"
          accessibilityState={canSubmit ? ENABLED_STATE : DISABLED_STATE}
          style={canSubmit ? styles.actionReady : styles.action}
          onPress={submit}
        >
          <Text style={canSubmit ? styles.actionReadyText : styles.actionText}>送信</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="質問に答えずに拒否"
          style={styles.action}
          onPress={onDeny}
        >
          <Text style={styles.actionText}>拒否</Text>
        </Pressable>
        {ready ? null : <Text style={styles.hint}>選ぶと送信できます</Text>}
      </View>
    </View>
  );
}
