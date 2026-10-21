/**
 * 開発の優先順位(1〜10位)。▲▼で直接並べ替え(解釈を介さないので誤解釈が起きない)と、
 * 自由記述(「Xを上げて」)の送信・返答表示。解釈と台帳更新は別プロセスが行い、
 * ここは台帳と返答を30秒ごと(送信直後は即時)に読み直すだけ。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { priorityListRpc, priorityMoveRpc, prioritySayRpc } from "../shared/contract.js";
import type { PriorityListOutput } from "../shared/contract.js";

const REFRESH_MS = 30_000;

type Styles = Record<string, object>;
interface Colors {
  foreground: string;
  foregroundMuted: string;
  border: string;
}

const rankRow = { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 };
const grow = { flex: 1 };

function RankRow({
  id,
  index,
  name,
  styles,
  onShift,
}: {
  id: string;
  index: number;
  name: string;
  styles: Styles;
  onShift: (id: string, toRank: number) => Promise<void>;
}) {
  const up = useCallback(() => void onShift(id, index), [onShift, id, index]);
  const down = useCallback(() => void onShift(id, index + 2), [onShift, id, index]);
  const card = useMemo(() => [styles.card, rankRow], [styles.card]);
  const label = useMemo(() => [styles.text, grow], [styles.text]);
  return (
    <View style={card}>
      <Text style={styles.subject}>{index + 1}</Text>
      <Text style={label}>{name}</Text>
      <Pressable accessibilityRole="button" style={styles.btn} onPress={up}>
        <Text style={styles.btnText}>▲</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.btn} onPress={down}>
        <Text style={styles.btnText}>▼</Text>
      </Pressable>
    </View>
  );
}

export function PriorityView({ styles, colors }: { styles: Styles; colors: Colors }) {
  const list = useRpc(priorityListRpc);
  const move = useRpc(priorityMoveRpc);
  const say = useRpc(prioritySayRpc);
  const [data, setData] = useState<PriorityListOutput | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      setData(await list({}));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const shift = useCallback(
    async (id: string, toRank: number) => {
      try {
        setNotice((await move({ id, toRank })).message);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      void reload();
    },
    [move, reload],
  );

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const r = await say({ text: t });
      setNotice(r.message);
      if (r.ok) setText("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
    void reload();
  }, [say, text, reload]);
  const sendPress = useCallback(() => void send(), [send]);

  const input = useMemo(
    () => ({
      color: colors.foreground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: 8,
      fontSize: 14,
    }),
    [colors],
  );
  const replies = useMemo(() => (data?.replies ?? []).toReversed(), [data]);

  return (
    <View style={gap8}>
      <Text style={styles.muted}>
        開発の優先順位(▲▼で並べ替え。確認箱の判断も上位プロジェクトが先に並びます)
      </Text>
      {notice ? <Text style={styles.muted}>{notice}</Text> : null}
      {data?.projects.map((p, i) => (
        <RankRow key={p.id} id={p.id} index={i} name={p.name} styles={styles} onShift={shift} />
      ))}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="例: 139番を上げて"
        placeholderTextColor={colors.foregroundMuted}
        multiline
        style={input}
      />
      <Pressable accessibilityRole="button" style={styles.btnRec} onPress={sendPress}>
        <Text style={styles.btnRecText}>送る</Text>
      </Pressable>
      {replies.map((r) => (
        <Text key={`${r.ts}-${r.by}`} style={styles.muted}>
          {r.by === "ack" ? "受領" : r.by}: {r.text}
        </Text>
      ))}
    </View>
  );
}

const gap8 = { gap: 8 };
