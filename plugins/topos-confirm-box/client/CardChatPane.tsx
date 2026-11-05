/**
 * カード専用のチャットペイン。
 *
 * 2026-10-22 ユーザー決定(逐語は `coordinator_decisions.md` 末尾):
 * **確認箱のコメントボタン = 投函元スレのチャットを開く**。
 * したがってこのペインの相手は「投函元スレのエージェント」であり、箱側の質問→応答ワーカー
 * (9ec05eb92/0627b40c9 の返信行方式)は使わない。ペインで送った文は元スレへユーザー発言として
 * 届き、元スレの応答がそのままここへ流れてくる(=投函元スレと双方向)。
 * 例外(2026-10-25 方式a): 宛先がハブ(総司令塔・子司令塔)の時だけ「そのカードの話題だけ」表示にし、
 * 台帳に質問を書いて返信ID+say コマンドを付けて送る。会話は上位スレの `say` だけが出る(ライブ出力は流さない)。
 * 入力欄: PC幅は Enter 送信(IME変換中・Shift+Enter は送らない)、iPhone幅は Enter=改行(送るボタンで送信)。
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
 * - スレ自身 … `readAgentState`(`fetch_agent_request` = 記録を読むだけ。`client/agent-read.ts`)の
 *   `archivedAt`、以降は購読の upsert/remove
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
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { getPaseoClient, useHosts, useRpc } from "@getpaseo/plugin/client";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  cardChatAskRpc,
  cardChatCancelRpc,
  cardChatListRpc,
  coordinatorTargetRpc,
} from "../shared/contract.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
import {
  COORDINATOR_FALLBACK_NOTICE,
  coordinatorCandidates,
  isHubTarget,
  pendingLabel,
  pickCoordinatorTarget,
  shouldFallbackToCoordinator,
  shouldSubmitOnEnter,
  threadUnavailableReason,
  withCardHeader,
  withSayInstruction,
} from "../shared/card-pane.js";
import type { ThreadAccess } from "../shared/child-threads.js";
import {
  PANE_ACTIVITY_LABEL,
  nextPaneActivity,
  paneActivityLabel,
} from "../shared/pane-activity.js";
import type { PaneActivityEvent, PaneActivityState } from "../shared/pane-activity.js";
import { readAgentState, readAgentStateOn } from "./agent-read.js";
import { usePaneInputTools } from "./usePaneInputTools.js";
import type { PaneImage } from "./usePaneInputTools.js";
//  "./usePaneInputTools.js";
import { usePaneResize } from "./usePaneResize.js";

// Paseo のモバイルパネルと同じ 220ms / 同じイージング
// (`packages/app/src/mobile-panels/provider.tsx:41-42` の ANIMATION_DURATION / ANIMATION_EASING)。
const SLIDE_MS = 220;
const SLIDE_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);
/** 開いた時に読む履歴の件数(元スレの直近だけ。全履歴は重い)。 */
const HISTORY_LIMIT = 30;
/**
 * 開き直した時に「自分の発言」が窓から落ちないための下限。
 * ツール呼び出しの多いスレは30項目が数分で埋まる(実測: 2026-11-05 のスレで
 * ユーザー発言1件の後ろに91項目)。足りなければ古い方をページで足す。
 */
const MIN_USER_LINES = 5;
/** 古い方を足すときの1ページ(アプリ本体 `use-load-older-agent-history.ts` と同じ40)。 */
const HISTORY_PAGE = 40;
/** 古い方を足す上限ページ数(重いスレで無限に読まない)。 */
const HISTORY_MAX_PAGES = 6;
/** 送信欄の上限。Paseo の composer に合わせた素朴な値(サーバ側で切り詰めはしない)。 */
const TEXT_MAX = 4000;
/** 生死(アーカイブ済みか)の見直し間隔。購読で拾えない経路(別端末からのアーカイブ等)の取りこぼし用。 */
const LIVENESS_MS = 60_000;
/** 「この話題だけ」表示の台帳の読み直し間隔。 */
const TOPIC_POLL_MS = 4_000;

interface TopicMessage {
  ts: number;
  role: "user" | "reply";
  by: string;
  text: string;
}
interface TopicPending {
  re: string;
  ts: number;
  state: "waiting" | "overdue";
  nudges: number;
}

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

