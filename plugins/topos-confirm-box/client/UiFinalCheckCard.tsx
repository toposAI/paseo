/**
 * 「UIの最終チェック」専用カード(案A。2026-11-05 ユーザー決定)。
 * 左の緑帯・チップ・PC/iPhone の完成版サムネ・直した点・OK / 直してほしい / 次へ。
 *
 * - 入力欄は1つ。右ペインと同じ会話部品(CardChatPane の embedded + PaneComposer)をカードの中に常に出す。
 *   送ると投函元へ届き、そのカードは「返事待ち」で残して次の未回答カードへ進む(画像への直接コメントは
 *   返事を求めないので進めず、そのカードのまま留まる。2026-11-08)。
 * - 画像を開くと、画像ごとにコメントを付けられる(送る文の先頭に画像名の印を付ける)。コメントはその場では
 *   送らず、カード側に溜めて「完了」で1通にまとめて投函元へ送る(2026-11-08 ユーザー逐語「全ての画像に
 *   コメントして完了ボタンを押したときに全部まとめて飛ばせばよくない？」)。送れたら完了にして閉じる。
 *   OK・次へでカードを離れるときも取りこぼさないよう、溜めがあれば先に同じ送信を1回行う。
 *   溜めはモジュール側の Map(キーは item.id)に置き、再描画・タブ切替でカードが消えても失わない。
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

/**
 * 溜めた画像コメントを1通にまとめて送る(空なら送るものが無いので成功扱い)。
 * 送れなければ false を返し、呼び出し側は溜めた内容を残して閉じない。
 */
async function flushImageComments(
  pending: string[],
  send: ((text: string) => Promise<boolean>) | null,
): Promise<boolean> {
  if (pending.length === 0) return true;
  if (!send) return false;
  return send(pending.join("\n\n"));
}

/**
 * 画像ごとのコメントの溜め。カードのコンポーネントの外(モジュール)に置く。
 * タブ切替・絞り込み・OK 後の再描画でカードが消えても溜めたコメントを失わないため(2026-11-08)。
 * キーは item.id なので、別のカードの溜めと混ざらない。永続化はしない(アプリ再起動で消えてよい)。
 */
const pendingByItem = new Map<string, string[]>();

/**
 * いままとめ送信中のカード。溜めの掃除(`prunePending`)から外すために持つ。
 * 送信中に掃除すると、送信結果の反映先(件数)が消えるため(2026-11-08 出口レビュー2巡目 低1)。
 */
const flushingItems = new Set<string>();

/** そのカードに溜まっている画像コメント(無ければ空配列)。 */
function pendingOf(id: string): string[] {
  return pendingByItem.get(id) ?? [];
}

/** 画像コメントを1件溜める。 */
function addPending(id: string, text: string): void {
  pendingByItem.set(id, [...pendingOf(id), text]);
}

/** 送れた(または捨てると決めた)カードの溜めを消す。 */
function clearPending(id: string): void {
  pendingByItem.delete(id);
}

/**
 * 送った分(先頭から count 件)だけを溜めから取り除き、残りを残す。
 * まとめ送信中に足されたコメントを黙って消さないため(2026-11-08 出口レビュー2巡目 中1)。残り件数を返す。
 */
function dropPending(id: string, count: number): number {
  const left = pendingOf(id).slice(count);
  if (left.length === 0) {
    clearPending(id);
    return 0;
  }
  pendingByItem.set(id, left);
  return left.length;
}

/**
 * 一覧に居ないカードの溜めを捨てる(カードが片付いて二度と戻らないのに溜めだけ残るのを防ぐ)。
 * 送信中の id は落とさない(送信結果の反映先が消えないように)。一覧を取り直すたびに呼ぶ。
 */
export function prunePending(keepIds: readonly string[]): void {
  const keep = new Set(keepIds);
  // Map の反復中に delete してよい(消した項目は以降に現れない)。
  for (const id of pendingByItem.keys()) {
    if (keep.has(id) || flushingItems.has(id)) continue;
    pendingByItem.delete(id);
  }
}

/** 完了(OK)ボタンを押せないか。まとめ送信中も押せない(押しても黙って何も起きない状態を作らない)。 */
function okDisabled(sending: boolean, flushing: boolean): boolean {
  return sending || flushing;
}

