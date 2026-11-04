/**
 * 「UIの最終チェック」専用カード(案C)。件名・要約・完成版の PC/iPhone 画像・OK ボタン・
 * 「💬 直してほしい」(押すとこのカードの中に既存のカード内チャット欄 CardChat を開き、投函元と往復する)。
 * 画像は縦横比を保って縮小表示し、押すと拡大する。新しい経路は作らず、チャットは CardChat をそのまま使う。
 */
import { useCallback, useMemo, useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { splitShots, shotLabel, UFC_OK_ID } from "../shared/ui-final-check.js";
import { CardChat } from "./CardChat.js";

type Styles = Record<string, object>;

const PC_BOX = { width: 176, height: 110 };
const PHONE_BOX = { width: 60, height: 110 };
const row = {
  flexDirection: "row" as const,
  gap: 8,
  alignItems: "flex-end" as const,
};
const zoomWrap = {
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.95)",
  alignItems: "center" as const,
  justifyContent: "flex-start" as const,
  padding: 16,
  paddingTop: 48,
  gap: 12,
};
const zoomImg = { width: "100%" as const, flex: 1 };
const zoomText = { color: "#fff", fontSize: 14 };

function Thumb({
  source,
  index,
  onZoom,
}: {
  source: { uri: string };
  index: number;
  onZoom: (index: number) => void;
}) {
  const press = useCallback(() => onZoom(index), [onZoom, index]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${shotLabel(index, false)}を拡大`}
      onPress={press}
    >
      <Image source={source} style={index === 0 ? PC_BOX : PHONE_BOX} resizeMode="contain" />
    </Pressable>
  );
}

export function UiFinalCheckCard({
  item,
  styles,
  onChoose,
  onToggle,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
  onToggle: (id: string) => void;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const shots = useMemo(() => splitShots(item.images), [item.images]);
  const sources = useMemo(
    () => shots.finals.map((i) => ({ uri: `data:${i.mimeType};base64,${i.data}` })),
    [shots],
  );
  const ok = useCallback(() => {
    setSending(true);
    void onChoose(item, UFC_OK_ID).finally(() => setSending(false));
  }, [item, onChoose]);
  const toggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const closeZoom = useCallback(() => setZoom(null), []);
  const header = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const approved = item.state === "approved";
  const zoomSource = zoom === null ? null : sources[zoom];
  return (
    <View style={styles.cell}>
      <View style={styles.card}>
        <Pressable accessibilityRole="button" onPress={header}>
          <Text style={styles.badge}>UIの最終チェック{approved ? " · OK済み" : ""}</Text>
          <Text style={styles.subject}>{item.subject}</Text>
        </Pressable>
        <Text style={styles.muted} numberOfLines={2}>
          {item.summary}
        </Text>
        <View style={row}>
          {sources.map((source, i) => (
            <Thumb key={source.uri} source={source} index={i} onZoom={setZoom} />
          ))}
        </View>
        {approved || sending ? (
          <Text style={approved ? styles.text : styles.muted}>
            {approved ? "✓ OK しました" : "送信中…"}
          </Text>
        ) : (
          <View style={row}>
            <Pressable accessibilityRole="button" style={styles.btnRec} onPress={ok}>
              <Text style={styles.btnRecText}>OK(この見た目でよい)</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.btn} onPress={toggleChat}>
              <Text style={styles.btnText}>{chatOpen ? "▼ 閉じる" : "💬 直してほしい"}</Text>
            </Pressable>
          </View>
        )}
        {chatOpen && !approved ? (
          <CardChat
            itemId={item.id}
            itemKey={item.key}
            styles={styles}
            placeholder="直してほしい点を書く"
          />
        ) : null}
      </View>
      <Modal
        visible={zoomSource != null}
        transparent
        animationType="fade"
        onRequestClose={closeZoom}
      >
        <Pressable style={zoomWrap} onPress={closeZoom}>
          <Text style={zoomText}>
            {zoom === null ? "" : shotLabel(zoom, false)}(タップで閉じる)
          </Text>
          {zoomSource ? <Image source={zoomSource} style={zoomImg} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}
