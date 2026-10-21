/**
 * カード単位のチャット欄。質問を送ると即時に受領(ack)が返り、本回答は別プロセスが書いた返答を
 * 10秒ごと(送信直後は即時)に読み直して表示する。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { cardChatListRpc, cardChatSayRpc } from "../shared/contract.js";
import type { CardChatListOutput } from "../shared/contract.js";

const REFRESH_MS = 10_000;

type Styles = Record<string, object>;

function speaker(role: string, by: string): string {
  if (role === "user") return "あなた";
  return by === "ack" ? "受領" : "返答";
}

const box = { gap: 6 };
const input = { borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 14, minHeight: 40 };

export function CardChat({ itemKey, styles }: { itemKey?: string; styles: Styles }) {
  const list = useRpc(cardChatListRpc);
  const say = useRpc(cardChatSayRpc);
  const [data, setData] = useState<CardChatListOutput | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    if (!itemKey) return;
    try {
      setData(await list({ key: itemKey }));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [list, itemKey]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || !itemKey) return;
    try {
      const r = await say({ key: itemKey, text: t });
      setNotice(r.ok ? "" : r.message);
      if (r.ok) setText("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
    void reload();
  }, [say, text, itemKey, reload]);
  const sendPress = useCallback(() => void send(), [send]);
  const inputStyle = useMemo(() => [input, styles.text], [styles.text]);

  if (!itemKey) return <Text style={styles.muted}>この項目はチャットできません(key なし)</Text>;
  return (
    <View style={box}>
      {data?.messages.map((m) => (
        <Text
          key={`${m.ts}-${m.role}-${m.by}`}
          style={m.role === "user" ? styles.text : styles.muted}
        >
          {speaker(m.role, m.by)}: {m.text}
        </Text>
      ))}
      {notice ? <Text style={styles.warn}>{notice}</Text> : null}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="このカードの論点について聞く"
        multiline
        style={inputStyle}
      />
      <Pressable accessibilityRole="button" style={styles.btnRec} onPress={sendPress}>
        <Text style={styles.btnRecText}>送る</Text>
      </Pressable>
    </View>
  );
}
