/**
 * 判断カードの行(2026-11-01 試作)。**モデルの返答ではなく、スクリプトが貼った行**として会話に出す。
 *
 * 表示は `data`(=`cards/<id>.json` の全文をそのまま写したもの)だけ。押した選択肢は
 * `topos.carddirect.answer` でその場で記録する(モデルを経由しない)。
 * 弾かれたとき(古い行・二度押し・本文が変わった・出題停止中)は、その旨を1行で出す。
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { cardDirectAnswerRpc, type CardDirectData } from "../shared/card-direct.js";

const REASON_LABEL: Record<string, string> = {
  paused: "いまは出題を止めています(この回答は記録していません)",
  stale: "この行はもう最新ではありません(新しい行で答えてください)",
  duplicate: "この件はもう答えています",
  changed: "カードが作り直されました(新しい行で答えてください)",
  empty_answer: "回答が空でした",
};

export function CardDirectRow({ agentId, item, theme }: PluginTimelineItemProps<CardDirectData>) {
  const data = item.data;
  const send = useRpc(cardDirectAnswerRpc);
  const [state, setState] = useState<{ chosen: string; text: string; failed: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const c = theme.colors;

  const styles = useMemo(() => buildStyles(c), [c]);

  const choose = useCallback(
    (optionId: string, label: string) => {
      if (busy || state?.chosen) return;
      setBusy(true);
      send({ agentId, cardId: data.cardId, choiceId: optionId, answer: label })
        .then((out) => {
          setBusy(false);
          if (out.ok) {
            setState({
              chosen: optionId,
              text: `記録しました(${out.recorded || "queued"})`,
              failed: false,
            });
            return;
          }
          if (out.reason === "duplicate") {
            setState({ chosen: optionId, text: REASON_LABEL.duplicate, failed: false });
            return;
          }
          setState({
            chosen: "",
            text: REASON_LABEL[out.reason] ?? `記録できません: ${out.reason}`,
            failed: true,
          });
          return undefined;
        })
        .catch((e: unknown) => {
          setBusy(false);
          setState({
            chosen: "",
            text: `記録できません: ${e instanceof Error ? e.message : String(e)}`,
            failed: true,
          });
        });
    },
    [agentId, busy, data.cardId, send, state?.chosen],
  );

  const locked = !!state?.chosen;
  return (
    <View style={styles.card} testID={`card-direct-${data.cardId}`}>
      <Text style={styles.question}>{data.question}</Text>
      {data.options.map((o) => (
        <OptionRow
          key={o.id}
          option={o}
          picked={state?.chosen === o.id}
          disabled={busy || locked}
          dimmed={locked && state?.chosen !== o.id}
          styles={styles}
          onChoose={choose}
        />
      ))}
      {state ? <Text style={styles.status(state.failed)}>{state.text}</Text> : null}
    </View>
  );
}

type Styles = ReturnType<typeof buildStyles>;

function buildStyles(c: PluginTimelineItemProps<CardDirectData>["theme"]["colors"]) {
  return {
    card: {
      marginVertical: 6,
      padding: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    question: { color: c.foreground, fontSize: 15, lineHeight: 22 },
    option: (picked: boolean, disabled: boolean) => ({
      marginTop: 8,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: picked ? c.accent : c.border,
      backgroundColor: picked ? c.surface2 : c.surface0,
      opacity: disabled ? 0.55 : 1,
    }),
    optionLabel: { color: c.foreground, fontSize: 14, fontWeight: "600" as const },
    optionDesc: { color: c.foregroundMuted, fontSize: 12, marginTop: 2 },
    status: (failed: boolean) => ({
      marginTop: 10,
      color: failed ? c.statusDanger : c.foregroundMuted,
      fontSize: 12,
    }),
  };
}

function OptionRow({
  option,
  picked,
  disabled,
  dimmed,
  styles,
  onChoose,
}: {
  option: CardDirectData["options"][number];
  picked: boolean;
  disabled: boolean;
  dimmed: boolean;
  styles: Styles;
  onChoose: (optionId: string, label: string) => void;
}) {
  const press = useCallback(
    () => onChoose(option.id, option.label),
    [onChoose, option.id, option.label],
  );
  return (
    <Pressable
      accessibilityRole="button"
      testID={`card-direct-option-${option.id}`}
      disabled={disabled}
      onPress={press}
      style={styles.option(picked, dimmed)}
    >
      <Text style={styles.optionLabel}>
        {picked ? "● " : "○ "}
        {option.label}
      </Text>
      {option.description ? <Text style={styles.optionDesc}>{option.description}</Text> : null}
    </Pressable>
  );
}
