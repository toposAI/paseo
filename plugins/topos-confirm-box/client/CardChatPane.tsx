/**
 * カード専用のチャットペイン。
 *
 * 2026-10-22 ユーザー決定(逐語は `coordinator_decisions.md` 末尾):
 * **確認箱のコメントボタン = 投函元スレのチャットを開く**。
 * したがってこのペインの相手は「投函元スレのエージェント」であり、箱側の質問→応答ワーカー
 * (9ec05eb92/0627b40c9 の返信行方式)は使わない。ペインで送った文は元スレへユーザー発言として
 * 届き、元スレの応答がそのままここへ流れてくる(=投函元スレと双方向)。
 *
 * ここは画面導線だけを持つ:
 * - PC幅: 一覧の右側に並べる(一覧は残る)
 * - 狭い幅(iPhone): 右から全画面でスライドインし、右スワイプ/戻るボタンで閉じる
 *
 * 投函に `thread_ref` が無い項目(手動投函・承認待ち)、または投函元が閉じているカードは
 * (2026-10-24〜)送信先を総司令塔へ自動で振り替える。送信欄は有効のまま、下に振り替えの説明を出し、
 * 送る発言の先頭にカード題名とIDを付ける。総司令塔の返事は**振り替えで送った後からだけ**流す
 * (総司令塔は他の仕事の出力も出すので、送る前から購読すると無関係な出力が混ざる)。
 * スレ直接(`item` 無し)は対象外で従来どおり止める。
 *
 * 2026-10-23: 優先順位ページの行タップ(担当スレ)も同じペインを使う。その場合 `item` は無く
 * `title` だけを持つ。投函元/担当スレがアーカイブ済み・ワークスペースが閉じている時は
 * 「投函元が閉じています」を出して送信を止める。
 *
 * 生死の判定:
 * - スレ自身 … `handle.refresh()`(`fetch_agent` はアーカイブ済みも返す)の `archivedAt`、以降は購読の upsert/remove
 * - ワークスペース … 生きているワークスペースの一覧(`workspaces.list`)に載っているか。
 *   一覧はアーカイブ済みを返さないので「在る=開ける、無い=閉じた」。ページは1回だけで足りる
 *   (判定はペインに今開いている相手1本だけなので、`server/thread-liveness.ts` のように全件を辿らない)。
 * 引けなかったときは**印を付けない**(不明を「閉じています」と言い換えない)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { getPaseoClient, useHosts, useRpc } from "@getpaseo/plugin/client";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { KIND_LABEL, PRIORITY_LABEL, coordinatorTargetRpc } from "../shared/contract.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
import {
  COORDINATOR_FALLBACK_NOTICE,
  shouldFallbackToCoordinator,
  threadUnavailableReason,
  withCardHeader,
} from "../shared/card-pane.js";
import type { ThreadAccess } from "../shared/child-threads.js";
import { PANE_ACTIVITY_LABEL, nextPaneActivity } from "../shared/pane-activity.js";
import type { PaneActivity, PaneActivityEvent } from "../shared/pane-activity.js";
import { usePaneResize } from "./usePaneResize.js";

// Paseo のモバイルパネルと同じ 220ms / 同じイージング
// (`packages/app/src/mobile-panels/provider.tsx:41-42` の ANIMATION_DURATION / ANIMATION_EASING)。
const SLIDE_MS = 220;
const SLIDE_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);
/** 開いた時に読む履歴の件数(元スレの直近だけ。全履歴は重い)。 */
const HISTORY_LIMIT = 30;
/** 送信欄の上限。Paseo の composer に合わせた素朴な値(サーバ側で切り詰めはしない)。 */
const TEXT_MAX = 4000;
/** 生死(アーカイブ済みか)の見直し間隔。購読で拾えない経路(別端末からのアーカイブ等)の取りこぼし用。 */
const LIVENESS_MS = 60_000;

export type PaneColors = PluginHostProps["theme"]["colors"];

/** 元スレのタイムライン項目(必要な形だけ)。 */
interface TimelineItemLike {
  type?: string;
  text?: string;
}

interface ChatLine {
  id: string;
  role: "user" | "assistant";
  text: string;
}

function itemStatus(item: TimelineItemLike | undefined): string | undefined {
  return (item as { status?: string } | undefined)?.status;
}

