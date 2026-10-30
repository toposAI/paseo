/**
 * サイドバーの子スレ行。1スレ=1行(`SidebarRow id=agentId`)。題名+状態を出し、
 * 押すと子スレ一覧画面を開く(そのスレを先頭で展開)。
 *
 * 並び順はドラッグで変更でき、`child_threads_order.json` に保存される
 * (既存の `child_threads.json` は触らない)。保存が無ければサーバーの既定順。
 *
 * **タブ**: 下のタブバー(`addSidebarFooterItem` の「スレ一覧」「構想一覧」)で出し分ける。
 * スレ一覧=実装ノートの status(実装中/判断待ち/確認待ち)で絞ったスレ行、構想一覧=進行中の構想ノート
 * (`ConceptNotesList`)。**両方を積まない**(2026-10-24 ユーザー指示)。現在のタブは
 * `client/sidebar-mode.ts` を購読する。司令塔の行とその子スレは先頭の「司令塔」グループへ寄せる。
 *
 * 行末の状態ラベルは**必ずテーマ色を自分で与える**(与えないとホスト既定の黒になり、
 * ダークテーマで背景に溶ける)。ピン止め(`child_threads_pins.json`)とアーカイブ
 * (スレ + ワークスペース)は**状態の帯を押すと開くメニュー**(`ThreadMenu`)から行う
 * (2026-10-24 ユーザー指示: 行末のピン/アーカイブのアイコンを廃止)。アーカイブは誤爆しないよう
 * メニュー内で2度押しで実行する(状態遷移は `shared/thread-menu.ts`)。
 *
 * 行の形(状態の帯・メニュー)はスレ一覧でも構想一覧でも同じ。構想の行は従来どおり
 * 押すと深掘りスレを開く(メニューは状態の帯の無いスレ行だけ)。
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  useRpc,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarReorderableList, SidebarRow } from "@getpaseo/plugin/client/ui";
import {
  childThreadsArchiveRpc,
  childThreadsListRpc,
  childThreadsPinRpc,
  childThreadsSetOrderRpc,
  childThreadsSideRpc,
} from "../shared/child-threads.js";
import { boxSignalRpc } from "../shared/contract.js";
import type { ChildThread } from "../shared/child-threads.js";
import { blockedMessage } from "../shared/child-threads.js";
import {
  buildUpperRows,
  coordinatorIdSet,
  countStatusLabels,
  groupPressAction,
  groupThreadRowsBySide,
  sideOfThread,
  openableParentIds,
  reorderableIds,
  rowGroupKeyOf,
} from "../shared/sidebar-rows.js";
import { BOX_TAB_SCREEN_ID } from "../shared/footer-tabs.js";
import {
  COORDINATOR_GROUP,
  PINNED_GROUP,
  PINNED_GROUP_LABEL,
} from "../shared/sidebar-section-mode.js";
import type { SidebarRowView, SidebarSide, ThreadGroup } from "../shared/sidebar-rows.js";
import type { SidebarNote } from "../shared/notes.js";
import type { SidebarPlace, ZoneCounts } from "../shared/concept-places.js";
import { emptySectionLabel } from "../shared/sidebar-section-mode.js";
import type { SidebarSectionKey } from "../shared/sidebar-section-mode.js";
import { rowStatusKind, rowStatusText } from "../shared/thread-status-label.js";
import type { StatusKind } from "../shared/thread-status-label.js";
import { pickReadableText } from "../shared/contrast.js";
import { menuCanArchive } from "../shared/thread-menu.js";
import type { ThreadMenuIntent } from "../shared/thread-menu.js";
import { ConceptNotesList, useSidebarNotes } from "./ConceptNotes.js";
import { SharedProjectsList } from "./SharedProjects.js";
import { StatusBadge } from "./sidebar-badge.js";
import { stateDotIcons } from "./StateDot.js";
import type { StateDotIcon } from "./StateDot.js";
import { appearanceOf } from "../shared/state-dot.js";
import type { StateDotKind } from "../shared/state-dot.js";
import { useSidebarMode } from "./sidebar-mode.js";
import { ThreadMenu } from "./ThreadMenu.js";
import { watchBoxSignal } from "./change-signal.js";

const POLL_MS = 30_000;
const COLLAPSED_KEY = "topos-child-groups-collapsed";
// 親なしのグループの題名(見出しは出さない。`ThreadGroupSection` が平らに描く。旧「その他」は廃止)。
const OTHER_LABEL = "";
const SIDE_OPEN_KEY = "topos-side-sections-open";
const SIDE_LABEL: Record<SidebarSide, string> = { walltalk: "壁打ち", aux: "補助スレ" };
/** 既定の開閉: 壁打ちは開く、補助スレは折りたたむ(2026-10-30 ユーザー指示。端末ごとに保存)。 */
const SIDE_OPEN_DEFAULT: Record<SidebarSide, boolean> = { walltalk: true, aux: false };

function readSideOpen(): Record<SidebarSide, boolean> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(SIDE_OPEN_KEY) ?? "{}");
    const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<SidebarSide, unknown>>;
    return {
      walltalk: typeof o.walltalk === "boolean" ? o.walltalk : SIDE_OPEN_DEFAULT.walltalk,
      aux: typeof o.aux === "boolean" ? o.aux : SIDE_OPEN_DEFAULT.aux,
    };
  } catch {
    return { ...SIDE_OPEN_DEFAULT };
  }
}

function writeSideOpen(open: Record<SidebarSide, boolean>): void {
  try {
    globalThis.localStorage?.setItem(SIDE_OPEN_KEY, JSON.stringify(open));
  } catch {
    // 保存できなくても画面上の開閉は動く
  }
}
/** ドラッグ中は取得結果で一覧を差し替えない(キャンセル時に固まらないよう期限付き)。 */
const DRAG_POLL_GATE_MS = 60_000;
/** PC 幅で自分で描くメニューの幅の上限(サイドバーが広くても間延びさせない)。 */
const MENU_MAX_WIDTH = 240;
/** メニューと外枠の端・押した行との間隔(px)。 */
const EDGE_PADDING = 8;
const GAP = 4;
/** 対象が無いときのプレースホルダ(JSX に毎回新しい空オブジェクトを渡さないため)。 */
const EMPTY_MENU_ACTION: {
  target?: { thread: ChildThread; title: string; canArchive: boolean };
  onAction?: (intent: ThreadMenuIntent) => void;
} = {};
export const CHILD_THREADS_SCREEN_ID = "child-threads";

/**
 * サイドバーのカスタム内容(`addSidebarHeaderItem` の Component)が受ける props。
 * 出し分けはタブ(`client/sidebar-mode.ts`)から購読する(行は実装ノートで絞ったスレ一覧)。
 */
export type ChildThreadsSidebarProps = PluginSidebarItemProps;

const ICON: Record<StatusKind, string> = {
  waiting: "CircleHelp",
  running: "Loader",
  done: "CircleCheck",
  closed: "Archive",
  idle: "Circle",
};

interface AgentNavigation {
  navigation?: { openAgent: (input: { agentId: string; serverId?: string }) => void };
}

/** SDK の `openPopover`(古いホストには無いことがあるので任意で受ける)。 */
type OpenPopover = (Content: ComponentType<PluginPopoverProps>) => void;

/**
 * PC 幅で自分で描くメニューの置き場所。押した行(状態の帯)の左右端と上下端を、**外枠(root)の内側**の
 * 座標で持つ。ホストの浮きパネルは行の右端に付いてサイドバーの外へ出るので、位置はこちらで決める。
 */