/** 同じ役割・同じ文の行が既にあるか。購読の張り直しで過去が流れ直した時の二重表示を防ぐ。 */
function hasLine(lines: ChatLine[], line: ChatLine): boolean {
  return lines.some((l) => l.role === line.role && l.text === line.text);
}

/**
 * 履歴(`past`)と、開いた後に積まれた行(`cur`)を合わせる。
 * 以前は `cur` が空でなければ履歴を丸ごと捨てていたため、自分の送信や購読の行が先に届くと
 * 履歴が永久に出なかった(2026-11-05 出口レビュー指摘2)。行は履歴側を先に置き、
 * `cur` にしか無い行だけを後ろへ足す。
 *
 * ユーザー行は**前方一致**でも重複とみなす: 送信時にローカルへ積むのは打った文そのものだが、
 * スレへ送る文にはカードの見出しが付く(`withCardHeader`)ため、履歴側の文は長い。
 * assistant 行は連結の都合で文が揺れるので、完全一致の時だけ重複とみなす(取りこぼしを避ける)。
 */
function mergeHistory(past: ChatLine[], cur: ChatLine[]): ChatLine[] {
  if (cur.length === 0) return past;
  if (past.length === 0) return cur;
  const seen = new Map<string, number>();
  for (const line of past) {
    const key = `${line.role}\u0000${line.text}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const alreadyThere = (line: ChatLine): boolean => {
    const key = `${line.role}\u0000${line.text}`;
    const n = seen.get(key) ?? 0;
    if (n > 0) {
      seen.set(key, n - 1);
      return true;
    }
    if (line.role !== "user" || line.text.length === 0) return false;
    // 見出し付きの同じ発言。
    const prefixed = past.filter((p) => p.role === "user" && p.text.startsWith(line.text));
    if (prefixed.length === 0) return false;
    const keys = prefixed.map((p) => `${p.role}\u0000${p.text}`);
    const hit = keys.find((k) => (seen.get(k) ?? 0) > 0);
    if (!hit) return false;
    seen.set(hit, (seen.get(hit) ?? 0) - 1);
    return true;
  };
  const extra = cur.filter((line) => !alreadyThere(line));
  return past.concat(extra);
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

function ImageChip({
  image,
  onRemove,
  style,
}: {
  image: PaneImage;
  onRemove: (id: string) => void;
  style: object;
}) {
  const remove = useCallback(() => onRemove(image.id), [onRemove, image.id]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${image.name} を外す`}
      onPress={remove}
    >
      <Text style={style}>🖼 {image.name} ✕</Text>
    </Pressable>
  );
}

