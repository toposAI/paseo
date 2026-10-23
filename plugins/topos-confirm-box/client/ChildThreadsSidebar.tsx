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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarReorderableList, SidebarRow } from "@getpaseo/plugin/client/ui";
import {
  childThreadsArchiveRpc,
  childThreadsListRpc,
  childThreadsPinRpc,
  childThreadsSetOrderRpc,
} from "../shared/child-threads.js";
import type { ChildThread } from "../shared/child-threads.js";
import { blockedMessage } from "../shared/child-threads.js";
import { buildUpperRows } from "../shared/sidebar-rows.js";
import type { SidebarRowView } from "../shared/sidebar-rows.js";
import type { NoteStatus, SidebarNote } from "../shared/notes.js";
import { emptySectionLabel } from "../shared/sidebar-section-mode.js";
import type { SidebarSectionKey } from "../shared/sidebar-section-mode.js";
import { displayStatus, type StatusKind } from "../shared/thread-status-label.js";
import { pickReadableText } from "../shared/contrast.js";
import { CLOSED_MENU, nextMenu } from "../shared/thread-menu.js";
import type { ThreadMenuAction, ThreadMenuState } from "../shared/thread-menu.js";
import { ConceptNotesList, useSidebarNotes } from "./ConceptNotes.js";
import { StatusBadge } from "./sidebar-badge.js";
import { useSidebarMode } from "./sidebar-mode.js";
import { ThreadMenu } from "./ThreadMenu.js";

const POLL_MS = 30_000;
const COLLAPSED_KEY = "topos-child-groups-collapsed";
const OTHER_GROUP = "";
const OTHER_LABEL = "その他";
/**
 * 司令塔スレのグループのキー(登録簿の parent id と衝突しない値)。純正の固定一覧を外した後、
 * 司令塔を開く入口をここが担う。生きている司令塔はサーバーが行として返し(`coordinator: true`)、
 * 司令塔の子スレはすべてこのグループに並べる(司令塔ごとに見出しが分かれない)。
 */
const COORDINATOR_GROUP = "__coordinators";
/** ドラッグ中は取得結果で一覧を差し替えない(キャンセル時に固まらないよう期限付き)。 */
const DRAG_POLL_GATE_MS = 60_000;
export const CHILD_THREADS_SCREEN_ID = "child-threads";

/**
 * サイドバーのカスタム内容(`addSidebarHeaderItem` の Component)が受ける props。
 * 出し分けはタブ(`client/sidebar-mode.ts`)から購読する。`rows` を渡すとスレ一覧の行をそれに
 * 差し替える(テスト・将来の別の一覧用。省略時は実装ノートで絞ったスレ一覧)。
 */
export type ChildThreadsSidebarProps = PluginSidebarItemProps & {
  rows?: readonly SidebarRowView<ChildThread>[];
};

const ICON: Record<StatusKind, string> = {
  waiting: "CircleHelp",
  running: "Loader",
  done: "CircleCheck",
  closed: "Archive",
};

interface AgentNavigation {
  navigation?: { openAgent: (input: { agentId: string; serverId?: string }) => void };
}

const groupKeyOf = (t: ChildThread) => t.parentAgentId ?? OTHER_GROUP;

/**
 * 画面上のグループのキー。司令塔の行そのものと、司令塔の子スレは1つの「司令塔」グループへ寄せる
 * (司令塔ごとに見出しを分けない)。並べ替えの当たり判定もこの関数を使い、グループの割り方と揃える。
 */
function visibleGroupKeyOf(t: ChildThread, coordinatorIds: ReadonlySet<string>): string {
  const underCoordinator =
    t.coordinator === true || (t.parentAgentId !== null && coordinatorIds.has(t.parentAgentId));
  return underCoordinator ? COORDINATOR_GROUP : groupKeyOf(t);
}

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

interface ThreadGroup {
  key: string;
  title: string;
  rows: SidebarRowView<ChildThread>[];
}