interface MenuAnchor {
  /** 帯の左端(root 基準)。 */
  left: number;
  /** 帯の右端(root 基準)。 */
  right: number;
  /** 帯の上端(root 基準)。メニューの天をここに合わせる。 */
  top: number;
  /** 帯の下端(root 基準)。 */
  bottom: number;
  /** 外枠の幅(メニューをはみ出させない上限)。 */
  width: number;
  /** 外枠の高さ。 */
  height: number;
  /** 外枠の天から画面下端までの距離。ここを越えるならメニューを帯の上へ回す。 */
  windowBottom: number;
}

/**
 * グループ見出しの題名と割り方は `shared/sidebar-rows.ts` の `groupThreadRows` が持つ
 * (並べ替え・挿入の整列と同じキーの定義)。ここは開閉の保存だけを持つ。
 */
function readCollapsed(): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(set: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // 保存できなくても画面上の開閉は動く
  }
}

export function ChildThreadsSidebar(input: PluginSidebarItemProps) {
  const props = input as ChildThreadsSidebarProps;
  const { currentScreen, openScreen, theme } = props;
  const section = useSidebarMode();
  const navigation = (props as PluginSidebarItemProps & AgentNavigation).navigation;
  const list = useRpc(childThreadsListRpc);
  const signalTimes = useRpc(boxSignalRpc);
  const setOrder = useRpc(childThreadsSetOrderRpc);
  const archive = useRpc(childThreadsArchiveRpc);
  const pin = useRpc(childThreadsPinRpc);
  const setSide = useRpc(childThreadsSideRpc);
  // ドラッグ中は取得結果で一覧を差し替えない(ノート側の取得でも同じゲートを使う)。
  const dragGateUntilRef = useRef(0);
  const {
    notes,
    error: notesError,
    place,
    zones,
    implByThread,
    reload: reloadNotes,
  } = useSidebarNotes(dragGateUntilRef);
  const [threads, setThreads] = useState<ChildThread[]>([]);
  const [failed, setFailed] = useState(false);
  // サーバーが Paseo の一覧を取れず、見出しの親を「開ける親」に判定できなかったか(理由を通知行で出す)。
  const [parentsUnknown, setParentsUnknown] = useState(false);
  // 登録簿に載らないスレの取り込みが途中で切れた・取れなかったか(一部のスレが出ない。通知行で出す)。
  const [threadsIncomplete, setThreadsIncomplete] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [orderIsManual, setOrderIsManual] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const [sideOpen, setSideOpen] = useState<Record<SidebarSide, boolean>>(readSideOpen);
  const [notice, setNotice] = useState("");
  const colors = theme.colors;
  // 状態文字は行の背景に対して WCAG AA(4.5:1)を満たす色を選ぶ(グループ見出しの件数・ケアット用)。
  const statusColor = pickReadableText(colors.foregroundMuted, colors.foreground, [
    colors.surface0,
    colors.surface1,
    colors.surface2,
  ]);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      list({})
        .then((r) => {
          if (!alive) return null;
          // ドラッグ中に差し替えると行が飛ぶ。終了後(または期限切れ)まで待つ。
          if (Date.now() < dragGateUntilRef.current) return null;
          setThreads(r.threads);
          setOrderIsManual(r.orderIsManual);
          setFailed(false);
          setParentsUnknown(r.parentsUnknown === true);
          setThreadsIncomplete(r.threadsIncomplete === true);
          if (r.pinReadError) console.warn(`[child-threads] ${r.pinReadError}`);
          return null;
        })
        .catch(() => alive && setFailed(true));
    void tick();
    const timer = setInterval(tick, POLL_MS);
    // 登録簿の合図(完了・取り下げ・再投函)で即取り直す(30秒の定期取得を待たない)
    const stop = watchBoxSignal(
      () => signalTimes({}),
      (which) => {
        if (which === "child_threads") void tick();
      },
    );
    return () => {
      alive = false;
      clearInterval(timer);
      stop();
    };
  }, [list, signalTimes]);

  // アーカイブ/ピンの操作直後も取得結果で一覧を差し替えない(操作の行が飛んだり戻ったりしない)。
  const gatePoll = useCallback((ms: number) => {
    dragGateUntilRef.current = Date.now() + ms;
  }, []);

  const onDragBegin = useCallback(() => gatePoll(DRAG_POLL_GATE_MS), [gatePoll]);

  const persistOrder = useCallback(
    (keys: string[]) => {
      dragGateUntilRef.current = 0;
      // 先に画面へ反映し、保存は後追い。失敗したら次の取得でサーバーの順に戻る。
      if (keys.length > 0) setThreads((prev) => applyOrder(prev, keys));
      setOrderIsManual(keys.length > 0);
      setSaveFailed(false);
      void setOrder({ order: keys })
        .then((r) => {
          if (!r.ok) setSaveFailed(true);
          return null;
        })
        .catch(() => setSaveFailed(true));
    },
    [setOrder],
  );

  // 上段の行(ノートの status で絞り込んだ後)。司令塔の行(サーバーが先頭に置く)は
  // ノートが無ければ実装中として通る。子スレの親 id がこれに当たれば同じグループへ寄せる。
  const rows = useMemo(() => buildUpperRows(threads, implByThread), [threads, implByThread]);
  // 描画(SidebarContents)と並べ替えで同じ集合を使う(全スレから作る。common のコメント参照)。
  const coordinatorIds = useMemo(() => coordinatorIdSet(threads), [threads]);
  // グループ内のドラッグ結果を全体の並びへ戻す(他グループ・上段に出ていない行の並びはそのまま)。
  // 絞り込みで隠れている行を詰めて並べ替えると、隠れた行の順序まで動いてしまうため、
  // 画面に出ている行だけを keys で置き換える。グループの割り方は画面と同じ `rowGroupKeyOf`。
  // ピン止めグループの並べ替えも全体順への書き戻しなので、変わるのはピン同士の順だけ。
  // 並べ替えの置換先は描画と同じグループ分けの出力から作る(見出しになる行は含まない。
  // 出口レビュー round1 R1-4 / round2 R2-1)。
  const sides = useMemo(
    () =>
      groupThreadRowsBySide(
        rows,
        coordinatorIds,
        COORDINATOR_GROUP,
        PINNED_GROUP,
        PINNED_GROUP_LABEL,
        OTHER_LABEL,
      ),
    [rows, coordinatorIds],
  );
  const reorderable = useMemo(
    () => reorderableIds([...sides.walltalk, ...sides.aux]),
    [sides],
  );
  const onReorderGroup = useCallback(
    (side: SidebarSide, groupKey: string, keys: string[]) => {
      const queue = [...keys];
      // 群ごとに同じキー(ピン止め・親なし)が出るので、群(side)も合わせて当てる。
      const flat = threads.map((t) =>
        sideOfThread(t) === side &&
        rowGroupKeyOf(t, coordinatorIds, COORDINATOR_GROUP, PINNED_GROUP) === groupKey &&
        reorderable.has(t.agentId)
          ? (queue.shift() ?? t.agentId)
          : t.agentId,
      );
      // 上段に出ていない行(親の見出し・完了した行)には置き換えの id を入れない。入れるとその行が
      // 別グループへ移り、次の取得までの間だけ並びが崩れる(2026-10-27 指摘1)。
      persistOrder(flat);
    },
    [coordinatorIds, persistOrder, reorderable, threads],
  );
  const resetOrder = useCallback(() => persistOrder([]), [persistOrder]);
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      writeCollapsed(next);
      return next;
    });
  }, []);
  const toggleSideOpen = useCallback((side: SidebarSide) => {
    setSideOpen((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      writeSideOpen(next);
      return next;
    });
  }, []);
  const openAgent = navigation?.openAgent;
  /**
   * スレを開く。**コンパクト(スマホ)ではホストのサイドバーがドロワーのまま残る**ため、
   * `openAgent` だけだと遷移はしても目の前の画面が変わらず「押しても開かない」ように見える
   * (ホスト側で `openScreen` にだけ `onBeforeNavigate`(サイドバーを閉じる)が配線されている)。
   * そこでコンパクトのときは先に自前の画面へ push してドロワーを閉じ、そのうえでスレへ遷移する。
   * 開けない行(ワークスペースがアーカイブ済み)は遷移せず理由を出す(押しても会話に着かない)。
   */
  const openThread = useCallback(
    (agentId: string, access: ChildThread["access"]): void => {
      const blocked = blockedMessage(access);
      if (blocked) {
        setNotice(blocked);
        return;
      }
      if (openAgent) {
        if (props.layout.compact)
          openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: agentId } });
        openAgent({ agentId, serverId: props.host.id });
        return;
      }
      // navigationの無い古いホストは一覧画面へ退避。
      openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: agentId } });
    },
    [openAgent, openScreen, props.host.id, props.layout.compact],
  );

  // グループ見出し: 生きた親だけ、その親スレを開く。判定はサーバーが行に付けた `parentOpenable`
  // (子司令塔はデーモンの `coordinator_id` に載らないため、`coordinator` の印だけでは足りない。
  // 2026-10-24 ユーザー報告)。開閉は見出しのシェブロンが別に担う(開けない親でも開閉できる)。
  const openableParents = useMemo(() => openableParentIds(threads), [threads]);
  const openGroup = useCallback(
    (key: string) => {
      if (groupPressAction(key, openableParents, COORDINATOR_GROUP) === "toggle") {
        toggleGroup(key);
        return;
      }
      // 開くかは一覧の印が決めた。行に付く `access` は子の印なので使わない(出口レビュー round1 指摘2)。
      // 親がアーカイブ済み/閉じていればサーバーが `parentOpenable` を立てないので、開けない対象へは
      // 行かない。ワークスペースだけがアーカイブ済みの親は、いまの判定では止められない(既知の残差)。
      openThread(key, null);
    },
    [openThread, openableParents, toggleGroup],
  );

  const focusId = (currentScreen?.params as { focusId?: string } | undefined)?.focusId;
  const onScreen = currentScreen?.screenId === CHILD_THREADS_SCREEN_ID;

  const openList = useCallback(
    () => openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: {} }),
    [openScreen],
  );

  // 欠けている情報は**見出しではなく通知行**で出す(タブ化で一覧の見出しは積まない)。
  // ノートを取れないと行の status がスレ側の古い値のままになるので、その旨を必ず出す。
  const statusNotice = useMemo(() => {
    if (failed) return "スレ一覧を取得できません(表示は古い内容です)";
    if (saveFailed) return "並び順を保存できません(次の取得で戻ります)";
    if (notesError) return `ノート未取得: ${notesError}`;
    if (parentsUnknown) return "スレの一覧を取れず、見出しからは開けません(開閉のみ)";
    // 取り込みが途中で切れた: 一部のスレが出ない。元の「出ない」症状と同じ見え方になるので必ず出す。
    if (threadsIncomplete)
      return "一部のスレを取得できていません(Paseo から建てたスレの一部が欠けます)";
    return "";
  }, [failed, notesError, parentsUnknown, saveFailed, threadsIncomplete]);

  const dropThread = useCallback((agentId: string) => {
    setThreads((prev) => prev.filter((x) => x.agentId !== agentId));
  }, []);

  // アーカイブは取り消しにくいので、メニューを開いたあと2回目の押下で実行する
  // (1回目は `shared/thread-menu.ts` の `nextMenu` が確認待ちにするだけで、ここは実行しない)。
  const onArchive = useCallback(
    (t: ChildThread) => {
      setNotice("アーカイブしています…");
      gatePoll(30_000);
      // 失敗したら取得の抑止を解く(実行中のスレを断られたときなど、30秒も古い一覧のまま待たせない)。
      const ungated = () => {
        dragGateUntilRef.current = 0;
      };
      void archive({ agentId: t.agentId })
        .then((r) => {
          setNotice(r.message ?? (r.ok ? "アーカイブしました" : "アーカイブできませんでした"));
          if (r.ok) dropThread(t.agentId);
          else ungated();
          return null;
        })
        .catch((error: unknown) => {
          ungated();
          setNotice(`アーカイブできません: ${(error as Error).message}`);
        });
    },
    [archive, dropThread, gatePoll],
  );

  // ピン止めは一覧に `pinned` が返るので、保存後は次の取得(またはここでの楽観更新)で並びに反映される。
  // ピン止めした行は「ピン止め」グループへ移るので、切り替えは並びの入れ替え(下の `pinFirstGrouped`)ごと行う。
  const onTogglePin = useCallback(
    (t: ChildThread) => {
      const pinned = !t.pinned;
      gatePoll(5_000);
      const flip = (on: boolean) => (prev: ChildThread[]) =>
        pinFirstGrouped(
          prev.map((x) => (x.agentId === t.agentId ? { ...x, pinned: on } : x)),
          coordinatorIds,
        );
      setThreads((prev) => flip(pinned)(prev));
      // 成否の知らせは応答を待ってから出す(楽観更新の時点で出すと、失敗して印を戻したあとに
      // 「ピン止めしました」だけが残る)。待っている間は進行中の文言を出す。
      setNotice("保存しています…");
      // 失敗したら**この行のピンの印だけ**戻し、ゲートを解除する。操作前の一覧を丸ごと書き戻すと、
      // その間に届いた他の行の操作(アーカイブ等)まで巻き戻る(出口レビュー round2 指摘6)。
      // 印を戻すだけでグループも元へ戻る(並びの整列は `pinned` から作る。戻しても並び直す)。
      const revert = () => {
        setThreads((prev) => flip(t.pinned)(prev));
        dragGateUntilRef.current = 0;
        setNotice("ピン止めを保存できませんでした");
      };
      void pin({ agentId: t.agentId, pinned })
        .then((r) => {
          if (r.ok) setNotice(pinned ? "ピン止めしました" : "ピン止めを外しました");
          else revert();
          return null;
        })
        .catch(() => revert());
    },
    [coordinatorIds, gatePoll, pin],
  );

  // 壁打ち⇔補助スレの移動。保存はサーバー(全端末共通)。先に画面へ反映し、失敗したら戻す。
  const onToggleSide = useCallback(
    (t: ChildThread) => {
      const toAux = !t.aux;
      gatePoll(5_000);
      const apply = (aux: boolean) => (prev: ChildThread[]) =>
        prev.map((x) =>
          x.agentId === t.agentId
            ? aux
              ? { ...x, aux }
              : { ...x, aux, parentAgentId: null, parentTitle: null }
            : x,
        );
      setThreads(apply(toAux));
      setNotice("保存しています…");
      const revert = () => {
        // 親の印も落としているので、元の行そのものを書き戻す(この行だけ)。
        setThreads((prev) => prev.map((x) => (x.agentId === t.agentId ? t : x)));
        dragGateUntilRef.current = 0;
        setNotice("移動を保存できませんでした");
      };
      void setSide({ agentId: t.agentId, side: toAux ? "aux" : "walltalk" })
        .then((r) => {
          if (r.ok) {
            setNotice(toAux ? "補助スレへ移しました" : "壁打ちへ戻しました");
            dragGateUntilRef.current = 0;
          } else revert();
          return null;
        })
        .catch(() => revert());
    },
    [gatePoll, setSide],
  );

  /**
   * 状態の帯を押した: その行のメニューを**小さなポップアップ**で開く。
   *
   * 置き場所は幅で分ける(2026-10-24 ユーザー指示:「メイン画面の方じゃなくて、サイドバーの方に
   * 出して」)。
   * - **PC 幅**: 押した行の位置を測り、サイドバーの内側に**自分で**絶対配置で描く(`InlineMenu`)。
   *   ホストの `openPopover` は行の右端に付いてサイドバーの外(メイン画面)にはみ出すので使わない。
   * - **スマホ幅**: ホスト標準のボトムシート(`openPopover`)。ユーザーが「押しやすい」と確認済み。
   *   外側タップ/戻るでの閉じはホストが付ける。PC 幅の自分で描く方は Esc・外側タップをこちらで付ける。
   * どちらも一覧のレイアウトには参加しない(行の位置・高さは開いても変わらない)。
   */
  const openPopover = (
    props as Partial<PluginSidebarItemProps> & {
      openPopover?: OpenPopover;
    }
  ).openPopover;
  // スマホ幅かはホストの `layout.compact` に合わせる(ホストのボトムシートへ切り替わる境目と同じ)。
  const compact = props.layout.compact;
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null);
  // メニューを出した時点の対象(押した行の題名・アーカイブ可否・スレ)。開いた瞬間に確定させる。
  const menuTargetRef = useRef<{ thread: ChildThread; title: string; canArchive: boolean } | null>(
    null,
  );
  // 押した行の位置(root 基準。PC 幅でメニューをその帯の直下/直上に置くために測る)。
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  // メニュー(絶対配置)の置き場所。行の位置を測る基準でもある。
  const rootRef = useRef<View | null>(null);
  const closeMenu = useCallback(() => {
    setMenuAgentId(null);
    setMenuAnchor(null);
  }, []);
  // スマホ幅はホスト標準のボトムシートをそのまま使う(ユーザーが「押しやすい」と確認済み)。
  // 閉じる手段はホストが本体へ渡す `close` だけ。本体から登録してもらう。
  const menuCloseRef = useRef<(() => void) | null>(null);
  const registerMenuClose = useCallback((close: (() => void) | null) => {
    menuCloseRef.current = close;
  }, []);
  const applyMenuIntent = useCallback(
    (t: ChildThread, canArchiveNow: boolean, intent: ThreadMenuIntent) => {
      if (intent === "toggle-pin") onTogglePin(t);
      else if (intent === "toggle-side") onToggleSide(t);
      // 司令塔はアーカイブしない。メニューから項目を消すだけだと、他の入口(将来のショートカット等)が
      // 増えたときに破られるので、実行側でも止める(出口レビュー round2 指摘3)。
      else if (intent === "archive") {
        if (canArchiveNow) onArchive(t);
      } else if (intent === "open-thread") openThread(t.agentId, t.access);
    },
    [onArchive, onTogglePin, onToggleSide, openThread],
  );
  // 本体へ渡す操作ハンドラ(毎回新しい関数を JSX に渡さない。react-perf)。
  const menuActionProps = useMemo(() => {
    const target = menuTargetRef.current;
    if (!target) return null;
    // 対象は ref から取るので依存は applyMenuIntent だけ(呼び出す側では useMemo の値)。
    const menuAction = (intent: ThreadMenuIntent) =>
      applyMenuIntent(target.thread, target.canArchive, intent);
    return { target, onAction: menuAction };
    // 対象は開き直すたびに `menuAgentId` と一緒に差し替わるので、id も依存に入れて作り直す。
  }, [applyMenuIntent, menuAgentId]); // oxlint-disable-line react-hooks/exhaustive-deps
  // 本体の描画。状態(確認待ち)は `ThreadMenu` の中に持つので、ここは開いた時点の対象を渡すだけ。
  const renderMenuPopover = useCallback(
    (popover: PluginPopoverProps) => {
      const { target, onAction } = menuActionProps ?? EMPTY_MENU_ACTION;
      if (!target || !onAction) return null;
      return (
        <ThreadMenu
          // 行が変わったら確認待ちを引き継がない(別の行のアーカイブが2回目で走らない)
          key={target.thread.agentId}
          thread={target.thread}
          title={target.title}
          // 司令塔(子を持つ行)はアーカイブさせない(誤って親を畳まない安全側。2026-10-24 子司令塔決定)。
          // ピンは残す。規則は純粋関数が正。
          canArchive={target.canArchive}
          colors={popover.theme.colors}
          compact={popover.layout.compact}
          onAction={onAction}
          onClose={popover.close}
          registerClose={registerMenuClose}
        />
      );
    },
    [menuActionProps, registerMenuClose],
  );
  // ホストは「渡された部品」を state に持つので、毎回新しい部品にすると開き直しが効かない。
  // 中身は ref 経由で最新にする(古い props を掴んだまま表示しない)。
  const renderMenuPopoverRef = useRef(renderMenuPopover);
  renderMenuPopoverRef.current = renderMenuPopover;
  const menuPopoverComponent = useMemo<ComponentType<PluginPopoverProps>>(() => {
    function ThreadMenuPopover(popover: PluginPopoverProps) {
      return renderMenuPopoverRef.current(popover);
    }
    return ThreadMenuPopover;
  }, []);

  const onMenuOpen = useCallback(
    (row: SidebarRowView<ChildThread>, anchorNode: unknown) => {
      // PC 幅は押した行の位置を測って自分で描く。測れない・狭い幅ではホストの浮きパネル
      // (狭い幅ではボトムシート)に任せる。どちらも無ければ理由を出す。
      const anchor = compact ? null : measureMenuAnchor(anchorNode, rootRef.current);
      if (!anchor && !openPopover) {
        // 古いホストには無い。押しても黙って何も起きないより理由を出す。
        setNotice("この版の Paseo では行メニューを開けません");
        return;
      }
      const t = row.thread;
      setMenuAnchor(anchor);
      // 他の行の親になっている id はアーカイブさせない(司令塔の印が無い親の行も畳ませない)。
      const parentIds = new Set(
        threads.map((x) => x.parentAgentId).filter((id): id is string => id !== null),
      );
      menuTargetRef.current = {
        thread: t,
        // 題名は**行に出ている題名**(ノートがあればノートの題名)。スレ側の題名は古いことがある。
        title: row.title,
        canArchive: menuCanArchive(t, parentIds),
      };
      setMenuAgentId(t.agentId);
      // 自分で描ける行はホストへ渡さない(サイドバーの外にはみ出さない)。
      if (!anchor) openPopover?.(menuPopoverComponent);
    },
    [compact, menuPopoverComponent, openPopover, threads],
  );
  const onMenuOpenAnchor = useCallback(
    (row: SidebarRowView<ChildThread>, anchor: unknown) => {
      // 開いている行の帯をもう一度押したら閉じる(トグル。開き直すと2段階確認もやり直しになる)。
      if (menuAgentId === row.thread.agentId) {
        closeMenu();
        return;
      }
      onMenuOpen(row, anchor);
    },
    [closeMenu, menuAgentId, onMenuOpen],
  );
  // 自分で描くメニュー。開いている行が無ければ何も描かない(絶対配置なので一覧の高さは変わらない)。
  // 幅の判定はここでやり直す: 狭くなったらシートへ、広くなったらシートを閉じて自分で描く。
  const inlineMenu = useMemo(() => {
    if (!menuAgentId || !menuActionProps || compact || !menuAnchor) return null;
    const { target, onAction } = menuActionProps;
    return (
      <ThreadMenu
        // 行が変わったら確認待ちを引き継がない(別の行のアーカイブが2回目で走らない)
        key={target.thread.agentId}
        thread={target.thread}
        title={target.title}
        canArchive={target.canArchive}
        colors={colors}
        onAction={onAction}
        onClose={closeMenu}
        registerClose={registerMenuClose}
      />
    );
  }, [closeMenu, colors, compact, menuActionProps, menuAgentId, menuAnchor, registerMenuClose]);

  // タブを切り替えたら開いているメニューは閉じる(隠れた一覧の行のメニューが残らない)。
  // 幅の種別(PC↔スマホ)が変わったときも閉じる: 描き手が自分→ホストのシート(またはその逆)に
  // 変わり、開いたままの状態が画面に出ないまま残るのを避ける。
  useEffect(() => {
    menuCloseRef.current?.();
    setMenuAgentId(null);
    setMenuAnchor(null);
  }, [compact, section]);
  // アーカイブ等で対象が一覧から消えたら閉じる(同じ id が戻ってきたときに勝手に開かない。
  // 出口レビュー round1 指摘6)。
  useEffect(() => {
    if (menuAgentId && !threads.some((t) => t.agentId === menuAgentId)) {
      menuCloseRef.current?.();
      setMenuAgentId(null);
    }
  }, [menuAgentId, threads]);

  // 点の色は純正のパレットを明暗で選ぶ(プラグインには appearance が渡らないので背景の輝度で判定)。
  const dotIcons = useMemo(
    () => stateDotIcons(appearanceOf(colors.surface2 ?? colors.surface1 ?? colors.surface0)),
    [colors.surface0, colors.surface1, colors.surface2],
  );
  const renderThread = useCallback(
    (row: SidebarRowView<ChildThread>) => (
      <ThreadRow
        row={row}
        failed={failed}
        active={onScreen && focusId === row.thread.agentId}
        dotIcons={dotIcons}
        onOpen={openThread}
        onOpenMenu={onMenuOpenAnchor}
      />
    ),
    [dotIcons, failed, focusId, onMenuOpenAnchor, onScreen, openThread],
  );

  return (
    // 相対配置の外枠: メニュー(絶対配置)の置き場所であり、行の位置を測る基準になる。
    <View ref={rootRef} style={styles.root}>
      <SidebarContents
        section={section}
        rows={rows}
        coordinatorIds={coordinatorIds}
        collapsed={collapsed}
        statusNotice={statusNotice}
        notice={notice}
        noticeColor={colors.foregroundMuted}
        statusColor={statusColor}
        orderIsManual={orderIsManual}
        failed={failed}
        onOpenList={openList}
        sideOpen={sideOpen}
        onToggleSide={toggleSideOpen}
        onToggleGroup={toggleGroup}
        onOpenGroup={openGroup}
        onDragBegin={onDragBegin}
        onReorderGroup={onReorderGroup}
        renderThread={renderThread}
        onResetOrder={resetOrder}
        notes={notes}
        notesError={notesError}
        notesPlace={place}
        notesZones={zones}
        colors={colors}
        openAgent={navigation?.openAgent}
        serverId={props.host.id}
        openScreen={openScreen}
        onNotesCreated={reloadNotes}
      />
      {inlineMenu && menuAnchor ? (
        <InlineMenu anchor={menuAnchor} colors={colors} close={closeMenu}>
          {inlineMenu}
        </InlineMenu>
      ) : null}
    </View>
  );
}