// 既存の指摘(complexity 57)。ペインの分割は今回の変更(状態の読み取り)と無関係なので触らない。
// oxlint-disable-next-line eslint/complexity
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
  // 履歴の読み込みが終わるまで購読を張らない(下の購読 effect の注記)。
  const [historyReady, setHistoryReady] = useState(false);
  const appendDictated = useCallback((said: string) => setText((cur) => cur + said), []);
  const tools = usePaneInputTools(appendDictated);
  const { images: toolImages, clearImages, restoreImages, resetTools } = tools;
  const [sending, setSending] = useState(false);
  // 「届いたか」の表示。送信直後=送信済み、以降は相手スレの購読で取れた事実だけで進む。
  const [activity, setActivity] = useState<PaneActivityState | null>(null);
  const activityLabel = paneActivityLabel(activity);
  // このペインが相手の状態(running/idle)を一度でも見たか。見るまで作業系の項目は進めない
  // (`shared/pane-activity.ts`)。購読の開始より先に印を立てるため ref で持つ。
  const statusSeen = useRef(false);
  const seeActivity = useCallback((ev: PaneActivityEvent) => {
    // 状態を見るまでは、購読が流してくる**過去の**書き込みを今の作業と取り違えない(捨てる)。
    if (ev.kind === "item" && !statusSeen.current) return;
    // 状態を持たない更新(アーカイブ印だけが変わった等)は「止まった」ではない。門も開けず、下げもしない
    // (状態を読む effect と同じ規則。出口レビュー round2 指摘3)。
    if (ev.kind === "agent-status" && ev.status === undefined) return;
    if (ev.kind === "agent-status" || ev.kind === "sent") statusSeen.current = true;
    setActivity((cur) => nextPaneActivity(cur, ev));
  }, []);
  // 総司令塔へ振り替えて1回でも送ったか。返事の購読はこの後だけ(相手/カードを変えたら戻す)。
  const [coordSent, setCoordSent] = useState(false);
  // 総司令塔のID(サーバが起こしデーモンの正本から読む。undefined=未取得、null=見つからない)と、閉じているか。
  const coordinatorRpc = useRpc(coordinatorTargetRpc);
  const [coordId, setCoordId] = useState<string | null | undefined>(undefined);
  // ハブ(総司令塔・子司令塔)のID一覧。宛先がこの中なら「この話題だけ」表示にする。
  // undefined = まだ引けていない(この間は履歴を引かない=ハブ宛なのに全体履歴が一瞬出るのを防ぐ)。
  const [hubIds, setHubIds] = useState<string[] | undefined>(undefined);
  // ハブ宛でも「スレ全体」(従来のライブ表示)へ切り替えられる。
  const [topicView, setTopicView] = useState(true);
  const [topicMsgs, setTopicMsgs] = useState<TopicMessage[]>([]);
  const [topicPending, setTopicPending] = useState<TopicPending[]>([]);
  const askRpc = useRpc(cardChatAskRpc);
  const cancelRpc = useRpc(cardChatCancelRpc);
  const listRpc = useRpc(cardChatListRpc);
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
  // 別のカード/スレへ切り替えたら、書きかけの文・添付・音声入力を持ち越さない(別の相手へ誤送信しない)。
  useEffect(() => {
    setText("");
    resetTools();
  }, [agentId, item?.id, resetTools]);

  const access = toAccess(liveness);
  const closedText = threadUnavailableReason(access, item ? "card" : "thread");
  // 投函元が無い/閉じているカードは総司令塔へ振り替える(スレ直接=item無しは対象外)。
  const fallback = shouldFallbackToCoordinator({
    hasCard: item !== null,
    agentId,
    closedText,
  });
  const sendAgentId = fallback ? (coordId ?? null) : agentId;
  const hub = isHubTarget({
    fallback,
    agentId: sendAgentId,
    hubIds: hubIds ?? [],
  });
  const hubPending = item !== null && hubIds === undefined && !fallback;
  // 話題だけ表示: ハブ宛で、カードがあり、切替で「スレ全体」にされていない時。
  const topic = hub && topicView && item !== null;
  // 開いた時点のスレの状態を1回読む。購読は接続直後に過去の書き込みを流すので、状態を見ないと
  // 送信もしていないのに「ツールを実行中…」が出る(2026-10-27 本番。`shared/pane-activity.ts`)。
  // 読み直し(リロード)で空になるのも防ぐ: 開いた時点で running なら、その後の書き込みで表示を戻す。
  // 履歴の最後の項目からは起こさない(パネルに返事が残ったままの idle スレで「返信中…」が出続けるため)。
  useEffect(() => {
    statusSeen.current = false;
    if (!serverId || topic || hubPending) return undefined;
    const target = sendAgentId ?? agentId;
    if (!target) return undefined;
    let alive = true;
    const read = (attempt: number) => {
      // 状態を見るだけ。アーカイブを解く呼び方にしない(`client/agent-read.ts`)。
      readAgentStateOn(serverId, target)
        .then((state) => {
          if (!alive) return null;
          const status = state?.status ?? undefined;
          // 読めなかった(undefined)は「止まった」と見なさない(表示の上書きを避け、次の項目に任せる)。
          if (status === undefined && attempt < 2) {
            setTimeout(() => alive && read(attempt + 1), 1500);
            return null;
          }
          if (status !== undefined) seeActivity({ kind: "agent-status", status });
          return null;
        })
        .catch(() => {
          // 読めなければ従来どおり項目だけで進める(止まったら coordinator / liveness の通知で戻る)。
        });
    };
    read(0);
    return () => {
      alive = false;
    };
  }, [agentId, sendAgentId, serverId, seeActivity, topic, hubPending]);

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
  //
  // 履歴の `timeline.refetch` は `fetch_agent_timeline_request` で、**アーカイブは解かない**
  // (2026-11-01 実デーモンで測定: 解除後も `archivedAt` は残る)。ただしアーカイブ済みのスレは
  // 読み込まれて status が closed→idle になる。解除ではないのでサイドバー(アーカイブ済みは載せない)には
  // 戻らず、投函元が閉じているカードでも過去のやり取りを読める利点があるため、ここでは止めない
  // (止めるかは product 判断。2026-11-01 出口レビュー指摘2は「読み取りの解除」ではなく「読み込み」)。
  // 履歴の読み直し。購読とは別の effect に分ける(理由は下の購読 effect の注記)。
  //
  // 2026-11-05 の不具合(ユーザー報告「チャット欄閉じてまた開くと、さっき投げたチャットが消えてる」):
  // 以前はこの読み直しが購読と同じ effect に居り、`hubPending`(= ハブ一覧 `hubIds` が未取得)の間は
  // return していた。ペインを開いた直後は必ず未取得なので履歴を一度も読まず、`hubIds` が入っても
  // 依存配列に `hubPending` が無いため effect は再実行されず、**二度と読まれなかった**。
  // 送信時の自分の行は `send()` がローカルに積むだけ(台帳にも履歴にも依存しない)なので、
  // 閉じて開き直すとその行だけが消えて見えた。ここだけ `hubPending` を deps に持ち、
  // ハブ一覧が引けた時点で読み直す(ハブ宛=話題表示に決まったら `topic` が立って読まない)。
  useEffect(() => {
    if (!agentId || !serverId || topic || hubPending) return undefined;
    const handle = getPaseoClient(serverId).agents.ref(agentId);
    let alive = true;
    const toLines = (
      entries: ReadonlyArray<{ item?: unknown }> | undefined,
      prefix: string,
    ): ChatLine[] => {
      const out: ChatLine[] = [];
      (entries ?? []).forEach((entry, idx) => {
        const line = lineFromItem(entry.item as TimelineItemLike, `${prefix}${idx}`);
        if (line) out.push(line);
      });
      return out;
    };
    // 直近だけ読んで、ユーザー発言が少なければ古い方を足す(閉じて開き直した時に
    // 自分の発言が「直近30項目」から外れて消えて見えるのを防ぐ)。
    const load = async (): Promise<{ past: ChatLine[]; partial: boolean }> => {
      const tail = await handle.timeline.refetch({ limit: HISTORY_LIMIT });
      const tailLines = toLines(tail.entries as { item?: unknown }[], "h");
      const olderPages: ChatLine[][] = [];
      let partial = false;
      let userCount = tailLines.filter((l) => l.role === "user").length;
      let cursor = tail.startCursor ?? null;
      let hasOlder = tail.hasOlder === true;
      for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
        if (!alive || userCount >= MIN_USER_LINES || !hasOlder || !cursor) break;
        let older: Awaited<ReturnType<typeof handle.timeline.refetch>>;
        try {
          older = await handle.timeline.refetch({
            direction: "before",
            cursor,
            limit: HISTORY_PAGE,
          });
        } catch {
          // 古いページが読めなくても、読めた分(直近30項目)は捨てない
          // (2026-11-05 出口レビュー2巡目 指摘3)。
          partial = true;
          break;
        }
        const entries = older.entries ?? [];
        const added = toLines(entries as { item?: unknown }[], `o${page}`);
        // 止めるのは「そのページに項目が無い」時だけ。表示できる行が0でも項目があれば
        // さらに古いページを読む(2026-11-05 出口レビュー指摘3)。
        if (entries.length === 0) break;
        // 古いページを先頭へ積む(ES2023 の `toReversed` は配布先で欠けることがあるため使わない)。
        olderPages.unshift(added);
        userCount += added.filter((l) => l.role === "user").length;
        const nextCursor = older.startCursor ?? null;
        // カーソルが進まないページを繰り返し読まない(同じページを読み続けて止まる)。
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
        hasOlder = older.hasOlder === true;
      }
      return { past: olderPages.flat().concat(tailLines), partial };
    };
    load()
      .then(({ past, partial }) => {
        if (!alive) return null;
        if (partial) setNotice("古い履歴の一部を読めませんでした");
        // 開いた時点の表示(「ツールを実行中…」等)は、スレの状態を読む effect が下で起こす。
        // ここで履歴の最後の項目から起こすと、idle のスレ(返信が残ったまま)でも「返信中…」などが先に出て、
        // 状態の読み取りより先に届く場合に止まったままになる(2026-10-27 出口レビュー round1 F1)。
        // 嘘の表示を避ける方を優先する: 履歴の読み直しと状態の読み取りがどちらも失敗したら、ラベルは出ない。
        setLines((cur) => mergeHistory(past, cur));
        setHistoryReady(true);
        return null;
      })
      .catch(() => {
        // 履歴が読めなくても会話は続けられる(送るたびに購読側で増える)。黙って落とさず1行出す。
        if (alive) {
          setNotice("履歴を読めませんでした(送信はできます)");
          // 読めなくても購読は始める(ここで false のままだと返事が一切流れない)。
          setHistoryReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [agentId, serverId, topic, hubPending]);

  // 会話の初期化。ハブ判定が確定した時点で一度だけ空にする。購読 effect 側で消すと、
  // 購読が張り直されたときに、上の履歴 effect が読み終えた行まで巻き添えで消える。
  useEffect(() => {
    setLines([]);
    setNotice("");
    setHistoryReady(false);
  }, [agentId, serverId, topic, hubPending]);

  // ライブの購読。履歴と同じく `hubPending` を deps に持つ。以前は持っていなかったため、
  // ハブ一覧が未取得の間は購読が張られず、`hubIds` が入っても再実行されずに**一度も張られなかった**
  // (2026-11-05 出口レビュー指摘1)。
  //
  // `historyReady` が立つまで張らない(2026-11-05 出口レビュー2巡目 指摘2)。購読は接続直後に過去を
  // 流し直すので、履歴より先に張ると assistant の発言が間に user 行の無いまま1行に連結され、
  // 履歴と文が一致せず**その塊が履歴の後ろに二重で並ぶ**。履歴を読み終えてから張れば、replay は
  // 履歴と同文で `hasLine` に落ちる。読み込み中に届いた返事は、張った直後の replay で拾う。
  useEffect(() => {
    if (!agentId || !serverId || topic || hubPending || !historyReady) return undefined;
    const handle = getPaseoClient(serverId).agents.ref(agentId);
    let alive = true;
    const sub = handle.timeline.subscribe((evt) => {
      if (!alive) return;
      const ev = (evt as { event?: { type?: string; item?: TimelineItemLike } }).event;
      if (ev?.type !== "timeline") return;
      seeActivity({
        kind: "item",
        itemType: ev.item?.type,
        status: itemStatus(ev.item),
      });
      // ユーザー発言は送信時に表示済み(二重表示を避ける)。
      if (ev.item?.type !== "assistant_message") return;
      seq.current += 1;
      const line = lineFromItem(ev.item, `s${seq.current}`);
      if (line) setLines((cur) => (hasLine(cur, line) ? cur : appendLine(cur, line)));
    });
    return () => {
      alive = false;
      sub();
    };
  }, [agentId, serverId, seeActivity, topic, hubPending, historyReady]);

  // ハブ一覧は一度だけ引く(総司令塔の生死確認は、下の振り替え時の effect が行う)。
  useEffect(() => {
    if (!serverId) return undefined;
    let alive = true;
    coordinatorRpc({})
      .then((res) => {
        if (alive) setHubIds(res.hubIds ?? []);
        return null;
      })
      .catch(() => {
        // 引けなければ従来のライブ表示のまま。
        if (alive) setHubIds([]);
      });
    return () => {
      alive = false;
    };
  }, [serverId, coordinatorRpc]);

  // 話題だけ表示: 台帳(chat/reply)を読む。上位スレのライブ出力は流さない。
  const itemId = item?.id ?? null;
  const itemKey = item?.key ?? null;
  const topicGen = useRef(0);
  const refreshTopic = useCallback(async () => {
    if (!itemId) return;
    const gen = topicGen.current;
    try {
      const res = await listRpc({ id: itemId, key: itemKey, topic: true });
      // 呼んでいる間にカードを切り替えたら、前のカードの結果を捨てる。
      if (gen !== topicGen.current) return;
      setTopicMsgs(res.messages);
      setTopicPending(res.pending ?? []);
    } catch {
      // 読めなかった回は前の表示を保つ。
    }
  }, [itemId, itemKey, listRpc]);
  useEffect(() => {
    topicGen.current += 1;
    setTopicMsgs([]);
    setTopicPending([]);
    if (!topic) return undefined;
    void refreshTopic();
    const timer = setInterval(() => void refreshTopic(), TOPIC_POLL_MS);
    return () => clearInterval(timer);
  }, [topic, refreshTopic]);

  // 振り替える時だけ振り替え先のIDを引き、閉じていないか確かめる(閉じていれば送信を止める)。
  // 総司令塔(general)は退役済みでアーカイブを指すことがあるため、候補(総司令塔→後継の裏方1)を
  // 順に読み、**生きている先**を選ぶ(`pickCoordinatorTarget`。2026-11-03 ユーザー報告の修理)。
  useEffect(() => {
    if (!fallback || !serverId) return undefined;
    let alive = true;
    setCoordClosed(false);
    coordinatorRpc({})
      .then(async (res) => {
        if (!alive) return null;
        setHubIds(res.hubIds ?? []);
        const ids = coordinatorCandidates(res.agentId, res.fallbackIds ?? []);
        setCoordId(ids[0] ?? null);
        const states: { id: string; live: boolean | null }[] = [];
        for (const id of ids) {
          let live: boolean | null = null;
          try {
            const state = await readAgentStateOn(serverId, id);
            live = state ? state.archivedAt == null : null;
          } catch {
            // 読めない=不明。送信は試せる側に倒す(従来と同じ)。
            live = null;
          }
          states.push({ id, live });
        }
        if (!alive) return null;
        const picked = pickCoordinatorTarget(states);
        // 選べなかった時も先頭IDを残す(「見つかりません」と「閉じています」を取り違えない)。
        setCoordId(picked ?? ids[0] ?? null);
        setCoordClosed(picked === null);
        return null;
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
    if (!fallback || !coordSent || !serverId || !coordId || topic) return undefined;
    let alive = true;
    const off = getPaseoClient(serverId)
      .agents.ref(coordId)
      .timeline.subscribe((evt) => {
        if (!alive) return;
        const ev = (evt as { event?: { type?: string; item?: TimelineItemLike } }).event;
        if (ev?.type !== "timeline") return;
        seeActivity({
          kind: "item",
          itemType: ev.item?.type,
          status: itemStatus(ev.item),
        });
        if (ev.item?.type !== "assistant_message") return;
        seq.current += 1;
        const line = lineFromItem(ev.item, `f${seq.current}`);
        if (line) setLines((cur) => appendLine(cur, line));
      });
    const offStatus = getPaseoClient(serverId)
      .agents.ref(coordId)
      .subscribe((update) => {
        if (!alive || update.kind !== "upsert") return;
        seeActivity({
          kind: "agent-status",
          status: (update.agent as { status?: string }).status,
        });
      });
    return () => {
      alive = false;
      off();
      offStatus();
    };
  }, [fallback, coordSent, coordId, serverId, seeActivity, topic]);

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
        seeActivity({
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
        // 状態を見るだけ。アーカイブを解く呼び方にしない(`client/agent-read.ts`)。
        const [state, live] = await Promise.all([readAgentState(client, agentId), liveIds()]);
        if (!alive) return;
        const workspaceLive = live && state?.workspaceId ? live.has(state.workspaceId) : null;
        setLiveness((l) => ({
          archivedAt: state ? state.archivedAt : l.archivedAt,
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
  }, [agentId, serverId, seeActivity]);

  // 新しい行が来たら最下部へ。件数ではなく末尾の行を見る(断片の連結で件数が増えないため)。
  const lastLine = lines.at(-1);
  const lastKey = lastLine ? `${lastLine.id}:${lastLine.text.length}` : "";
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [lastKey]);

  const send = useCallback(async () => {
    const t = text.trim();
    if (reason || !t || !sendAgentId || !serverId || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setText("");
    const sentImages = toolImages;
    clearImages();
    if (!topic) {
      seq.current += 1;
      setLines((cur) => [...cur, { id: `u${seq.current}`, role: "user", text: t }]);
    }
    let askedId: string | null = null;
    try {
      // カードID付きで送る(司令塔宛のとき発言ログから回答済みを機械判定するため。judgment_answer_sweep.py)
      let outgoing = item ? withCardHeader(t, item) : t;
      if (topic && item) {
        // 台帳へ質問を記録し(返事待ちの目印と催促の元)、返信ID+sayコマンドを付けて上位スレへ送る。
        const asked = await askRpc({
          id: item.id,
          key: item.key,
          text: t,
          target: sendAgentId,
        });
        if (!asked.ok || !asked.replyId) throw new Error(asked.message);
        askedId = asked.replyId;
        outgoing = withSayInstruction(outgoing, {
          replyId: asked.replyId,
          cardId: item.id,
        });
      }
      const opts = sentImages.length
        ? {
            images: sentImages.map((i) => ({
              data: i.data,
              mimeType: i.mimeType,
            })),
          }
        : undefined;
      await getPaseoClient(serverId).agents.ref(sendAgentId).send(outgoing, opts);
      if (topic) void refreshTopic();
      if (fallback) setCoordSent(true);
      seeActivity({ kind: "sent" });
      setNotice("");
    } catch (e) {
      setNotice(`送れません: ${e instanceof Error ? e.message : String(e)}`);
      // 入力を失わない(書き直しや再添付を強いない)。
      setText((cur) => (cur ? cur : t));
      restoreImages(sentImages);
      if (askedId && item) {
        // 台帳には質問が残っているので取り消す(届いていない質問に催促が飛ばないように)。
        cancelRpc({ id: item.id, key: item.key, replyId: askedId })
          .then(() => (topic ? refreshTopic() : null))
          .catch(() => {
            // 取り消せなくても次の周期で催促されるだけ(受容)。
          });
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    text,
    reason,
    sendAgentId,
    serverId,
    fallback,
    item,
    seeActivity,
    topic,
    askRpc,
    cancelRpc,
    refreshTopic,
    toolImages,
    clearImages,
    restoreImages,
  ]);
  const sendPress = useCallback(() => void send(), [send]);
  // Enter で送信(PC幅のWebだけ。IME変換確定・Shift+Enter・iPhone は送らず改行のまま)。
  const onKeyPress = useCallback(
    (e: {
      nativeEvent: {
        key: string;
        shiftKey?: boolean;
        isComposing?: boolean;
        keyCode?: number;
      };
      preventDefault?: () => void;
    }) => {
      const n = e.nativeEvent;
      if (
        shouldSubmitOnEnter({
          key: n.key,
          shiftKey: n.shiftKey,
          isComposing: n.isComposing,
          keyCode: n.keyCode,
          isWeb: Platform.OS === "web",
          compact,
        })
      ) {
        e.preventDefault?.();
        void send();
      }
    },
    [compact, send],
  );
  const toggleTopicView = useCallback(() => setTopicView((v) => !v), []);

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
      contextSubject: {
        color: colors.foreground,
        fontSize: 15,
        fontWeight: "600" as const,
      },
      contextBackground: {
        color: colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
      },
      empty: {
        color: colors.foregroundMuted,
        fontSize: 12,
        textAlign: "center" as const,
        marginTop: 12,
      },
      msgRow: {
        flexDirection: "row" as const,
        justifyContent: "flex-start" as const,
      },
      msgRowMine: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
      },
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
      bubbleTextTheirs: {
        color: colors.foreground,
        fontSize: 14,
        lineHeight: 20,
      },
      bubbleTextMine: {
        color: colors.accentForeground,
        fontSize: 14,
        lineHeight: 20,
      },
      notice: {
        color: colors.statusWarning,
        fontSize: 12,
        paddingHorizontal: 12,
      },
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
      toolBtn: {
        minHeight: 44,
        minWidth: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      toolBtnOn: {
        minHeight: 44,
        minWidth: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.accent,
        backgroundColor: colors.surface2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      toolText: { color: colors.foreground, fontSize: 18 },
      chipRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingTop: 6,
        backgroundColor: colors.surface1,
      },
      chip: {
        color: colors.foreground,
        fontSize: 12,
        backgroundColor: colors.surface2,
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 3,
      },
      modeRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 12,
        paddingVertical: 2,
      },
      modeText: { color: colors.foregroundMuted, fontSize: 11 },
      modeBtn: { paddingVertical: 6, paddingHorizontal: 6 },
      modeBtnText: { color: colors.accent, fontSize: 12 },
      pendingText: {
        color: colors.statusWarning,
        fontSize: 11,
        textAlign: "right" as const,
      },
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
      sendText: {
        color: colors.accentForeground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
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
        {topic && topicMsgs.length === 0 && topicPending.length === 0 ? (
          <Text style={st.empty}>
            このカードの話題の会話はまだありません。送ると上位スレに届き、そのスレが say
            で返した返事だけがここに出ます。
          </Text>
        ) : null}
        {topic
          ? topicMsgs.map((m) => {
              const mine = m.role === "user";
              return (
                <View key={`t${m.ts}-${m.role}-${m.by}`} style={mine ? st.msgRowMine : st.msgRow}>
                  <View style={mine ? st.bubbleMine : st.bubbleTheirs}>
                    <Text style={mine ? st.bubbleTextMine : st.bubbleTextTheirs}>{m.text}</Text>
                  </View>
                </View>
              );
            })
          : null}
        {topic
          ? topicPending.map((p) => (
              <Text key={p.re} style={st.pendingText} testID="pane-pending">
                {pendingLabel(p.state, p.nudges)}
              </Text>
            ))
          : null}
        {!topic && lines.length === 0 && !reason && !fallback ? (
          <Text style={st.empty}>
            まだ会話はありません。ここで送ると投函元スレに届き、そのスレの返事がここに出ます。
          </Text>
        ) : null}
        {(topic ? [] : lines).map((line) => {
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
      {tools.toolNotice ? <Text style={st.notice}>{tools.toolNotice}</Text> : null}
      {hub && item ? (
        <View style={st.modeRow}>
          <Text style={st.modeText}>
            {topic ? "表示: この話題だけ(say された返事のみ)" : "表示: スレ全体(ライブ)"}
          </Text>
          <Pressable accessibilityRole="button" style={st.modeBtn} onPress={toggleTopicView}>
            <Text style={st.modeBtnText}>{topic ? "スレ全体を見る" : "この話題だけにする"}</Text>
          </Pressable>
        </View>
      ) : null}
      {activityLabel ? (
        <Text style={st.activity} accessibilityLiveRegion="polite" testID="pane-activity">
          {PANE_ACTIVITY_LABEL[activityLabel]}
        </Text>
      ) : null}
      {tools.images.length > 0 ? (
        <View style={st.chipRow}>
          {tools.images.map((im) => (
            <ImageChip key={im.id} image={im} onRemove={tools.removeImage} style={st.chip} />
          ))}
        </View>
      ) : null}
      <View style={st.inputRow}>
        {tools.attachSupported ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="画像を添付"
            disabled={Boolean(reason)}
            style={st.toolBtn}
            onPress={tools.pickImages}
          >
            <Text style={st.toolText}>＋</Text>
          </Pressable>
        ) : null}
        {tools.micSupported ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tools.listening ? "音声入力を止める" : "音声入力"}
            disabled={Boolean(reason)}
            style={tools.listening ? st.toolBtnOn : st.toolBtn}
            onPress={tools.toggleMic}
          >
            <Text style={st.toolText}>🎤</Text>
          </Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          onKeyPress={onKeyPress}
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
          ? `この欄に答えるスレ: 総司令塔 · ${COORDINATOR_FALLBACK_NOTICE}(${text.length}/${TEXT_MAX}字)`
          : `この欄に答えるスレ: ${
              item?.answerLabel ?? (agentId ? agentId.slice(0, 7) : "不明")
            } · ${text.length}/${TEXT_MAX}字(この画面の外のスレにも同じ発言が残ります)`}
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