function lineFromItem(item: TimelineItemLike | undefined, id: string): ChatLine | null {
  if (!item?.text) return null;
  if (item.type === "user_message") return { id, role: "user", text: item.text };
  if (item.type === "assistant_message") return { id, role: "assistant", text: item.text };
  return null;
}

/** assistant の連続ストリーム断片は直前の assistant 行へ連結する(`ChatDock.tsx` と同じ)。 */
function appendLine(lines: ChatLine[], next: ChatLine): ChatLine[] {
  const last = lines[lines.length - 1];
  if (last && last.role === "assistant" && next.role === "assistant") {
    return [...lines.slice(0, -1), { ...last, text: last.text + next.text }];
  }
  return [...lines, next];
}

/** 送信可否。相手が特定できていて、閉じておらず、空でなく、送信中でないこと。 */
function canSend(
  text: string,
  agentId: string | null,
  serverId: string | null,
  busy: boolean,
  closed: boolean,
) {
  return Boolean(agentId && serverId) && !busy && !closed && text.trim().length > 0;
}

/**
 * 相手スレの生死。`archivedAt`=スレ自身のアーカイブ、`workspaceLive`=所属ワークスペースが
 * 生きている一覧に載っていた(null=引けなかった)。どちらも「不明」は null のままで、
 * 閉じていると分かった時だけ値を入れる(不明を「閉じています」と言い換えない)。
 */
interface Liveness {
  archivedAt: string | null;
  workspaceLive: boolean | null;
}

const UNKNOWN_LIVENESS: Liveness = { archivedAt: null, workspaceLive: null };

function toAccess(l: Liveness): ThreadAccess | null {
  if (l.archivedAt != null) return "thread-archived";
  if (l.workspaceLive === false) return "workspace-archived";
  return null;
}

/** 論点の見出し(何についての会話かを、スレの履歴より先に見せる)。 */
function CardContext({
  item,
  title,
  styles: st,
}: {
  item: ConfirmBoxItem | null;
  title?: string;
  styles: {
    context: object;
    contextBadge: object;
    contextSubject: object;
    contextBackground: object;
  };
}) {
  return (
    <View style={st.context}>
      {item ? (
        <>
          <Text style={st.contextBadge}>
            {PRIORITY_LABEL[item.priority]} · {KIND_LABEL[item.kind]}
            {item.state === "approved" ? " · 決定済み" : ""}
          </Text>
          <Text style={st.contextSubject}>{item.subject}</Text>
          {item.background ? <Text style={st.contextBackground}>{item.background}</Text> : null}
        </>
      ) : (
        <Text style={st.contextSubject}>{title ?? "投函元スレのチャット"}</Text>
      )}
    </View>
  );
}

