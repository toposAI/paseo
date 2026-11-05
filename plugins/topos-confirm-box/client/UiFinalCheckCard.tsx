/**
 * 「UIの最終チェック」専用カード(案A。2026-11-05 ユーザー決定)。
 * 左の緑帯・チップ・PC/iPhone の完成版サムネ・直した点・OK / 直してほしい / 次へ。
 *
 * - 入力欄は1つ。右ペインと同じ会話部品(CardChatPane の embedded + PaneComposer)をカードの中に常に出す。
 *   送ると投函元へ届き、そのカードは「返事待ち」で残して次の未回答カードへ進む。
 * - 画像を開くと、画像ごとにコメントを付けて投函元へ送れる(送る文の先頭に画像名の印を付ける)。
 * - 今見ていないカードは1行に畳む(返事待ち・未読の返事あり・未回答)。畳んでも入力欄は載せたまま保つ。
 * 見ているカードの切り替え・件数は `useUfcFlow` / `shared/ufc-flow.ts`。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { splitShots, shotLabel, UFC_OK_ID } from "../shared/ui-final-check.js";
import { ufcStatus } from "../shared/ufc-flow.js";
import type { UfcCounts, UfcFlow } from "../shared/ufc-flow.js";
import { CardChatPane } from "./CardChatPane.js";
import type { PaneColors } from "./CardChatPane.js";
import { PaneComposer } from "./PaneComposer.js";
import { usePaneInputTools } from "./usePaneInputTools.js";

type Styles = Record<string, object>;

const FIX_PREFIX = "【直してほしい】";
const PC_BOX = { width: 176, height: 110 };
const PHONE_BOX = { width: 60, height: 110 };
const COMMENT_MAX = 4000;
const row = { flexDirection: "row" as const, gap: 8, alignItems: "flex-end" as const };
const rowWrap = { ...row, flexWrap: "wrap" as const, alignItems: "center" as const };
const bullets = { gap: 2 };
const hidden = { display: "none" as const };

function noop() {
  /* 埋め込みのペインには閉じる操作が無い */
}

/** 画像ごとのコメントに付ける印(どの画像へのコメントかを投函元に伝える)。 */
export function imageCommentText(label: string, text: string): string {
  return `【${label}へのコメント】${text.trim()}`;
}

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

