/**
 * カード単位のチャット欄。質問を送ると即時に受領(ack)が返り、本回答は別プロセスが書いた返答を
 * 10秒ごと(送信直後は即時)に読み直して表示する。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export function CardChat({
  itemId,
  itemKey,
  styles,
}: {
  itemId: string;
  itemKey?: string | null;
  styles: Styles;
}) {
  const list = useRpc(cardChatListRpc);
  const say = useRpc(cardChatSayRpc);
  const [data, setData] = useState<CardChatListOutput | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  // state は再描画まで古い値のままなので、同じ描画フレーム内の二度押しは ref で止める
  // (同じ質問が2件並ぶと、片方にしか返事が付かないように見える)。
  const sendingRef = useRef(false);

  const reload = useCallback(async () => {
    if (!itemId) return;
    try {
      setData(await list({ id: itemId, key: itemKey ?? null }));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [list, itemId, itemKey]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || !itemId || sendingRef.current) return; // 二度押しで同じ質問を2件作らない
    sendingRef.current = true;
    setSending(true);
    try {
      const r = await say({ id: itemId, key: itemKey ?? null, text: t });
      setNotice(r.ok ? "" : r.message);
      if (r.ok) setText("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    void reload();
  }, [say, text, itemId, itemKey, reload]);
  const sendPress = useCallback(() => void send(), [send]);
  const inputStyle = useMemo(() => [input, styles.text], [styles.text]);
  // 同じ周期に2問答えると ts と by が一致しうる(ワーカーは1周期の now を使う)。
  // 並び順は元から固定なので、内容まで同じ行だけを出現順の番号で一意にする。
  const rows = useMemo(() => {
    const seen = new Map<string, number>();
    return (data?.messages ?? []).map((message) => {
      const base = `${message.ts}-${message.role}-${message.by}-${message.text}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: `${base}#${n}`, message };
    });
  }, [data]);

  if (!itemId) return <Text style={styles.muted}>この項目はチャットできません(id なし)</Text>;
  return (
    <View style={box}>
      {rows.map(({ key, message }) => (
        <Text key={key} style={message.role === "user" ? styles.text : styles.muted}>
          {speaker(message.role, message.by)}: {message.text}
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
      <Pressable
        accessibilityRole="button"
        disabled={sending}
        style={styles.btnRec}
        onPress={sendPress}
      >
        <Text style={styles.btnRecText}>送る</Text>
      </Pressable>
    </View>
  );
}