export function CardChatPane({
  item,
  agentId,
  title,
  colors,
  compact,
  width,
  onClose,
  onOpenThread,
}: {
  item: ConfirmBoxItem | null;
  /** 投函元スレの agent ID(`threadAgentId(item)` の結果)。無ければ null。 */
  agentId: string | null;
  /** 見出し。優先順位の行タップ(カード無し)では台帳のプロジェクト名。 */
  title?: string;
  colors: PaneColors;
  compact: boolean;
  width: number;
  onClose: () => void;
  /** 元スレを Paseo のスレ画面で開く(`navigation.openAgent`)。無い画面では undefined。 */
  onOpenThread?: (() => void) | undefined;
}) {
  const hosts = useHosts();
  const serverId = hosts.find((h) => h.status === "online")?.serverId ?? null;
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  // 「届いたか」の表示。送信直後=送信済み、以降は相手スレの購読で取れた事実だけで進む。
  const [activity, setActivity] = useState<PaneActivity | null>(null);
  const pushActivity = useCallback(
    (ev: PaneActivityEvent) => setActivity((cur) => nextPaneActivity(cur, ev)),
    [],
  );
  // 総司令塔へ振り替えて1回でも送ったか。返事の購読はこの後だけ(相手/カードを変えたら戻す)。
  const [coordSent, setCoordSent] = useState(false);
  // 総司令塔のID(サーバが起こしデーモンの正本から読む。undefined=未取得、null=見つからない)と、閉じているか。
  const coordinatorRpc = useRpc(coordinatorTargetRpc);
  const [coordId, setCoordId] = useState<string | null | undefined>(undefined);
  const [coordClosed, setCoordClosed] = useState(false);
  const [liveness, setLiveness] = useState<Liveness>(UNKNOWN_LIVENESS);
  // 同じ描画フレーム内の二度押しで同じ文を2件送らない。
  const sendingRef = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const seq = useRef(0);

  // 相手を変えたら前の相手の生死を持ち越さない(前のスレが閉じていると新しいスレまで閉じて見える)。
  useEffect(() => setLiveness(UNKNOWN_LIVENESS), [agentId, serverId]);
  useEffect(() => setCoordSent(false), [agentId, serverId, item?.id]);
  useEffect(() => setActivity(null), [agentId, serverId, item?.id]);

  const access = toAccess(liveness);
  const closedText = threadUnavailableReason(access, item ? "card" : "thread");
  // 投函元が無い/閉じているカードは総司令塔へ振り替える(スレ直接=item無しは対象外)。
  const fallback = shouldFallbackToCoordinator({ hasCard: item !== null, agentId, closedText });
  const sendAgentId = fallback ? (coordId ?? null) : agentId;
  const reason = useMemo(() => {
    if (fallback) {
      if (!serverId) return "ホストに接続できません";
      if (coordId === null) return "総司令塔が見つかりません(送信できません)";
      if (coordClosed) return "総司令塔も閉じています(送信できません)";
      return null;
    }
    // スレ直接(優先順位の行)はカードが無いのが正常なので、カードの有無を先に問わない。
    if (!agentId) {
      if (!item) return "このカードは一覧にありません(決定済みか、URLのカードIDが違います)";
      return "投函元スレがありません(投函に thread_ref が付いていません)";
    }
    if (!serverId) return "ホストに接続できません";
    return closedText;
  }, [fallback, coordId, coordClosed, item, agentId, serverId, closedText]);

  // 元スレの履歴 + 購読。カードを切り替えると前のスレの応答が後から届くので、
  // 生きている間だけ反映する(alive フラグ)うえで、履歴は読み直す。
  useEffect(() => {
    setLines([]);
    setNotice("");
    if (!agentId || !serverId) return undefined;
    const handle = getPaseoClient(serverId).agents.ref(agentId);
    let alive = true;
    handle.timeline
      .refetch({ limit: HISTORY_LIMIT })
      .then((res) => {
        if (!alive) return null;
        const past: ChatLine[] = [];
        (res.entries ?? []).forEach((entry, idx) => {
          const line = lineFromItem(entry.item as TimelineItemLike, `h${idx}`);
          if (line) past.push(line);
        });
        setLines((cur) => (cur.length === 0 ? past : cur));
        return null;
      })
      .catch(() => {
        // 履歴が読めなくても会話は続けられる(送るたびに購読側で増える)。
      });
    const sub = handle.timeline.subscribe((evt) => {
      if (!alive) return;
      const ev = (evt as { event?: { type?: string; item?: TimelineItemLike } }).event;
      if (ev?.type !== "timeline") return;
      pushActivity({ kind: "item", itemType: ev.item?.type, status: itemStatus(ev.item) });
      // ユーザー発言は送信時に表示済み(二重表示を避ける)。
      if (ev.item?.type !== "assistant_message") return;
      seq.current += 1;
      const line = lineFromItem(ev.item, `s${seq.current}`);
      if (line) setLines((cur) => appendLine(cur, line));
    });
    return () => {
      alive = false;
      sub();
    };
  }, [agentId, serverId, pushActivity]);

  // 振り替える時だけ総司令塔のIDを引き、閉じていないか確かめる(閉じていれば送信を止める)。
  useEffect(() => {
    if (!fallback || !serverId) return undefined;
    let alive = true;
    setCoordClosed(false);
    coordinatorRpc({})
      .then(async (res) => {
        if (!alive) return;
        setCoordId(res.agentId);
        if (!res.agentId) return;
        const snap = await getPaseoClient(serverId).agents.ref(res.agentId).refresh();
        if (!alive) return;
        const archivedAt = (snap?.agent as { archivedAt?: string | null } | undefined)?.archivedAt;
        setCoordClosed(archivedAt != null);
      })
      .catch(() => {
        // 引けないだけ。IDが取れていれば送信は試せる(失敗は通知欄に出る)。
      });
    return () => {
      alive = false;
    };
  }, [fallback, serverId, coordinatorRpc]);

  // 総司令塔へ振り替えて送った後だけ、その返事を購読して流す(履歴は読まない=総司令塔の会話が混ざらない)。
  useEffect(() => {
    if (!fallback || !coordSent || !serverId || !coordId) return undefined;
    let alive = true;
    const off = getPaseoClient(serverId)
      .agents.ref(coordId)
      .timeline.subscribe((evt) => {
        if (!alive) return;
        const ev = (evt as { event?: { type?: string; item?: TimelineItemLike } }).event;
        if (ev?.type !== "timeline") return;
        pushActivity({ kind: "item", itemType: ev.item?.type, status: itemStatus(ev.item) });
        if (ev.item?.type !== "assistant_message") return;
        seq.current += 1;
        const line = lineFromItem(ev.item, `f${seq.current}`);
        if (line) setLines((cur) => appendLine(cur, line));
      });
    const offStatus = getPaseoClient(serverId)
      .agents.ref(coordId)
      .subscribe((update) => {
        if (!alive || update.kind !== "upsert") return;
        pushActivity({
          kind: "agent-status",
          status: (update.agent as { status?: string }).status,
        });
      });
    return () => {
      alive = false;
      off();
      offStatus();
    };
  }, [fallback, coordSent, coordId, serverId, pushActivity]);

  // 生死。引けなかった時は印を付けない(不明を「閉じています」と言い換えない)。
  useEffect(() => {
    setLiveness(UNKNOWN_LIVENESS);
    if (!agentId || !serverId) return undefined;
    const client = getPaseoClient(serverId);
    const handle = client.agents.ref(agentId);
    let alive = true;
    const off = handle.subscribe((update) => {
      if (!alive) return;
      const archivedAt =
        update.kind === "upsert"
          ? ((update.agent as { archivedAt?: string | null }).archivedAt ?? null)
          : "removed"; // remove = 一覧から消えた(アーカイブ/削除)。どちらも閉じた扱い。
      setLiveness((l) => ({ ...l, archivedAt }));
      if (update.kind === "upsert") {
        pushActivity({
          kind: "agent-status",
          status: (update.agent as { status?: string }).status,
        });
      }
    });
    // 生きているワークスペースだけを返す一覧(アーカイブ済みは載らない)。
    const liveIds = () =>
      client.workspaces
        .list()
        .then((res) => new Set((res.entries ?? []).map((w) => w.id)))
        .catch(() => null);
    const check = async () => {
      try {
        const [res, live] = await Promise.all([handle.refresh(), liveIds()]);
        if (!alive) return;
        const snapshot = (res?.agent ?? null) as {
          workspaceId?: string;
          archivedAt?: string | null;
        } | null;
        const workspaceLive = live && snapshot?.workspaceId ? live.has(snapshot.workspaceId) : null;
        setLiveness((l) => ({
          archivedAt: snapshot ? (snapshot.archivedAt ?? null) : l.archivedAt,
          // 一覧が引けなかった時(null)は既知の印を保つ(振り替え先が60秒ごとに揺れない)。
          workspaceLive: workspaceLive ?? l.workspaceLive,
        }));
      } catch {
        // 取れないだけ。印は付けずに会話は続けられる。
      }
    };
    const timer = setInterval(() => void check(), LIVENESS_MS);
    void check();
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, [agentId, serverId, pushActivity]);

  // 新しい行が来たら最下部へ。件数ではなく末尾の行を見る(断片の連結で件数が増えないため)。
  const lastLine = lines.at(-1);
  const lastKey = lastLine ? `${lastLine.id}:${lastLine.text.length}` : "";
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [lastKey]);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || !sendAgentId || !serverId || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setText("");
    seq.current += 1;
    setLines((cur) => [...cur, { id: `u${seq.current}`, role: "user", text: t }]);
    try {
      const outgoing = fallback && item ? withCardHeader(t, item) : t;
      await getPaseoClient(serverId).agents.ref(sendAgentId).send(outgoing);
      if (fallback) setCoordSent(true);
      pushActivity({ kind: "sent" });
      setNotice("");
    } catch (e) {
      setNotice(`送れません: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [text, sendAgentId, serverId, fallback, item, pushActivity]);
  const sendPress = useCallback(() => void send(), [send]);

  // --- 全画面スライド(狭い幅のみ) ---
  const { paneWidth, resizeHandlers } = usePaneResize(width);
  const translateX = useRef(new Animated.Value(0)).current;
  const widthRef = useRef(width);
  widthRef.current = width;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const animateClose = useCallback(() => {
    Animated.timing(translateX, {
      toValue: widthRef.current,
      duration: 180,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    }).start(() => onCloseRef.current());
  }, [translateX]);

  useEffect(() => {
    if (!compact) return;
    translateX.setValue(widthRef.current);
    Animated.timing(translateX, {
      toValue: 0,
      duration: SLIDE_MS,
      easing: SLIDE_EASING,
      useNativeDriver: false,
    }).start();
  }, [compact, translateX]);

  const animateCloseRef = useRef(animateClose);
  animateCloseRef.current = animateClose;
  const pan = useMemo(
    () =>
      PanResponder.create({
        // 横方向に十分動いたときだけ拾う(縦スクロール・本文選択を邪魔しない)。
        // 向きは**右**。ペインは右から入ってくるので、閉じるのは入ってきた側へ戻す向きで、
        // Paseo のモバイルパネル(右パネルを右スワイプで閉じる)と同じ
        // (`packages/app/src/mobile-panels/gestures.ts`: `translationX > windowWidth / 3 || velocityX > 500`)。
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => {
          translateX.setValue(Math.max(0, Math.min(widthRef.current, g.dx)));
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dx > widthRef.current / 3 || g.vx > 0.5) {
            animateCloseRef.current();
          } else {
            Animated.spring(translateX, {
              toValue: 0,
              useNativeDriver: false,
              bounciness: 0,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: false,
            bounciness: 0,
          }).start();
        },
      }),
    [translateX],
  );

  const st = useMemo(
    () => ({
      desktop: {
        width: paneWidth,
        flexShrink: 0,
        borderLeftWidth: 1,
        borderLeftColor: colors.border,
        backgroundColor: colors.surface0,
      } as const,
      overlay: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.surface0,
        zIndex: 20,
        elevation: 20,
        shadowColor: "#000",
        shadowOpacity: 0.2,
        shadowRadius: 12,
        shadowOffset: { width: -2, height: 0 },
      } as const,
      pane: { flex: 1 },
      // 左端の境界(掴みやすい12px。PCは col-resize カーソル)。
      resizeHandle: {
        position: "absolute" as const,
        left: -6,
        top: 0,
        bottom: 0,
        width: 12,
        zIndex: 30,
        cursor: "col-resize" as unknown as "auto",
      } as const,
      resizeGrip: {
        position: "absolute" as const,
        left: 5,
        top: 0,
        bottom: 0,
        width: 2,
        backgroundColor: colors.border,
      },
      activity: {
        color: colors.accent,
        fontSize: 12,
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: colors.surface1,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 8,
        minHeight: 48,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
      },
      headerBtn: { paddingVertical: 8, paddingHorizontal: 8, minWidth: 44 },
      headerBtnText: { color: colors.accent, fontSize: 14 },
      headerTitle: {
        flex: 1,
        color: colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
      scroll: { flex: 1 },
      scrollBody: { padding: 12, gap: 10 },
      context: {
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 4,
      },
      contextBadge: { color: colors.accent, fontSize: 11 },
      contextSubject: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
      contextBackground: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      empty: {
        color: colors.foregroundMuted,
        fontSize: 12,
        textAlign: "center" as const,
        marginTop: 12,
      },
      msgRow: { flexDirection: "row" as const, justifyContent: "flex-start" as const },
      msgRowMine: { flexDirection: "row" as const, justifyContent: "flex-end" as const },
      bubbleTheirs: {
        backgroundColor: colors.surface2,
        borderRadius: 12,
        padding: 10,
        maxWidth: "86%" as const,
        gap: 2,
      },
      bubbleMine: {
        backgroundColor: colors.accent,
        borderRadius: 12,
        padding: 10,
        maxWidth: "86%" as const,
        gap: 2,
      },
      bubbleTextTheirs: { color: colors.foreground, fontSize: 14, lineHeight: 20 },
      bubbleTextMine: { color: colors.accentForeground, fontSize: 14, lineHeight: 20 },
      notice: { color: colors.statusWarning, fontSize: 12, paddingHorizontal: 12 },
      inputRow: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        gap: 8,
        padding: 10,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface1,
        paddingBottom: "env(safe-area-inset-bottom)" as unknown as number,
      },
      input: {
        flex: 1,
        minHeight: 44,
        maxHeight: 120,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
      inputOff: { opacity: 0.5 },
      sendBtn: {
        minHeight: 44,
        minWidth: 56,
        borderRadius: 8,
        backgroundColor: colors.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      sendBtnOff: {
        minHeight: 44,
        minWidth: 56,
        borderRadius: 8,
        backgroundColor: colors.accent,
        opacity: 0.5,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      sendText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
      hint: {
        color: colors.foregroundMuted,
        fontSize: 10,
        paddingHorizontal: 10,
        paddingBottom: 6,
        backgroundColor: colors.surface1,
      },
    }),
    [colors, paneWidth],
  );

  // lint(jsx-no-new-array-as-prop)対策: スライド用のスタイル配列を毎レンダー作り直さない。
  const slideStyle = useMemo(
    () => [st.overlay, { transform: [{ translateX }] }],
    [st.overlay, translateX],
  );

  const sendable = canSend(text, sendAgentId, serverId, sending, reason !== null);
  // lint(jsx-no-new-array-as-prop)対策: 相手が居ない時の淡色は同じ配列を作り直さない。
  const inputStyle = useMemo(
    () => (reason ? [st.input, st.inputOff] : st.input),
    [reason, st.input, st.inputOff],
  );

  const header = (
    <View style={st.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={compact ? "確認箱一覧に戻る" : "チャットを閉じる"}
        style={st.headerBtn}
        onPress={compact ? animateClose : onClose}
      >
        <Text style={st.headerBtnText}>{compact ? "‹ 戻る" : "✕"}</Text>
      </Pressable>
      {/* 履歴があると開いた直後は最下部までスクロールするので、論点はヘッダにも出す。 */}
      <Text style={st.headerTitle} numberOfLines={1}>
        {item?.subject ?? title ?? "投函元スレのチャット"}
      </Text>
      {/* 同じ相手を Paseo のスレ画面(ツール実行や承認まで見える)で開きたい時の逃げ道。 */}
      {onOpenThread ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="元スレを開く"
          style={st.headerBtn}
          onPress={onOpenThread}
        >
          <Text style={st.headerBtnText}>スレを開く</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const body = (
    <View style={st.pane}>
      {header}
      <ScrollView ref={scrollRef} style={st.scroll} contentContainerStyle={st.scrollBody}>
        <CardContext item={item} title={title} styles={st} />
        {reason ? <Text style={st.notice}>{reason}</Text> : null}
        {lines.length === 0 && !reason && !fallback ? (
          <Text style={st.empty}>
            まだ会話はありません。ここで送ると投函元スレに届き、そのスレの返事がここに出ます。
          </Text>
        ) : null}
        {lines.map((line) => {
          const mine = line.role === "user";
          return (
            <View key={line.id} style={mine ? st.msgRowMine : st.msgRow}>
              <View style={mine ? st.bubbleMine : st.bubbleTheirs}>
                <Text style={mine ? st.bubbleTextMine : st.bubbleTextTheirs}>{line.text}</Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
      {notice ? <Text style={st.notice}>{notice}</Text> : null}
      {activity ? (
        <Text style={st.activity} accessibilityLiveRegion="polite" testID="pane-activity">
          {PANE_ACTIVITY_LABEL[activity]}
        </Text>
      ) : null}
      <View style={st.inputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!reason}
          placeholder={reason ?? (fallback ? "総司令塔へ送る" : "投函元スレへ送る")}
          placeholderTextColor={colors.foregroundMuted}
          multiline
          maxLength={TEXT_MAX}
          style={inputStyle}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!sendable}
          style={sendable ? st.sendBtn : st.sendBtnOff}
          onPress={sendPress}
        >
          <Text style={st.sendText}>送る</Text>
        </Pressable>
      </View>
      <Text style={st.hint}>
        {fallback
          ? `${COORDINATOR_FALLBACK_NOTICE}(${text.length}/${TEXT_MAX}字)`
          : `${text.length}/${TEXT_MAX}字 · 送信先=投函元スレ(この画面の外のスレにも同じ発言が残ります)`}
      </Text>
    </View>
  );

  if (!compact) {
    return (
      <View style={st.desktop}>
        {body}
        <View
          style={st.resizeHandle}
          {...resizeHandlers}
          accessibilityLabel="チャットの幅を変える(ダブルクリックで元に戻す)"
          testID="pane-resize-handle"
        >
          <View style={st.resizeGrip} />
        </View>
      </View>
    );
  }
  return (
    <Animated.View style={slideStyle} {...pan.panHandlers}>
      {body}
    </Animated.View>
  );
}
