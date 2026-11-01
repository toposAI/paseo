/**
 * 判断カードの行(2026-11-01 試作)。**モデルの返答ではなく、スクリプト(プラグインのサーバー)が貼った行**
 * として会話に出す。
 *
 * 表示は `data`(=`cards/<id>.json` の全文をそのまま写したもの)だけ。押した選択肢は
 * `topos.carddirect.answer` でその場で記録する(モデルを経由しない)。
 * 弾かれたとき(古い行・二度押し・本文が変わった・出題停止中)は、その旨を1行で出す。
 *
 * 2026-11-01 追加(壁打ち4):
 *   - 小さく「保留」「自由記述はこのまま話しかけてください」。保留は `release` へ繋ぐ
 *   - 記録できたときの表示から内部の語(queued)を外す
 *   - 出したときにカードの先頭が画面の上へ隠れていたら、先頭へ位置を合わせる(iPhone の長いカード)
 *   - 出題停止(PAUSED)や差し替えで古くなった行は、押す前にボタンを止める
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { View as ViewType } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import {
  cardDirectAnswerRpc,
  cardDirectHoldRpc,
  cardDirectStateRpc,
  type CardDirectData,
} from "../shared/card-direct.js";
import { alignToTop } from "./align-to-top.js";

const REASON_LABEL: Record<string, string> = {
  paused: "いまは出題を止めています(この回答は記録していません)",
  stale: "この行はもう最新ではありません(新しい行で答えてください)",
  duplicate: "この件はもう答えています",
  changed: "カードが作り直されました(新しい行で答えてください)",
  empty_answer: "回答が空でした",
};

/** 古くなった行の表示(押す前に止める)。 */
const STALE_LABEL: Record<string, string> = {
  paused: "いまは出題を止めています",
  retired: "この行はもう古くなりました(下の新しい行で答えてください)",
};

/** 保留にした行の印(選択肢の id と衝突しない値)。 */
const HELD = "__hold__";

// 先頭合わせの判定と戻し方は client/align-to-top.ts(ヘッダーの高さは固定値で持たず実測する)

/** この行がまだ押せるかを、いま出している行と突き合わせる。 */
function staleOf(
  out: { paused: boolean; agents: Record<string, { cardId: string; retired: number[] }> },
  agentId: string,
  cardId: string,
  shownAt: number,
): "" | "paused" | "retired" {
  if (out.paused) return "paused";
  const row = out.agents[agentId];
  if (!row || row.retired.includes(shownAt)) return "retired";
  if (row.cardId && row.cardId !== cardId) return "retired";
  return "";
}

export function CardDirectRow({ agentId, item, theme }: PluginTimelineItemProps<CardDirectData>) {
  const data = item.data;
  const send = useRpc(cardDirectAnswerRpc);
  const hold = useRpc(cardDirectHoldRpc);
  const stateOf = useRpc(cardDirectStateRpc);
  const [state, setState] = useState<{ chosen: string; text: string; failed: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState<"" | "paused" | "retired">("");
  const cardRef = useRef<ViewType | null>(null);
  const c = theme.colors;

  const styles = useMemo(() => buildStyles(c), [c]);

  // 出したときに先頭へ合わせる(行が画面の下に積まれたあと)。会話の自動スクロールが
  // 遅れて走ることがあるので、出てすぐの数回だけ見張る(その後の利用者のスクロールは動かさない)
  useEffect(() => {
    const timers = [250, 800, 1600].map((ms) => setTimeout(() => alignToTop(cardRef.current), ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  const decided = !!state?.chosen;
  // 出題停止・差し替え・別の窓が答えた のどれかで、押す前にボタンを止める
  useEffect(() => {
    if (decided) return;
    let stopped = false;
    const check = (): void => {
      stateOf({ agentId })
        .then((out) => {
          if (!stopped) setStale(staleOf(out, agentId, data.cardId, data.shownAt));
          return undefined;
        })
        .catch(() => {
          // 読めないときは押せるままにする(押した時点の門が本物)
        });
    };
    check();
    const timer = setInterval(check, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [agentId, data.cardId, data.shownAt, decided, stateOf]);

  const choose = useCallback(
    (optionId: string, label: string) => {
      if (busy || decided) return;
      setBusy(true);
      send({ agentId, cardId: data.cardId, choiceId: optionId, answer: label })
        .then((out) => {
          setBusy(false);
          if (out.ok) {
            setState({ chosen: optionId, text: "記録しました", failed: false });
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
    [agentId, busy, data.cardId, decided, send],
  );

  const pressHold = useCallback(() => {
    if (busy || decided) return;
    setBusy(true);
    hold({ agentId, cardId: data.cardId })
      .then((out) => {
        setBusy(false);
        if (out.ok) {
          setState({
            chosen: HELD,
            text: out.shownNext ? "保留にしました(次の1問を出しました)" : "保留にしました",
            failed: false,
          });
          return;
        }
        setState({
          chosen: "",
          text: REASON_LABEL[out.reason] ?? `保留できません: ${out.reason}`,
          failed: true,
        });
        return undefined;
      })
      .catch((e: unknown) => {
        setBusy(false);
        setState({
          chosen: "",
          text: `保留できません: ${e instanceof Error ? e.message : String(e)}`,
          failed: true,
        });
      });
  }, [agentId, busy, data.cardId, decided, hold]);

  const locked = decided || stale !== "";
  const note = stale ? STALE_LABEL[stale] : "";
  return (
    <View ref={cardRef} style={styles.card} testID={`card-direct-${data.cardId}`}>
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
      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          testID={`card-direct-hold-${data.cardId}`}
          disabled={busy || locked}
          onPress={pressHold}
          style={styles.hold(locked)}
        >
          <Text style={styles.holdText}>保留</Text>
        </Pressable>
        <Text style={styles.hint}>自由記述はこのまま話しかけてください</Text>
      </View>
      {state ? <Text style={styles.status(state.failed)}>{state.text}</Text> : null}
      {note ? <Text style={styles.status(false)}>{note}</Text> : null}
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
    footer: {
      marginTop: 12,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    hold: (disabled: boolean) => ({
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface0,
      opacity: disabled ? 0.55 : 1,
    }),
    holdText: { color: c.foregroundMuted, fontSize: 12 },
    hint: { color: c.foregroundMuted, fontSize: 12 },
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