/**
 * 画像コメントを受け付ける送信口。OK済みとまとめ送信中のときは null(入力欄を閉じる)。
 * 分岐をカード本体へ書かずに済ませるため、ここへ出してある。
 */
function commentSend(
  approved: boolean,
  flushing: boolean,
  send: (text: string) => Promise<boolean>,
): ((text: string) => Promise<boolean>) | null {
  if (approved || flushing) return null;
  return send;
}

/** 完了ボタンの文字。まとめ送信中は押せないことが分かるよう「送信中…」にする。 */
function doneText(flushing: boolean): string {
  return flushing ? "送信中…" : "完了";
}

/** 完了ボタンの下に出す1行(溜めた件数、またはまとめ送信の失敗)。出すものが無ければ null。 */
function pendingNote(failed: boolean, count: number): string | null {
  if (failed) {
    return "まとめて送れませんでした(溜めたコメントは残っています。もう一度ボタンで送り直せます)";
  }
  if (count > 0) return `コメント${count}件をまとめて送ります`;
  return null;
}

/**
 * 溜めた画像コメントの件数・失敗の1行と、失敗したときだけ出す逃げ道。
 * 送れない環境(投函元も総司令塔も引けない等)でカードを閉じられなくならないようにする。
 * 押すとコメントを捨てて閉じるが、黙って捨てないよう失敗時だけこのボタンを出す。
 */
