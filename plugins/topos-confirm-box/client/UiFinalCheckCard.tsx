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
import { Modal, Pressable, Text, View } from "react-native";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { shotLabel, UFC_OK_ID } from "../shared/ui-final-check.js";
import { ufcStatus } from "../shared/ufc-flow.js";
import type { UfcCounts, UfcFlow, UfcStatus } from "../shared/ufc-flow.js";
import { CardChatPane } from "./CardChatPane.js";
import type { PaneColors } from "./CardChatPane.js";
import { ImageCommentDock } from "./ImageCommentDock.js";
import { CardShot, CardTitle } from "./CardShot.js";
import { captionToShow } from "../shared/card-title.js";
import { useItemImageSources } from "./use-item-images.js";
import { ZoomableImage } from "./ZoomableImage.js";

type Styles = Record<string, object>;

const FIX_PREFIX = "【直してほしい】";
/** カード内の画像。1画像=1カードなので、カード幅いっぱいに大きく出す(タップで拡大)。 */
const shotRow = { gap: 10 };
const shotItem = { gap: 4 };
const row = { flexDirection: "row" as const, gap: 8, alignItems: "flex-end" as const };
const rowWrap = { ...row, flexWrap: "wrap" as const, alignItems: "center" as const };
const bullets = { gap: 2 };
const hidden = { display: "none" as const };

function noop() {
  /* 埋め込みのペインには閉じる操作が無い */
}

/**
 * 画像ごとのコメント文(定義は `shared/card-pane.ts`)。画面ごとに書き方がぶれないよう共通化した。
 * 先頭の固定の目印で、画像名の長さや記号に関係なく「返事不要の画像コメント」と機械が見分けられる。
 */
export { imageCommentText } from "../shared/card-pane.js";

/** カードに出す画像の1行キャプション。投函側の imageCaptions を優先し、無ければ従来の当て推量。 */
function shotCaption(item: { imageCaptions?: string[] }, index: number): string {
  return item.imageCaptions?.[index] ?? shotLabel(index, index >= 2);
}

/** 画像を出すのは開いているカードとOK済みのカードだけ(畳んだカードは取りに行かない)。 */
function showsImages(currentId: string | null, item: { id: string; state: string }): boolean {
  return currentId === item.id || item.state === "approved";
}

/** 画像ビューア: 大きく見て、この画像へのコメントを投函元へ送る(入力欄は他と同じ部品)。 */
function ImageViewer({
  source,
  label,
  colors,
  send,
  onDone,
  onClose,
}: {
  source: { uri: string } | null;
  label: string;
  colors: PaneColors;
  send: ((text: string) => Promise<boolean>) | null;
  /** カードを完了にして閉じる(コメントを送った後でも、送らずにでも押せる)。無ければボタンを出さない。 */
  onDone: (() => void) | null;
  onClose: () => void;
}) {
  const donePress = useCallback(() => {
    onDone?.();
    onClose();
  }, [onDone, onClose]);
  const st = useMemo(
    () => ({
      wrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", paddingTop: 40 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, padding: 12 },
      title: { color: "#fff", fontSize: 14, flex: 1 },
      close: { color: "#fff", fontSize: 22, paddingHorizontal: 8 },
      body: { flex: 1, padding: 12 },
    }),
    [],
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
          {source ? <ZoomableImage uri={source.uri} label={label} /> : null}
        </View>
        {/* コメント欄は共通部品(どの画像ビューアでも必ず出す)。送れたら完了にして閉じる。 */}
        <ImageCommentDock
          label={label}
          colors={colors}
          send={send}
          onDone={onDone ? donePress : null}
          testID="ufc-image-composer"
        />
      </View>
    </Modal>
  );
}

const STATUS_TEXT = {
  open: "未回答",
  waiting: "返事待ち",
  unread: "💬 返事が届きました",
} as const;

/**
 * 開いているカードのヘッダにも状態の印を出す(再読み込みで印が消えないようにするため)。
 * OK済み・未回答のときは何も出さない。分岐をここへ出してカード本体の複雑さを増やさない。
 */
