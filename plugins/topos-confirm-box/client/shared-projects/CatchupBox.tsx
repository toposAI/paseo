/**
 * 「前回までの要約」。画面を開いた時点の既読位置(since_seq)より後の投稿を、AIがまとめて答える。
 * 質問を足して聞き返せる(これまでのやりとりは画面側が持ち、直近分だけ Topos へ渡す)。
 * 要約の生成と範囲の決め方は Topos 側。ここは入力と表示だけ。
 */
import { useCallback, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Markdown } from "./Markdown.js";
import type { ProjectCtx } from "./types.js";
import { Banner, Btn } from "./ui.js";

interface Turn {
  id: string;
  role: "user" | "ai";
  text: string;
}

const MAX_TURNS = 20;
const QUESTION_MAX = 2000;
const CHAT_CHARS = 1500;

function asText(data: unknown): { text: string; error: string } {
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  return {
    text: typeof d.text === "string" ? d.text : "",
    error: typeof d.llm_error === "string" ? d.llm_error : "",
  };
}

export function CatchupBox({ ctx, sinceSeq }: { ctx: ProjectCtx; sinceSeq: number }) {
  const { s, colors, call, id } = ctx;
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = useCallback(
    async (q: string) => {
      setBusy(true);
      setError("");
      const chat = turns
        .slice(-MAX_TURNS)
        .map((t) => ({ role: t.role, text: t.text.slice(0, CHAT_CHARS) }));
      const r = await call("catchup", {
        id,
        body: { since_seq: sinceSeq, question: q.trim(), chat },
      });
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const { text, error: llmError } = asText(r.data);
      if (llmError) setError("AIの要約に失敗しました。時間をおいてもう一度お試しください");
      setTurns((cur) => [
        ...cur,
        ...(q.trim() ? [{ id: `u${cur.length}`, role: "user" as const, text: q.trim() }] : []),
        { id: `a${cur.length}`, role: "ai" as const, text },
      ]);
      setQuestion("");
    },
    [call, id, sinceSeq, turns],
  );

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && turns.length === 0 && !busy) void ask("");
  }, [open, turns.length, busy, ask]);

  const send = useCallback(() => void ask(question), [ask, question]);
  const noop = useCallback(() => undefined, []);

  if (!open)
    return (
      <View style={s.rowWrap}>
        <Btn s={s} label="前回までの要約" onPress={toggle} />
      </View>
    );
  return (
    <View style={s.card}>
      <View style={s.rowBetween}>
        <Text style={s.h2}>前回までの要約</Text>
        <Btn s={s} label="閉じる" onPress={toggle} />
      </View>
      {turns.map((t) => (
        <View key={t.id} style={t.role === "ai" ? s.bubbleAi : s.bubbleMine}>
          <Text style={s.msgHead}>{t.role === "ai" ? "AI" : "あなた"}</Text>
          {t.role === "ai" ? (
            <Markdown source={t.text} colors={colors} />
          ) : (
            <Text style={s.text}>{t.text}</Text>
          )}
        </View>
      ))}
      {busy ? <Text style={s.muted}>AIがまとめています…</Text> : null}
      <Banner s={s} text={error} error />
      <TextInput
        style={s.inputLine}
        value={question}
        onChangeText={setQuestion}
        placeholder="要約について聞く(空のまま送ると、もう一度要約します)"
        placeholderTextColor={colors.foregroundMuted}
        multiline
        maxLength={QUESTION_MAX}
        editable={!busy}
      />
      <View style={s.row}>
        <Btn s={s} label="聞く" tone="primary" onPress={busy ? noop : send} disabled={busy} />
      </View>
    </View>
  );
}