function PendingFoot({
  flushFailed,
  count,
  styles,
  onDiscard,
}: {
  flushFailed: boolean;
  count: number;
  styles: Styles;
  onDiscard: () => void;
}) {
  const note = pendingNote(flushFailed, count);
  return (
    <>
      {note ? <Text style={styles.muted}>{note}</Text> : null}
      {flushFailed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="コメントを送らずに完了"
          style={styles.btn}
          onPress={onDiscard}
        >
          <Text style={styles.btnText}>コメントを送らずに完了</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/** 画像ビューア: 大きく見て、この画像へのコメントを溜める(入力欄は他と同じ部品)。 */
function ImageViewer({
  source,
  label,
  colors,
  send,
  disabledReason,
  onClose,
}: {
  source: { uri: string } | null;
  label: string;
  colors: PaneColors;
  send: ((text: string) => Promise<boolean>) | null;
  /** 送れない理由(まとめ送信中など)。入力欄の代わりに出す。 */
  disabledReason?: string | null;
  onClose: () => void;
}) {
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
        {/* コメント欄は共通部品(どの画像ビューアでも必ず出す)。溜めるだけでカードは閉じない(2026-11-08)。 */}
        <ImageCommentDock
          label={label}
          colors={colors}
          send={send}
          disabledReason={disabledReason}
          testID="ufc-image-composer"
          sentNotice="コメントを控えました(完了でまとめて送ります)"
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
  /** 完了にして閉じる(数秒は元に戻せる)。カードの「完了」ボタン専用。画像コメントでは呼ばない。 */
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
  // 画像ごとのコメントはその場で送らず、モジュール側の Map に溜めて「完了」で1通にまとめる
  // (2026-11-08 ユーザー指示)。カードが消えても失わないよう、件数はマウント時に Map から読む。
  const [pendingN, setPendingN] = useState(() => pendingOf(item.id).length);
  // まとめ送信中は「完了」の押し直しを無視する(二重送信を防ぐ)。
  const [flushing, setFlushing] = useState(false);
  const flushingRef = useRef(false);
  const [flushFailed, setFlushFailed] = useState(false);
  // 1画像=1カード(2026-11-06 ユーザー指示)。完成版/変更前で絞らず、そのカードの画像を全部出す。
  // 畳んだカードは画像を出さないので取りに行かない(開いたときに取る)。
  const sources = useItemImageSources(item, showsImages(flow.current, item));
  /**
   * 溜めた画像コメントを1通にまとめて送る。成功したら溜めを消して true、失敗したら残して false。
   * 溜めが空なら送らずに true(OK/次へで余計な送信をしない)。完了・OK・次への3経路がこれを通る。
   */
  const flushPending = useCallback(async (): Promise<boolean> => {
    if (flushingRef.current) return false;
    // 送る配列はここで確定させる(送信中に足されたコメントを巻き込まない)。コピーなので、
    // 送信の間に溜めへ足されても、この配列が書き換わることはない。
    const snapshot = [...pendingOf(item.id)];
    if (snapshot.length === 0) return true;
    flushingRef.current = true;
    flushingItems.add(item.id);
    setFlushing(true);
    let sent = false;
    try {
      sent = await flushImageComments(snapshot, sendRef.current);
    } finally {
      flushingRef.current = false;
      flushingItems.delete(item.id);
      setFlushing(false);
    }
    // 送れなかったら溜めた内容は残す(もう一度ボタンを押せば送り直せる)。
    if (!sent) {
      setFlushFailed(true);
      return false;
    }
    // 送れた分だけ消す。送信中に足されたコメントは残し、件数表示も残数へ更新する(中1)。
    const left = dropPending(item.id, snapshot.length);
    setPendingN(left);
    setFlushFailed(false);
    return true;
  }, [item.id]);
  const ok = useCallback(async () => {
    if (okRef.current) return;
    okRef.current = true;
    setSending(true);
    try {
      // 溜めたコメントを取りこぼさないよう、OK でも先にまとめて送る。送れなければ OK にしない。
      if (!(await flushPending())) return;
      await onChoose(item, UFC_OK_ID);
    } finally {
      okRef.current = false;
      setSending(false);
    }
  }, [flushPending, item, onChoose]);
  // 「次へ」も同じ。送れなければ次へ進まず、エラーを出して溜めを残す。
  const next = useCallback(async () => {
    if (!(await flushPending())) return;
    onSkip();
  }, [flushPending, onSkip]);
  // 送れない環境の逃げ道。押したらコメントを捨てて閉じる(黙って捨てないよう、失敗時だけ出す)。
  const discardAndDone = useCallback(() => {
    clearPending(item.id);
    setPendingN(0);
    setFlushFailed(false);
    onDone(item);
  }, [item, onDone]);
  // 会話を開く(💬)か、畳んだカードを開いたら「その返事は見た」と台帳へ書く。
  // 画面に出ているだけでは既読にしない: 再読み込み・絞り込み切替で印が勝手に消えないため。
  const focusInput = useCallback(() => {
    onSeen(item.id);
    setFocusN((n) => n + 1);
  }, [onSeen, item.id]);
  const closeZoom = useCallback(() => setZoom(null), []);
  const done = useCallback(async () => {
    // 送れなかったら閉じない(溜めた内容は残して、もう一度「完了」で送り直せる)。
    if (!(await flushPending())) return;
    onDone(item);
  }, [flushPending, onDone, item]);
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
  // 画像コメントは送らずに溜めるだけ(印は ImageCommentDock 側で各コメントの先頭に付いている)。
  // true を返すのは、入力欄を空にして「控えました」を出させるため。
  const sendImageComment = useCallback(
    async (text: string) => {
      addPending(item.id, text);
      setPendingN(pendingOf(item.id).length);
      setFlushFailed(false);
      return true;
    },
    [item.id],
  );
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
                  {/* まとめ送信中も押せない(押しても黙って何も起きない状態を作らない)。 */}
                  <Pressable
                    accessibilityRole="button"
                    disabled={okDisabled(sending, flushing)}
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
                    disabled={flushing}
                    style={styles.btn}
                    onPress={done}
                  >
                    <Text style={styles.btnText}>{doneText(flushing)}</Text>
                  </Pressable>
                  {nextExists ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={flushing}
                      style={styles.btn}
                      onPress={next}
                    >
                      <Text style={styles.btnText}>次へ ›</Text>
                    </Pressable>
                  ) : null}
                </View>
                <PendingFoot
                  flushFailed={flushFailed}
                  count={pendingN}
                  styles={styles}
                  onDiscard={discardAndDone}
                />
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
          // まとめ送信中はコメントを足せない(足しても送った配列に入らず、残りとして次回に回るため)。
          send={commentSend(approved, flushing, sendImageComment)}
          disabledReason={flushing ? "まとめて送信中です(終わると足せます)" : null}
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