function CardStateMark({
  approved,
  status,
  style,
}: {
  approved: boolean;
  status: UfcStatus;
  style: object;
}) {
  if (approved || status === "open") return null;
  return <Text style={style}>{STATUS_TEXT[status]}</Text>;
}

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
  onDone,
  onToggle,
  onSent,
  onReply,
  onSelect,
  onSeen,
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
  /** 完了にして閉じる(数秒は元に戻せる)。コメントを送った後に閉じるための操作。 */
  onDone: (item: ConfirmBoxItem) => void;
  onToggle: (id: string) => void;
  onSent: (id: string) => void;
  onReply: (id: string) => void;
  onSelect: (id: string) => void;
  /** そのカードの会話を開いた(返事を読んだ)ことを台帳へ書く。 */
  onSeen: (id: string) => void;
  onSkip: () => void;
}) {
  const [zoom, setZoom] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [focusN, setFocusN] = useState(0);
  const okRef = useRef(false);
  const sendRef = useRef<((text: string) => Promise<boolean>) | null>(null);
  // 1画像=1カード(2026-11-06 ユーザー指示)。完成版/変更前で絞らず、そのカードの画像を全部出す。
  // 畳んだカードは画像を出さないので取りに行かない(開いたときに取る)。
  const sources = useItemImageSources(item, showsImages(flow.current, item));
  const ok = useCallback(() => {
    if (okRef.current) return;
    okRef.current = true;
    setSending(true);
    void onChoose(item, UFC_OK_ID).finally(() => {
      okRef.current = false;
      setSending(false);
    });
  }, [item, onChoose]);
  // 会話を開く(💬)か、畳んだカードを開いたら「その返事は見た」と台帳へ書く。
  // 画面に出ているだけでは既読にしない: 再読み込み・絞り込み切替で印が勝手に消えないため。
  const focusInput = useCallback(() => {
    onSeen(item.id);
    setFocusN((n) => n + 1);
  }, [onSeen, item.id]);
  const closeZoom = useCallback(() => setZoom(null), []);
  const done = useCallback(() => onDone(item), [onDone, item]);
  const header = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const select = useCallback(() => {
    onSelect(item.id);
    onSeen(item.id);
  }, [onSelect, onSeen, item.id]);
  const sent = useCallback(() => onSent(item.id), [onSent, item.id]);
  // 開いているカードに返事が届いたら、その場で読んだものとして台帳へ書く。
  // 書かないと、再読み込みのたびに未読の印がよみがえる(2026-11-05)。
  const isOpenCard = flow.current === item.id;
  const replied = useCallback(() => {
    onReply(item.id);
    if (isOpenCard) onSeen(item.id);
  }, [isOpenCard, onReply, onSeen, item.id]);
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

  // 畳む/開くで pane の位置と親を変えない(変えるとペインがマウントし直され、返事の検知と下書きが消える)。
  const collapsed = !isCurrent && !approved;
  return (
    <View style={cell}>
      <View style={styles.card}>
        {collapsed ? (
          <Pressable accessibilityRole="button" onPress={select}>
            <View style={rowWrap}>
              <Text style={chip}>🖼 UIの最終チェック</Text>
              <Text style={stateChip}>{STATUS_TEXT[status]}</Text>
            </View>
            <CardTitle subject={item.subject} style={styles.subject} numberOfLines={1} />
          </Pressable>
        ) : (
          <>
            <Pressable accessibilityRole="button" onPress={header}>
              <View style={rowWrap}>
                <Text style={chip}>🖼 UIの最終チェック</Text>
                <Text style={styles.muted}>{approved ? "OK済み" : `${index + 1} / ${total}`}</Text>
                {/* 開いているカードでも、返事待ち・未読は消さずに出す(再読み込みで印が消えないため)。 */}
                <CardStateMark approved={approved} status={status} style={stateChip} />
              </View>
              <CardTitle subject={item.subject} style={styles.subject} />
            </Pressable>
            <View style={shotRow}>
              {sources.map((source, i) => (
                <View key={source.key} style={shotItem}>
                  <CardShot
                    source={source}
                    index={i}
                    label={shotCaption(item, i)}
                    onZoom={setZoom}
                  />
                  {captionToShow(shotCaption(item, i), item.subject) ? (
                    <Text style={styles.muted}>{shotCaption(item, i)}</Text>
                  ) : null}
                </View>
              ))}
            </View>
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
              <>
                <View style={rowWrap}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={sending}
                    style={styles.btnRec}
                    onPress={ok}
                  >
                    <Text style={styles.btnRecText}>
                      {sending ? "送信中…" : "OK(この見た目でよい)"}
                    </Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" style={styles.btn} onPress={focusInput}>
                    <Text style={styles.btnText}>💬 直してほしい</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="このカードを完了にして閉じる"
                    style={styles.btn}
                    onPress={done}
                  >
                    <Text style={styles.btnText}>完了</Text>
                  </Pressable>
                  {nextExists ? (
                    <Pressable accessibilityRole="button" style={styles.btn} onPress={onSkip}>
                      <Text style={styles.btnText}>次へ ›</Text>
                    </Pressable>
                  ) : null}
                </View>
                {/* 投函元のスレがもう無いカードでも「返事待ち」は消さない(返事は総司令塔へ振り替わる)。
                    そのことが分かるよう、印の意味だけ1行で添える。 */}
                {status === "waiting" && agentId === null ? (
                  <Text style={styles.muted}>
                    投函元のスレが無いので、返事は総司令塔から届きます
                  </Text>
                ) : null}
              </>
            )}
          </>
        )}
        {pane}
      </View>
      {collapsed ? null : (
        <ImageViewer
          source={zoomSource}
          label={zoom === null ? "" : shotCaption(item, zoom)}
          colors={colors}
          send={approved ? null : sendImageComment}
          onDone={done}
          onClose={closeZoom}
        />
      )}
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