/** 画像ビューア: 大きく見て、この画像へのコメントを投函元へ送る(入力欄は他と同じ部品)。 */
function ImageViewer({
  source,
  label,
  colors,
  send,
  onClose,
}: {
  source: { uri: string } | null;
  label: string;
  colors: PaneColors;
  send: ((text: string) => Promise<boolean>) | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const appendDictated = useCallback((said: string) => setText((cur) => cur + said), []);
  const tools = usePaneInputTools(appendDictated);
  const submit = useCallback(async () => {
    const t = text.trim();
    if (!t || !send) return;
    const ok = await send(imageCommentText(label, t));
    if (ok) {
      setText("");
      setNotice("");
      onClose();
    } else {
      setNotice("送れませんでした(投函元スレに届いていません)");
    }
  }, [text, send, label, onClose]);
  const submitPress = useCallback(() => void submit(), [submit]);
  const st = useMemo(
    () => ({
      wrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", paddingTop: 40 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, padding: 12 },
      title: { color: "#fff", fontSize: 14, flex: 1 },
      close: { color: "#fff", fontSize: 22, paddingHorizontal: 8 },
      body: { flex: 1, padding: 12 },
      img: { width: "100%" as const, flex: 1 },
      notice: { color: "#ffb4a8", fontSize: 12, padding: 8 },
      dock: { backgroundColor: colors.surface1, paddingBottom: 12 },
    }),
    [colors.surface1],
  );
  return (
    <Modal visible={source != null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={st.wrap}>
        <View style={st.bar}>
          <Text style={st.title}>{label}にコメント</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="閉じる" onPress={onClose}>
            <Text style={st.close}>✕</Text>
          </Pressable>
        </View>
        <View style={st.body}>
          {source ? <Image source={source} style={st.img} resizeMode="contain" /> : null}
        </View>
        {notice ? <Text style={st.notice}>{notice}</Text> : null}
        <View style={st.dock}>
          <PaneComposer
            colors={colors}
            text={text}
            onChangeText={setText}
            tools={tools}
            disabledReason={send ? null : "この画面では送れません"}
            placeholder="この画像へのコメント"
            maxLength={COMMENT_MAX}
            sendable={text.trim().length > 0 && send !== null}
            onSend={submitPress}
            testID="ufc-image-composer"
          />
        </View>
      </View>
    </Modal>
  );
}

const STATUS_TEXT = {
  open: "未回答",
  waiting: "返事待ち",
  unread: "💬 返事が届きました",
} as const;

export function UiFinalCheckCard({
  item,
  styles,
  colors,
  compact,
  width,
  agentId,
  flow,
  index,
  total,
  visited,
  nextExists,
  onChoose,
  onToggle,
  onSent,
  onReply,
  onSelect,
  onSkip,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  colors: PaneColors;
  compact: boolean;
  width: number;
  /** 投函元スレの agent ID(無ければ入力欄は総司令塔へ振り替える)。 */
  agentId: string | null;
  flow: UfcFlow;
  index: number;
  total: number;
  visited: boolean;
  nextExists: boolean;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
  onToggle: (id: string) => void;
  onSent: (id: string) => void;
  onReply: (id: string) => void;
  onSelect: (id: string) => void;
  onSkip: () => void;
}) {
  const [zoom, setZoom] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [focusN, setFocusN] = useState(0);
  const okRef = useRef(false);
  const sendRef = useRef<((text: string) => Promise<boolean>) | null>(null);
  const shots = useMemo(() => splitShots(item.images), [item.images]);
  const sources = useMemo(
    () => shots.finals.map((i) => ({ uri: `data:${i.mimeType};base64,${i.data}` })),
    [shots],
  );
  const ok = useCallback(() => {
    if (okRef.current) return;
    okRef.current = true;
    setSending(true);
    void onChoose(item, UFC_OK_ID).finally(() => {
      okRef.current = false;
      setSending(false);
    });
  }, [item, onChoose]);
  const focusInput = useCallback(() => setFocusN((n) => n + 1), []);
  const closeZoom = useCallback(() => setZoom(null), []);
  const header = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const select = useCallback(() => onSelect(item.id), [onSelect, item.id]);
  const sent = useCallback(() => onSent(item.id), [onSent, item.id]);
  const replied = useCallback(() => onReply(item.id), [onReply, item.id]);
  const sendImageComment = useCallback(async (text: string) => {
    const f = sendRef.current;
    return f ? f(text) : false;
  }, []);
  const approved = item.state === "approved";
  const isCurrent = flow.current === item.id;
  const status = ufcStatus(flow, item.id);
  const zoomSource = zoom === null ? null : (sources[zoom] ?? null);
  const fixes = useMemo(
    () =>
      (item.summary ?? "")
        .split("\n")
        .map((l) => l.replace(/^[-・*\s]+/, "").trim())
        .filter(Boolean),
    [item.summary],
  );
  const cell = useMemo(
    () => [styles.cell, { borderLeftWidth: 4, borderLeftColor: colors.accent }],
    [styles.cell, colors.accent],
  );
  const chip = useMemo(
    () => ({
      color: colors.accentForeground,
      backgroundColor: colors.accent,
      fontSize: 11,
      fontWeight: "600" as const,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 1,
      alignSelf: "flex-start" as const,
      overflow: "hidden" as const,
    }),
    [colors.accent, colors.accentForeground],
  );
  const stateChip = useMemo(
    () => ({
      color: status === "unread" ? colors.accentForeground : colors.accent,
      backgroundColor: status === "unread" ? colors.accent : "transparent",
      fontSize: 11,
      fontWeight: "600" as const,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 1,
      overflow: "hidden" as const,
    }),
    [status, colors.accent, colors.accentForeground],
  );

  // 見ていないカードは1行に畳む。会話を持つ(見たことがある)カードは入力欄を載せたまま隠す。
  const pane =
    !approved && (isCurrent || visited) ? (
      <View style={isCurrent ? undefined : hidden}>
        <CardChatPane
          item={item}
          agentId={agentId}
          colors={colors}
          compact={compact}
          width={width}
          onClose={noop}
          embedded
          sendRef={sendRef}
          messagePrefix={FIX_PREFIX}
          focusSignal={focusN}
          onSent={sent}
          onReply={replied}
        />
      </View>
    ) : null;

  if (!isCurrent && !approved) {
    return (
      <View style={cell}>
        <Pressable accessibilityRole="button" style={styles.card} onPress={select}>
          <View style={rowWrap}>
            <Text style={chip}>🖼 UIの最終チェック</Text>
            <Text style={stateChip}>{STATUS_TEXT[status]}</Text>
          </View>
          <Text style={styles.subject} numberOfLines={1}>
            {item.subject}
          </Text>
        </Pressable>
        {pane}
      </View>
    );
  }
  return (
    <View style={cell}>
      <View style={styles.card}>
        <Pressable accessibilityRole="button" onPress={header}>
          <View style={rowWrap}>
            <Text style={chip}>🖼 UIの最終チェック</Text>
            <Text style={styles.muted}>{approved ? "OK済み" : `${index + 1} / ${total}`}</Text>
          </View>
          <Text style={styles.subject}>{item.subject}</Text>
        </Pressable>
        <ScrollView horizontal contentContainerStyle={row}>
          {sources.map((source, i) => (
            <Thumb key={shotLabel(i, false)} source={source} index={i} onZoom={setZoom} />
          ))}
        </ScrollView>
        {fixes.length > 0 ? (
          <View style={bullets}>
            <Text style={styles.muted}>直した点</Text>
            {fixes.map((f) => (
              <Text key={f} style={styles.text}>
                ・{f}
              </Text>
            ))}
          </View>
        ) : null}
        {approved ? (
          <Text style={styles.text}>✓ OK しました</Text>
        ) : (
          <View style={rowWrap}>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              style={styles.btnRec}
              onPress={ok}
            >
              <Text style={styles.btnRecText}>{sending ? "送信中…" : "OK(この見た目でよい)"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.btn} onPress={focusInput}>
              <Text style={styles.btnText}>💬 直してほしい</Text>
            </Pressable>
            {nextExists ? (
              <Pressable accessibilityRole="button" style={styles.btn} onPress={onSkip}>
                <Text style={styles.btnText}>次へ ›</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        {pane}
      </View>
      <ImageViewer
        source={zoomSource}
        label={zoom === null ? "" : shotLabel(zoom, false)}
        colors={colors}
        send={approved ? null : sendImageComment}
        onClose={closeZoom}
      />
    </View>
  );
}

const barBox = { paddingTop: 8, paddingBottom: 4, gap: 6 };

/** 一覧の上の件数行。残り(返事待ちを除く)・返事待ち・未読の返事から1タップで戻る。 */
export function UfcBar({
  styles,
  colors,
  counts,
  everHad,
  unreadItems,
  onSelect,
}: {
  styles: Styles;
  colors: PaneColors;
  counts: UfcCounts;
  everHad: boolean;
  unreadItems: { id: string; subject: string }[];
  onSelect: (id: string) => void;
}) {
  if (counts.remaining + counts.waiting === 0) {
    return everHad ? <Text style={styles.text}>✓ UIの最終チェックは全部片付きました</Text> : null;
  }
  return (
    <View style={barBox}>
      <Text style={styles.text}>
        UIの最終チェック 残り {counts.remaining}件 · 返事待ち {counts.waiting}件
      </Text>
      {unreadItems.map((u) => (
        <UnreadJump key={u.id} u={u} styles={styles} colors={colors} onSelect={onSelect} />
      ))}
    </View>
  );
}

function UnreadJump({
  u,
  styles,
  colors,
  onSelect,
}: {
  u: { id: string; subject: string };
  styles: Styles;
  colors: PaneColors;
  onSelect: (id: string) => void;
}) {
  const press = useCallback(() => onSelect(u.id), [onSelect, u.id]);
  const label = useMemo(() => ({ color: colors.accent }), [colors.accent]);
  return (
    <Pressable accessibilityRole="button" style={styles.btn} onPress={press}>
      <Text style={styles.btnText} numberOfLines={1}>
        <Text style={label}>💬 返事が届きました</Text> {u.subject}
      </Text>
    </Pressable>
  );
}