/**
 * PC 幅の行メニュー。**サイドバー(外枠)の内側**に絶対配置で重ねる。
 *
 * ホストの浮きパネルは行の右端に付いてサイドバーの外(メイン画面側)にはみ出すので使わない
 * (2026-10-24 ユーザー指示「メイン画面の方じゃなくて、サイドバーの方に出して」)。置き方は
 * **押した行のすぐ下**、下に入りきらなければ**行の上**。左右は外枠の右端に寄せ、幅は外枠から
 * はみ出さない値に丸める。絶対配置なので、開いても他の行の位置・高さは変わらない。
 *
 * 閉じる手段はこちらで付ける(外枠全体を覆う透明な幕のタップ / Esc / メニューの外のタップ)。
 */
function InlineMenu({
  anchor,
  colors,
  close,
  children,
}: {
  anchor: MenuAnchor;
  colors: PluginSidebarItemProps["theme"]["colors"];
  close: () => void;
  children: React.ReactNode;
}) {
  // 高さは描いてみるまで分からない(題名が2行になる等)。測れるまでは透明にしておく
  // (見えた瞬間に位置が飛ばない)。
  const [height, setHeight] = useState<number | null>(null);
  const panelRef = useRef<View | null>(null);
  const onLayout = useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    const next = Math.round(event.nativeEvent.layout.height);
    setHeight((prev) => (prev === next ? prev : next));
  }, []);
  // Esc で閉じる(ホストの浮きパネル・シートと同じ扱い)。
  useEffect(() => {
    if (!isWeb()) return undefined;
    const onKey = (event: { key?: string }) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  // サイドバーの外(メイン画面)を押しても閉じる。外枠の中は下の幕が受ける。
  useEffect(() => {
    if (!isWeb()) return undefined;
    const onDown = (event: { target?: EventTarget | null }) => {
      const panel = panelRef.current as unknown as HTMLElement | null;
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [close]);
  const layout = useMemo(() => {
    // 外枠の内側に収まる幅(左右の余白を空ける)。狭いサイドバーでも外へ出さない。
    const width = Math.max(
      Math.min(MENU_MAX_WIDTH, Math.round(anchor.width - EDGE_PADDING * 2)),
      0,
    );
    const left = Math.max(Math.round(anchor.width - EDGE_PADDING - width), 0);
    const below = anchor.bottom + GAP;
    // 外枠の見えている範囲(ウィンドウ下端と外枠の下端の近い方)を越えない。
    const limit = Math.min(anchor.height, anchor.windowBottom) - EDGE_PADDING;
    const panelHeight = height ?? 0;
    const fitsBelow = below + panelHeight <= limit;
    const above = anchor.top - GAP - panelHeight;
    const top = fitsBelow || above < EDGE_PADDING ? below : above;
    return { top: Math.max(Math.round(top), 0), left, width };
  }, [anchor, height]);
  const positionStyle = useMemo(
    () => ({ ...layout, opacity: height === null ? 0 : 1 }),
    [height, layout],
  );
  const panelStyle = useMemo(
    () => [
      styles.inlineMenu,
      positionStyle,
      { backgroundColor: colors.surface1 ?? colors.surface0, borderColor: colors.border },
    ],
    [colors.border, colors.surface0, colors.surface1, positionStyle],
  );
  return (
    <View style={styles.inlineMenuLayer}>
      {/* 外枠全体を覆う幕。開いている間に他の行を押すと、その行を開かずにメニューだけ閉じる。 */}
      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="メニューを閉じる"
        testID="child-thread-menu-inline-backdrop"
        style={StyleSheet.absoluteFill}
      />
      <View ref={panelRef} style={panelStyle} onLayout={onLayout} testID="child-thread-menu-inline">
        {children}
      </View>
    </View>
  );
}

/**
 * 押した行(状態の帯)の位置を、外枠(root)の内側の座標で測る。Web では DOM の矩形を直接使う。
 * 測れなければ null(呼び出し元はホストの浮きパネルへ退避)。
 */
function measureMenuAnchor(node: unknown, rootNode: unknown): MenuAnchor | null {
  const el = node as Partial<HTMLElement> | null | undefined;
  const root = rootNode as Partial<HTMLElement> | null | undefined;
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  if (!root || typeof root.getBoundingClientRect !== "function") return null;
  const rect = el.getBoundingClientRect();
  const base = root.getBoundingClientRect();
  if (rect.width <= 0 || base.width <= 0) return null;
  return {
    left: rect.left - base.left,
    right: rect.right - base.left,
    top: rect.top - base.top,
    bottom: rect.bottom - base.top,
    width: base.width,
    height: base.height,
    windowBottom: typeof window === "undefined" ? base.height : window.innerHeight - base.top,
  };
}

function isWeb(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * サイドバーの本体。`section`(タブの現在値)で**どちらか一方だけ**を描く
 * (スレ一覧と構想一覧を積まない。2026-10-24 指示)。
 */
function SidebarContents({
  section,
  rows,
  coordinatorIds,
  collapsed,
  sideOpen,
  onToggleSide,
  statusNotice,
  notice,
  noticeColor,
  statusColor,
  orderIsManual,
  failed,
  onOpenList,
  onToggleGroup,
  onOpenGroup,
  onDragBegin,
  onReorderGroup,
  renderThread,
  onResetOrder,
  notes,
  notesError,
  notesPlace,
  notesZones,
  colors,
  openAgent,
  serverId,
  openScreen,
  onNotesCreated,
}: {
  section: SidebarSectionKey;
  rows: readonly SidebarRowView<ChildThread>[];
  /** 司令塔の id 集合(全スレから作ったもの。呼び出し元の並べ替えと同じ集合)。 */
  coordinatorIds: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  /** 壁打ち・補助スレそれぞれの開閉(端末ごと)。 */
  sideOpen: Record<SidebarSide, boolean>;
  onToggleSide: (side: SidebarSide) => void;
  /** 取得の失敗など、一覧が欠けていることの通知(空なら出さない)。 */
  statusNotice: string;
  notice: string;
  noticeColor: string;
  statusColor: string;
  orderIsManual: boolean;
  failed: boolean;
  onOpenList: () => void;
  onToggleGroup: (key: string) => void;
  onOpenGroup: (key: string) => void;
  onDragBegin: () => void;
  onReorderGroup: (side: SidebarSide, key: string, keys: string[]) => void;
  renderThread: (row: SidebarRowView<ChildThread>) => React.ReactElement;
  onResetOrder: () => void;
  /** 構想一覧の材料(`ConceptNotesList` へ渡す)。 */
  notes: readonly SidebarNote[];
  notesError: string | null;
  /** 構想の置き場と件数(`ConceptNotesList` へ渡す)。 */
  notesPlace: SidebarPlace;
  notesZones: ZoneCounts;
  /** 行メニューの配色。 */
  colors: PluginSidebarItemProps["theme"]["colors"];
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
  onNotesCreated: () => void;
}) {
  // `coordinatorIds` は呼び出し元から受ける(上段に出ている行だけで作ると、上段から外れた司令塔の
  // 子スレが「司令塔」から漏れ、並べ替え側のキーとずれる。出口レビュー round3 指摘3)。
  const sides = useMemo(
    () =>
      groupThreadRowsBySide(
        rows,
        coordinatorIds,
        COORDINATOR_GROUP,
        PINNED_GROUP,
        PINNED_GROUP_LABEL,
        OTHER_LABEL,
      ),
    [rows, coordinatorIds],
  );
  const noticeStyle = useMemo(() => [styles.noticeText, { color: noticeColor }], [noticeColor]);
  const statusNoticeStyle = useMemo(
    () => [styles.noticeText, { color: statusColor }],
    [statusColor],
  );
  const emptyLabel = emptySectionLabel(section);
  if (section === "projects") {
    return <SharedProjectsList openScreen={openScreen} />;
  }
  if (section === "concepts") {
    // 構想一覧: 見出しはタブ自体が担うので積まない。押すと深掘りスレを開く(無ければ作ってノートに記録)。
    return (
      <ConceptNotesList
        notes={notes}
        error={notesError}
        openAgent={openAgent}
        serverId={serverId}
        openScreen={openScreen}
        statusColor={statusColor}
        place={notesPlace}
        zones={notesZones}
        colors={colors}
        onCreated={onNotesCreated}
      />
    );
  }
  return (
    <>
      {statusNotice ? (
        <View style={styles.notice}>
          <Text style={statusNoticeStyle}>{statusNotice}</Text>
        </View>
      ) : null}
      <StatusCountChips rows={rows} openScreen={openScreen} />
      {(["walltalk", "aux"] as const).map((side) => (
        <SideSection
          key={side}
          side={side}
          groups={sides[side]}
          waiting={side === "aux" ? sides.auxWaiting : 0}
          open={sideOpen[side]}
          collapsed={collapsed}
          onToggleSide={onToggleSide}
          onToggleGroup={onToggleGroup}
          onOpenGroup={onOpenGroup}
          onDragBegin={onDragBegin}
          onReorderGroup={onReorderGroup}
          renderThread={renderThread}
          statusColor={statusColor}
        />
      ))}
      {notice ? (
        <View style={styles.notice}>
          <Text style={noticeStyle}>{notice}</Text>
        </View>
      ) : null}
      {!failed && rows.length === 0 ? (
        <SidebarRow
          id="child-threads-empty"
          icon="ListTodo"
          label={emptyLabel}
          onPress={onOpenList}
        />
      ) : null}
      {orderIsManual ? (
        <SidebarRow
          id="child-threads-reset-order"
          icon="RotateCcw"
          label="並び順を自動に戻す"
          onPress={onResetOrder}
        />
      ) : null}
    </>
  );
}

/**
 * 「壁打ち」「補助スレ」の1群(2026-10-30)。見出しの行末に件数と開閉のシェブロンを置く。
 * 補助スレは折りたたんでいても、判断待ちが1件でもあれば見出しに「判断待ち N」を出す(見落とさない)。
 * 群が空なら見出しごと出さない。
 */
function SideSection({
  side,
  groups,
  waiting,
  open,
  collapsed,
  onToggleSide,
  onToggleGroup,
  onOpenGroup,
  onDragBegin,
  onReorderGroup,
  renderThread,
  statusColor,
}: {
  side: SidebarSide;
  groups: ThreadGroup<ChildThread>[];
  waiting: number;
  open: boolean;
  collapsed: ReadonlySet<string>;
  onToggleSide: (side: SidebarSide) => void;
  onToggleGroup: (key: string) => void;
  onOpenGroup: (key: string) => void;
  onDragBegin: () => void;
  onReorderGroup: (side: SidebarSide, key: string, keys: string[]) => void;
  renderThread: (row: SidebarRowView<ChildThread>) => React.ReactElement;
  statusColor: string;
}) {
  const toggle = useCallback(() => onToggleSide(side), [onToggleSide, side]);
  const reorder = useCallback(
    (key: string, keys: string[]) => onReorderGroup(side, key, keys),
    [onReorderGroup, side],
  );
  const textStyle = useMemo(() => ({ color: statusColor }), [statusColor]);
  const chevronStyle = useMemo(() => [styles.chevron, { color: statusColor }], [statusColor]);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const label = SIDE_LABEL[side];
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        {waiting > 0 ? (
          <StatusBadge
            text={`判断待ち ${waiting}`}
            kind="waiting"
            testID={`child-side-waiting-${side}`}
          />
        ) : null}
        <Text style={textStyle}>{count}</Text>
        <Pressable
          onPress={toggle}
          testID={`child-side-toggle-${side}`}
          accessibilityRole="button"
          accessibilityLabel={open ? `${label}をたたむ` : `${label}を開く`}
          hitSlop={8}
          style={styles.toggleHit}
        >
          <Text style={chevronStyle}>{open ? "▾" : "▸"}</Text>
        </Pressable>
      </View>
    ),
    [chevronStyle, count, label, open, side, textStyle, toggle, waiting],
  );
  if (groups.length === 0) return null;
  return (
    <>
      <SidebarRow
        id={`child-side-${side}`}
        icon={side === "aux" ? "Archive" : "MessageSquare"}
        label={label}
        onPress={toggle}
        trailing={trailing}
      />
      {open
        ? groups.map((g) => (
            <ThreadGroupSection
              key={g.key}
              group={g}
              open={!collapsed.has(g.key)}
              onToggle={onToggleGroup}
              onOpenCoordinator={onOpenGroup}
              onDragBegin={onDragBegin}
              onReorderGroup={reorder}
              renderThread={renderThread}
              statusColor={statusColor}
            />
          ))
        : null}
    </>
  );
}

function ThreadGroupSection({
  group,
  open,
  onToggle,
  onOpenCoordinator,
  onDragBegin,
  onReorderGroup,
  renderThread,
  statusColor,
}: {
  group: ThreadGroup<ChildThread>;
  open: boolean;
  onToggle: (key: string) => void;
  /** Opens the group's coordinator agent; absent on older hosts. */
  onOpenCoordinator?: (key: string) => void;
  onDragBegin: () => void;
  onReorderGroup: (key: string, keys: string[]) => void;
  renderThread: (row: SidebarRowView<ChildThread>) => React.ReactElement;
  /** 件数・ケアットの色(WCAG AA)。 */
  statusColor: string;
}) {
  const reorder = useCallback(
    (keys: string[]) => onReorderGroup(group.key, keys),
    [group.key, onReorderGroup],
  );
  // 見出しの押下 = 生きた親のスレを開く(開けるかは `onOpenCoordinator` が親の一覧の印で決める)。
  // 開閉は行末のシェブロンだけが担う(行の押下と開閉を分ける。開けない親でも開閉はできる)。
  const openCoordinator = useCallback(() => {
    if (!onOpenCoordinator) {
      onToggle(group.key);
      return;
    }
    onOpenCoordinator(group.key);
  }, [group.key, onOpenCoordinator, onToggle]);
  const toggle = useCallback(() => onToggle(group.key), [group.key, onToggle]);
  const textStyle = useMemo(() => ({ color: statusColor }), [statusColor]);
  const chevronStyle = useMemo(() => [styles.chevron, { color: statusColor }], [statusColor]);
  const count = group.rows.length;
  // 見出しの状態(子司令塔)。件数の左に出す(帯の文字・色は行と同じ規則)。
  const headingStatus = group.heading
    ? rowStatusText(group.heading.statusLabel, group.heading.thread.machineState)
    : null;
  // ピン止めグループは開閉しない(出した行を畳む意味が無く、畳むと「ピン止めしたのに見えない」に戻る)。
  // 件数とシェブロンは出さず、常に開いたまま並べる。
  const pinned = group.key === PINNED_GROUP;
  // 件数とシェブロンは同じ行末に並べる(シェブロンは開閉専用の当たり判定)。
  const trailing = useMemo(
    () =>
      pinned ? undefined : (
        <View style={styles.trailing}>
          {headingStatus ? (
            <StatusBadge
              text={headingStatus.text}
              kind={headingStatus.kind}
              testID={`child-group-status-${group.key || "other"}`}
            />
          ) : null}
          <Text style={textStyle}>{count}</Text>
          <Pressable
            onPress={toggle}
            testID={`child-group-toggle-${group.key || "other"}`}
            accessibilityRole="button"
            accessibilityLabel={open ? `${group.title}をたたむ` : `${group.title}を開く`}
            hitSlop={8}
            style={styles.toggleHit}
          >
            <Text style={chevronStyle}>{open ? "▾" : "▸"}</Text>
          </Pressable>
        </View>
      ),
    [chevronStyle, count, group.key, group.title, headingStatus, open, pinned, textStyle, toggle],
  );
  const shown = pinned || open || group.key === "";
  return (
    <>
      {group.key === "" ? null : (
      <SidebarRow
        id={`child-group-${group.key || "other"}`}
        icon="ListTodo"
        label={group.title}
        onPress={openCoordinator}
        trailing={trailing}
      />
      )}
      {shown ? (
        <SidebarReorderableList
          testID={`child-threads-list-${group.key || "other"}`}
          data={group.rows}
          keyExtractor={keyOfRow}
          renderItem={renderThread}
          onDragBegin={onDragBegin}
          onReorder={reorder}
        />
      ) : null}
    </>
  );
}

const keyOfRow = (r: SidebarRowView<ChildThread>) => r.thread.agentId;

/**
 * 画面の並び(keys)を先に、keysに無い行(取得の隙間に入った新規)を既定順のまま後ろに。
 * ピン止めした行は「ピン止め」グループへ移るので、**出現順のまま先頭へ集め**、それ以外の行は
 * グループ単位の出現順を保つ(`pinFirstGrouped`。サーバーの規則と同じ)。
 */
function applyOrder(threads: readonly ChildThread[], keys: readonly string[]): ChildThread[] {
  const byId = new Map(threads.map((t) => [t.agentId, t]));
  const out: ChildThread[] = [];
  for (const key of keys) {
    const thread = byId.get(key);
    if (!thread) continue;
    out.push(thread);
    byId.delete(key);
  }
  for (const thread of threads) if (byId.has(thread.agentId)) out.push(thread);
  return pinFirstGrouped(out, new Set(out.filter((t) => t.coordinator).map((t) => t.agentId)));
}

/**
 * ピン止めした行を先頭グループへ、出現順のまま集める(サーバーの並びと同じ規則)。
 * ピン行は「ピン止め」グループとして独立して出るので、グループ内の先頭へ寄せる処理は要らない。
 * それ以外の行はグループ単位の出現順を保つ(グループ内の相対順もそのまま)。
 */
function pinFirstGrouped(
  threads: readonly ChildThread[],
  coordinatorIds: ReadonlySet<string>,
): ChildThread[] {
  const groups = new Map<string, ChildThread[]>();
  for (const t of threads) {
    const key = rowGroupKeyOf(t, coordinatorIds, COORDINATOR_GROUP, PINNED_GROUP);
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const pinned = groups.get(PINNED_GROUP) ?? [];
  const rest = [...groups.entries()].filter(([key]) => key !== PINNED_GROUP).map(([, g]) => g);
  return [...pinned, ...rest].flat();
}

/** 印(アイコン)はノート由来の status で選ぶ。ノートの無い行はスレ側の status。開けない行は箱。 */
function rowIcon(row: SidebarRowView<ChildThread>, t: ChildThread): string {
  if (t.coordinator) return "Command";
  if (t.access === "workspace-archived") return ICON.closed;
  // 止まったスレは帯の語彙に関わらず「終了」の見た目にする(従来どおり)。
  if (t.machineState === "closed") return ICON.closed;
  if (row.note?.status === "確認待ち") return "CircleCheck"; // 旧語彙のノート(移行中だけ)
  if (row.statusLabel === "判断待ち") return "CircleHelp";
  if (row.statusLabel === "実装中" && t.status === "完了") return "Loader";
  // 帯と同じ判断で選ぶ(登録簿に載らないスレは「待機中」= idle、閉じたスレは「終了」のアイコン)。
  return ICON[rowStatusKind(row.statusLabel, t.machineState)];
}

/**
 * 一覧の上に出す「判断待ち N」。帯と同じ色(橙)で、押すと下部バーと同じ画面(ユーザー判断)を開く。
 * 2026-10-26 に「完了待ち」を廃止したので、完了待ちの件数チップは無い。
 * 0件の状態は出さない(件数の無いチップは情報にならない)。
 */
function StatusCountChips({
  rows,
  openScreen,
}: {
  rows: readonly SidebarRowView<ChildThread>[];
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
}) {
  const { judgment, running, coordinator, idle, closed } = useMemo(
    () => countStatusLabels(rows),
    [rows],
  );
  const openJudgment = useCallback(() => openScreen({ screenId: BOX_TAB_SCREEN_ID }), [openScreen]);
  if (judgment + running + coordinator + idle + closed === 0) return null;
  return (
    <View style={styles.chips} testID="status-count-chips">
      {judgment > 0 ? (
        <StatusBadge
          text={`判断待ち ${judgment}`}
          kind="waiting"
          testID="status-count-judgment"
          onPress={openJudgment}
        />
      ) : null}
      {running > 0 ? (
        <StatusBadge text={`実装中 ${running}`} kind="running" testID="status-count-running" />
      ) : null}
      {coordinator > 0 ? (
        <StatusBadge
          text={`司令塔 ${coordinator}`}
          kind="running"
          testID="status-count-coordinator"
        />
      ) : null}
      {idle > 0 ? (
        <StatusBadge text={`待機中 ${idle}`} kind="idle" testID="status-count-idle" />
      ) : null}
      {closed > 0 ? (
        <StatusBadge text={`終了 ${closed}`} kind="closed" testID="status-count-closed" />
      ) : null}
    </View>
  );
}

/**
 * 行末の帯の文字と色。
 *
 * - 開けない行は状態より先に「要復元」を出す(押しても会話に着かないことが行末で分かる)。
 * - 完了箱C(完了報告の窓口)は、読んでいない報告があるあいだ「未読あり」にする
 *   (2026-10-26 ユーザー依頼)。橙は判断待ち専用なので、点と同じ新着の緑を使う。
 *   既読になったらサーバーが印を外し、帯は「待機中」に戻る(`server/window-unread.ts`)。
 */
function threadStatusOf(
  row: SidebarRowView<ChildThread>,
  state: { failed: boolean; unread: boolean },
): { text: string; kind: StatusKind } {
  const stale = state.failed ? "(古い表示)" : "";
  if (row.thread.access === "workspace-archived") return { text: "要復元", kind: "closed" };
  if (state.unread) return { text: `未読あり${stale}`, kind: "done" };
  // 表示はノート(正)のまま。閉じたスレの「実装中」だけ「終了」にする(規則は共有側の1か所)。
  const base = rowStatusText(row.statusLabel, row.thread.machineState);
  // 登録簿とノートの状態が食い違うときは、登録簿側の語も添える(2026-10-27 指摘6・12a)。
  // どちらが正か決めない・表示を片方に寄せない(食い違いを見えるようにするだけ)。
  const conflict = row.conflict?.registry != null ? `(登録簿:${row.conflict.registry})` : "";
  return { text: `${base.text}${conflict}${stale}`, kind: base.kind };
}

function ThreadRow({
  row,
  failed,
  active,
  dotIcons,
  onOpen,
  onOpenMenu,
}: {
  row: SidebarRowView<ChildThread>;
  failed: boolean;
  active: boolean;
  /** 状態の点(左端のアイコンの位置に出す。明暗は呼び出し元が選ぶ)。 */
  dotIcons: Record<StateDotKind, StateDotIcon>;
  /** 押したらそのスレを開く(開けない行の判定・ドロワーを閉じる処理は呼び出し側 `openThread`)。 */
  onOpen: (agentId: string, access: ChildThread["access"]) => void;
  /**
   * 状態の帯を押した: その行のメニューをポップアップで開く(題名・アーカイブ可否は行から作る)。
   * 第2引数は帯の要素(PC 幅でメニューをその直下に置くために測る。RN のネイティブでは null)。
   */
  onOpenMenu: (row: SidebarRowView<ChildThread>, badgeNode?: unknown) => void;
}) {
  const t = row.thread;
  const onPress = useCallback(() => onOpen(t.agentId, t.access), [onOpen, t.agentId, t.access]);
  const status = threadStatusOf(row, { failed, unread: t.unread === true });
  const testID = `child-thread-status-${t.agentId}`;
  // 状態の帯を押すとメニュー(ピン止め/アーカイブ/スレを開く)が開く。司令塔の行も例外にしない:
  // 旧実装では司令塔の行にもピン/アーカイブのボタンがあったので、外すと機能の退行になる
  // (出口レビュー round1 指摘5)。文字は「司令塔」にして他の行の状態と混ぜない。
  const badgeText = t.coordinator ? "司令塔" : status.text;
  const badgeKind: StatusKind = t.coordinator ? "running" : status.kind;
  // 帯の位置を渡す(PC 幅はメニューをこの帯のすぐ下/上に置く)。ref は帯を含む行末の容器に付ける
  // (帯そのものに ref を渡すには `StatusBadge` の props を増やす必要がある)。
  const badgeRef = useRef<View | null>(null);
  const pressBadge = useCallback(() => onOpenMenu(row, badgeRef.current), [onOpenMenu, row]);
  // 行末は状態の帯ひとつだけ。帯そのものがメニューの入口(2026-10-24 ユーザー指示)で、
  // 行末に別のボタンを並べない(2026-10-26、⋯ を戻した後退の差し戻し)。
  const trailing = useMemo(
    () => (
      <View ref={badgeRef} style={styles.trailing}>
        <StatusBadge text={badgeText} kind={badgeKind} testID={testID} onPress={pressBadge} />
      </View>
    ),
    [badgeKind, badgeText, pressBadge, testID],
  );
  // メニューは行の中に差し込まない(ホストのポップアップに出す)。行の高さは開いても変わらない。
  return (
    <SidebarRow
      id={t.agentId}
      // 点が出せる行は先頭のアイコンを点に置き換える(純正と同じ意味・色)。点の材料が無い行
      // (一覧に居ない等)だけ従来のアイコンを残す。
      icon={row.dot ? dotIcons[row.dot] : rowIcon(row, t)}
      label={row.title}
      active={active}
      onPress={onPress}
      trailing={trailing}
    />
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  // 外枠: 絶対配置のメニューの基準。中身の大きさはこれまでどおり(自身は高さを取らない)。
  root: {
    position: "relative",
  },
  // メニューの層。外枠いっぱいを覆い、幕(タップで閉じる)とパネルを置く。中身は押し通さない。
  inlineMenuLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  // パネル本体。ホストの浮きパネルに近い見た目(角丸・枠・影)を自前で持つ。
  inlineMenu: {
    position: "absolute",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    overflow: "hidden",
    ...(isWeb()
      ? { boxShadow: "0 4px 16px rgba(0,0,0,0.18)" }
      : {
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        }),
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  notice: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  noticeText: {
    fontSize: 12,
  },
  chevron: {
    fontSize: 11,
  },
  // タッチ端末でも開閉を狙えるよう当たり判定を広げる(見出し本体は司令塔を開く)。
  toggleHit: {
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