/**
 * サーバーの並び(グループ単位でまとまっている)を出現順のままグループへ割る。
 * 上段の絞り込み(実装ノートの status)を通した後の行で割る。司令塔の行と司令塔の子スレは
 * 1つの「司令塔」グループへ寄せ、先頭に出す(キーの規則は `visibleGroupKeyOf`)。
 */
function groupRows(
  rows: readonly SidebarRowView<ChildThread>[],
  coordinatorIds: ReadonlySet<string>,
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  const coordinatorGroup: ThreadGroup = { key: COORDINATOR_GROUP, title: "司令塔", rows: [] };
  for (const r of rows) {
    const key = visibleGroupKeyOf(r.thread, coordinatorIds);
    let g = groups.get(key);
    if (!g) {
      g =
        key === COORDINATOR_GROUP
          ? coordinatorGroup
          : { key, title: r.thread.parentTitle || OTHER_LABEL, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  return coordinatorGroup.rows.length > 0
    ? [coordinatorGroup, ...[...groups.values()].filter((g) => g !== coordinatorGroup)]
    : [...groups.values()];
}

export function ChildThreadsSidebar(input: PluginSidebarItemProps) {
  const props = input as ChildThreadsSidebarProps;
  const { currentScreen, openScreen, theme } = props;
  const section = useSidebarMode();
  const navigation = (props as PluginSidebarItemProps & AgentNavigation).navigation;
  const list = useRpc(childThreadsListRpc);
  const setOrder = useRpc(childThreadsSetOrderRpc);
  const archive = useRpc(childThreadsArchiveRpc);
  const pin = useRpc(childThreadsPinRpc);
  // ドラッグ中は取得結果で一覧を差し替えない(ノート側の取得でも同じゲートを使う)。
  const dragGateUntilRef = useRef(0);
  const {
    notes,
    error: notesError,
    implByThread,
    reload: reloadNotes,
  } = useSidebarNotes(dragGateUntilRef);
  const [threads, setThreads] = useState<ChildThread[]>([]);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [orderIsManual, setOrderIsManual] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  // 開いている操作メニュー(1つだけ)。確認待ち(アーカイブの1回目)もここに持つ。
  const [menu, setMenu] = useState<{ agentId: string; state: ThreadMenuState } | null>(null);
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
          if (r.pinReadError) console.warn(`[child-threads] ${r.pinReadError}`);
          return null;
        })
        .catch(() => alive && setFailed(true));
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [list]);

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
  // タブ切替UIから `rows` が渡された場合はそれを出す(構想一覧も同じ口で受ける)。
  const rows = useMemo(
    () => props.rows ?? buildUpperRows(threads, implByThread),
    [props.rows, threads, implByThread],
  );
  const coordinatorIds = useMemo(
    () => new Set(threads.filter((t) => t.coordinator === true).map((t) => t.agentId)),
    [threads],
  );
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.thread.agentId)), [rows]);

  // グループ内のドラッグ結果を全体の並びへ戻す(他グループ・上段に出ていない行の並びはそのまま)。
  // 絞り込みで隠れている行を詰めて並べ替えると、隠れた行の順序まで動いてしまうため、
  // 画面に出ている行だけを keys で置き換える。グループの割り方は画面と同じ `visibleGroupKeyOf`。
  const onReorderGroup = useCallback(
    (groupKey: string, keys: string[]) => {
      const queue = [...keys];
      const flat = threads.map((t) =>
        visibleGroupKeyOf(t, coordinatorIds) === groupKey && visibleIds.has(t.agentId)
          ? (queue.shift() ?? t.agentId)
          : t.agentId,
      );
      persistOrder(flat);
    },
    [coordinatorIds, persistOrder, threads, visibleIds],
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

  // グループ見出し: 生きている司令塔の行が在るときだけ、その司令塔スレを開く。
  // 行が無い(閉じた/一覧に居ない)親の見出しを押して開きに行くと、開けない画面へ落ちるだけなので開閉にする。
  // 「司令塔」グループの見出しは開閉だけ(行が複数あるため、どの司令塔を開くか決められない)。
  const openableParents = useMemo(
    () => new Set(threads.filter((t) => t.coordinator === true).map((t) => t.agentId)),
    [threads],
  );
  const openGroup = useCallback(
    (key: string) => {
      if (!key || key === COORDINATOR_GROUP || !openableParents.has(key)) {
        toggleGroup(key);
        return;
      }
      openThread(key, threads.find((t) => t.agentId === key)?.access ?? null);
    },
    [openThread, openableParents, threads, toggleGroup],
  );

  const focusId = (currentScreen?.params as { focusId?: string } | undefined)?.focusId;
  const onScreen = currentScreen?.screenId === CHILD_THREADS_SCREEN_ID;

  // タブを切り替えたら開いているメニューは閉じる(隠れた一覧の行のメニューが残らない)。
  useEffect(() => setMenu(null), [section]);

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
    return "";
  }, [failed, notesError, saveFailed]);

  const dropThread = useCallback((agentId: string) => {
    setThreads((prev) => prev.filter((x) => x.agentId !== agentId));
  }, []);

  // アーカイブは取り消しにくいので、メニューを開いたあと2回目の押下で実行する
  // (1回目は `shared/thread-menu.ts` の `nextMenu` が確認待ちにするだけで、ここは実行しない)。
  const onArchive = useCallback(
    (t: ChildThread) => {
      setNotice("アーカイブしています…");
      gatePoll(30_000);
      void archive({ agentId: t.agentId })
        .then((r) => {
          setNotice(r.message ?? (r.ok ? "アーカイブしました" : "アーカイブできませんでした"));
          if (r.ok) dropThread(t.agentId);
          return null;
        })
        .catch((error: unknown) => setNotice(`アーカイブできません: ${(error as Error).message}`));
    },
    [archive, dropThread, gatePoll],
  );

  // ピン止めは一覧に `pinned` が返るので、保存後は次の取得(またはここでの楽観更新)で並びに反映される。
  const onTogglePin = useCallback(
    (t: ChildThread) => {
      const pinned = !t.pinned;
      gatePoll(5_000);
      const flip = (on: boolean) => (prev: ChildThread[]) =>
        pinFirstPerGroup(
          prev.map((x) => (x.agentId === t.agentId ? { ...x, pinned: on } : x)),
          coordinatorIds,
        );
      setThreads(flip(pinned));
      setNotice(pinned ? "ピン止めしました" : "ピン止めを外しました");
      const revert = () => setThreads(flip(!pinned));
      void pin({ agentId: t.agentId, pinned })
        .then((r) => {
          if (!r.ok) {
            revert();
            setNotice(r.message ?? "ピン止めを保存できません");
          }
          return null;
        })
        .catch((error: unknown) => {
          revert();
          setNotice(`ピン止めを保存できません: ${(error as Error).message}`);
        });
    },
    [coordinatorIds, gatePoll, pin],
  );

  /** 状態の帯を押した: その行のメニューを開く(既に別の行のが開いていれば閉じて開き直す)。 */
  const onMenuOpen = useCallback((agentId: string) => {
    setMenu({ agentId, state: nextMenu(CLOSED_MENU, "open").state });
  }, []);

  const applyMenuAction = useCallback(
    (t: ChildThread, action: ThreadMenuAction) => {
      if (!menu || menu.agentId !== t.agentId) return;
      // 状態遷移は純粋関数が正(アーカイブの1回目では実行しない)。
      const step = nextMenu(menu.state, action);
      // 副作用は updater の外で走らせる(StrictMode で 2 回呼ばれてもアーカイブを二重に撃たない)。
      setMenu(step.state.open ? { agentId: t.agentId, state: step.state } : null);
      if (step.intent === "toggle-pin") onTogglePin(t);
      else if (step.intent === "archive") onArchive(t);
      else if (step.intent === "open-thread") openThread(t.agentId, t.access);
    },
    [menu, onArchive, onTogglePin, openThread],
  );

  const renderThread = useCallback(
    (row: SidebarRowView<ChildThread>) => {
      const t = row.thread;
      return (
        <ThreadRow
          row={row}
          failed={failed}
          active={onScreen && focusId === t.agentId}
          onOpen={openThread}
          onOpenMenu={onMenuOpen}
        />
      );
    },
    [failed, focusId, onMenuOpen, onScreen, openThread],
  );

  // メニューの対象は取得結果から引き直す(ピン状態がポーリング後も最新になる)。
  const menuThread = menu ? threads.find((t) => t.agentId === menu.agentId) : undefined;
  const onMenuAction = useCallback(
    (action: ThreadMenuAction) => {
      if (menuThread) applyMenuAction(menuThread, action);
    },
    [applyMenuAction, menuThread],
  );

  return (
    <>
      <SidebarContents
        section={section}
        rows={rows}
        collapsed={collapsed}
        statusNotice={statusNotice}
        notice={notice}
        noticeColor={colors.foregroundMuted}
        statusColor={statusColor}
        orderIsManual={orderIsManual}
        failed={failed}
        onOpenList={openList}
        onToggleGroup={toggleGroup}
        onOpenGroup={openGroup}
        onDragBegin={onDragBegin}
        onReorderGroup={onReorderGroup}
        renderThread={renderThread}
        onResetOrder={resetOrder}
        notes={notes}
        notesError={notesError}
        openAgent={navigation?.openAgent}
        serverId={props.host.id}
        openScreen={openScreen}
        onNotesCreated={reloadNotes}
      />
      {menuThread && menu ? (
        <ThreadMenu
          thread={menuThread}
          state={menu.state}
          colors={colors}
          onAction={onMenuAction}
        />
      ) : null}
    </>
  );
}

/**
 * サイドバーの本体。`section`(タブの現在値)で**どちらか一方だけ**を描く
 * (スレ一覧と構想一覧を積まない。2026-10-24 指示)。
 */
function SidebarContents({
  section,
  rows,
  collapsed,
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
  openAgent,
  serverId,
  openScreen,
  onNotesCreated,
}: {
  section: SidebarSectionKey;
  rows: readonly SidebarRowView<ChildThread>[];
  collapsed: ReadonlySet<string>;
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
  onReorderGroup: (key: string, keys: string[]) => void;
  renderThread: (row: SidebarRowView<ChildThread>) => React.ReactElement;
  onResetOrder: () => void;
  /** 構想一覧の材料(`ConceptNotesList` へ渡す)。 */
  notes: readonly SidebarNote[];
  notesError: string | null;
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
  onNotesCreated: () => void;
}) {
  const coordinatorIds = useMemo(
    () => new Set(rows.filter((r) => r.thread.coordinator === true).map((r) => r.thread.agentId)),
    [rows],
  );
  const groups = useMemo(() => groupRows(rows, coordinatorIds), [rows, coordinatorIds]);
  const noticeStyle = useMemo(() => [styles.noticeText, { color: noticeColor }], [noticeColor]);
  const statusNoticeStyle = useMemo(
    () => [styles.noticeText, { color: statusColor }],
    [statusColor],
  );
  const emptyLabel = emptySectionLabel(section);
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
      {groups.map((g) => (
        <ThreadGroupSection
          key={g.key}
          group={g}
          open={!collapsed.has(g.key)}
          onToggle={onToggleGroup}
          onOpenCoordinator={onOpenGroup}
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
  group: ThreadGroup;
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
  // 純正の固定済み一覧を外したので、司令塔(親)行そのものが司令塔スレへの入口になる。
  // 開閉は行末のケアットだけが担う(行の押下と開閉を分ける)。
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
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
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
    [chevronStyle, count, group.key, group.title, open, textStyle, toggle],
  );
  return (
    <>
      <SidebarRow
        id={`child-group-${group.key || "other"}`}
        icon="ListTodo"
        label={group.title}
        onPress={openCoordinator}
        trailing={trailing}
      />
      {open ? (
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
 * ピン止めした行はそのグループの先頭に寄せる(保存順のまま。グループ内の相対順は崩さない)。
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
  return pinFirstPerGroup(out, new Set(out.filter((t) => t.coordinator).map((t) => t.agentId)));
}

/** グループの並び(出現順)は変えず、グループ内だけピン止めを先頭へ(サーバーの並びと同じ規則)。 */
function pinFirstPerGroup(
  threads: readonly ChildThread[],
  coordinatorIds: ReadonlySet<string>,
): ChildThread[] {
  const groups = new Map<string, ChildThread[]>();
  for (const t of threads) {
    const key = visibleGroupKeyOf(t, coordinatorIds);
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const out: ChildThread[] = [];
  for (const g of groups.values()) {
    for (const t of g) if (t.pinned) out.push(t);
    for (const t of g) if (!t.pinned) out.push(t);
  }
  return out;
}

/** 印(アイコン)はノート由来の status で選ぶ。ノートの無い行はスレ側の status。開けない行は箱。 */
function rowIcon(row: SidebarRowView<ChildThread>, t: ChildThread): string {
  if (t.coordinator) return "Command";
  if (t.access === "workspace-archived") return ICON.closed;
  if (row.note?.status === "確認待ち") return "CircleCheck";
  if (row.statusLabel === "判断待ち") return "CircleHelp";
  if (row.statusLabel === "実装中" && t.status === "完了") return "Loader";
  return ICON[displayStatus(t.status, t.machineState).kind];
}

/** 状態の帯の色(上段は実装ノートの status が正なので、その語彙で色を選ぶ)。 */
function kindOfStatusLabel(label: NoteStatus): StatusKind {
  if (label === "完了") return "done";
  if (label === "判断待ち" || label === "構想") return "waiting";
  if (label === "確認待ち") return "done";
  return "running";
}

function ThreadRow({
  row,
  failed,
  active,
  onOpen,
  onOpenMenu,
}: {
  row: SidebarRowView<ChildThread>;
  failed: boolean;
  active: boolean;
  /** 押したらそのスレを開く(開けない行の判定・ドロワーを閉じる処理は呼び出し側 `openThread`)。 */
  onOpen: (agentId: string, access: ChildThread["access"]) => void;
  /** 状態の帯を押した: ピン/アーカイブのメニューを開く。 */
  onOpenMenu: (agentId: string) => void;
}) {
  const t = row.thread;
  const onPress = useCallback(() => onOpen(t.agentId, t.access), [onOpen, t.agentId, t.access]);
  // 開けない行は状態より先に「要復元」を出す(押しても会話に着かないことが行末で分かる)。
  const status: { text: string; kind: StatusKind } =
    t.access === "workspace-archived"
      ? { text: "要復元", kind: "closed" }
      : {
          text: failed ? `${row.statusLabel}(古い表示)` : row.statusLabel,
          kind: kindOfStatusLabel(row.statusLabel),
        };
  const testID = `child-thread-status-${t.agentId}`;
  const showsBadge = !(t.coordinator && t.access !== "workspace-archived");
  const pressBadge = useCallback(() => onOpenMenu(t.agentId), [onOpenMenu, t.agentId]);
  // 行末は状態の帯だけ。帯を押すとメニュー(ピン止め/アーカイブ/スレを開く/閉じる)が開く。
  // 司令塔の行は帯を出さないので、メニューの入口も持たない(司令塔の一覧側で操作する)。
  const trailing = useMemo(
    () =>
      showsBadge ? (
        <View style={styles.trailing}>
          <StatusBadge text={status.text} kind={status.kind} testID={testID} onPress={pressBadge} />
        </View>
      ) : null,
    [pressBadge, showsBadge, status.kind, status.text, testID],
  );
  return (
    <SidebarRow
      id={t.agentId}
      icon={rowIcon(row, t)}
      label={row.title}
      active={active}
      onPress={onPress}
      trailing={trailing}
    />
  );
}

const styles = StyleSheet.create({
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
