/**
 * サイドバーの子スレ行。1スレ=1行(`SidebarRow id=agentId`)。題名+状態を出し、
 * 押すと子スレ一覧画面を開く(そのスレを先頭で展開)。
 *
 * 並び順はドラッグで変更でき、`child_threads_order.json` に保存される
 * (既存の `child_threads.json` は触らない)。保存が無ければサーバーの既定順。
 *
 * 行末の状態ラベルは**必ずテーマ色を自分で与える**(与えないとホスト既定の黒になり、
 * ダークテーマで背景に溶ける)。ピン止め(`child_threads_pins.json`)とアーカイブ
 * (スレ + ワークスペース)は行内のボタン。アーカイブは誤爆しないよう2度押しで実行する。
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
import { displayStatus, type StatusKind, type StatusLabel } from "../shared/thread-status-label.js";
import { StatusBadge } from "./sidebar-badge.js";

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
  threads: ChildThread[];
}

/**
 * サーバーの並び(グループ単位でまとまっている)を出現順のままグループへ割る。
 * 司令塔の行と司令塔の子スレは1つの「司令塔」グループへ寄せる(キーの規則は `visibleGroupKeyOf`)。
 */
function groupThreads(
  threads: readonly ChildThread[],
  coordinatorIds: ReadonlySet<string>,
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  const coordinatorGroup: ThreadGroup = { key: COORDINATOR_GROUP, title: "司令塔", threads: [] };
  for (const t of threads) {
    const key = visibleGroupKeyOf(t, coordinatorIds);
    let g = groups.get(key);
    if (!g) {
      g =
        key === COORDINATOR_GROUP
          ? coordinatorGroup
          : { key, title: t.parentTitle || OTHER_LABEL, threads: [] };
      groups.set(key, g);
    }
    g.threads.push(t);
  }
  // 司令塔グループは先頭(空なら出さない)。
  return coordinatorGroup.threads.length > 0
    ? [coordinatorGroup, ...[...groups.values()].filter((g) => g !== coordinatorGroup)]
    : [...groups.values()];
}

export function ChildThreadsSidebar(props: PluginSidebarItemProps) {
  const { currentScreen, openScreen, theme } = props;
  const navigation = (props as PluginSidebarItemProps & AgentNavigation).navigation;
  const list = useRpc(childThreadsListRpc);
  const setOrder = useRpc(childThreadsSetOrderRpc);
  const archive = useRpc(childThreadsArchiveRpc);
  const pin = useRpc(childThreadsPinRpc);
  const [threads, setThreads] = useState<ChildThread[]>([]);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [orderIsManual, setOrderIsManual] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const dragGateUntilRef = useRef(0);
  const colors = theme.colors;
  const noticeStyle = useMemo(
    () => [styles.noticeText, { color: colors.foregroundMuted }],
    [colors],
  );

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

  // 司令塔の行(サーバーが先頭に置く)。子スレの親 id がこれに当たれば同じグループへ寄せる。
  const coordinatorIds = useMemo(
    () => new Set(threads.filter((t) => t.coordinator === true).map((t) => t.agentId)),
    [threads],
  );

  // グループ内のドラッグ結果を全体の並びへ戻す(他グループの並びはそのまま)。
  // グループの割り方は画面と同じ `visibleGroupKeyOf` を使う(司令塔グループでも並べ替えが効く)。
  const onReorderGroup = useCallback(
    (groupKey: string, keys: string[]) => {
      const queue = [...keys];
      const flat = threads.map((t) =>
        visibleGroupKeyOf(t, coordinatorIds) === groupKey
          ? (queue.shift() ?? t.agentId)
          : t.agentId,
      );
      persistOrder(flat);
    },
    [coordinatorIds, persistOrder, threads],
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
  const groups = useMemo(() => groupThreads(threads, coordinatorIds), [threads, coordinatorIds]);

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

  const openList = useCallback(
    () => openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: {} }),
    [openScreen],
  );
  let headerLabel: string;
  if (failed) headerLabel = `子スレ ${threads.length}件(取得失敗)`;
  else if (saveFailed) headerLabel = `子スレ ${threads.length}件(並び順を保存できません)`;
  else headerLabel = `子スレ ${threads.length}件`;

  const dropThread = useCallback((agentId: string) => {
    setThreads((prev) => prev.filter((x) => x.agentId !== agentId));
  }, []);

  // アーカイブは取り消しにくいので、同じ行をもう一度押したときだけ実行する(押した直後は「もう一度押す」に変わる)。
  const onArchive = useCallback(
    (t: ChildThread) => {
      if (pendingId !== t.agentId) {
        setPendingId(t.agentId);
        setNotice(`「もう一度」でアーカイブ: ${t.title}`);
        return;
      }
      setPendingId(null);
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
    [archive, dropThread, gatePoll, pendingId],
  );

  // ピン止めは一覧に `pinned` が返るので、保存後は次の取得(またはここでの楽観更新)で並びに反映される。
  const onTogglePin = useCallback(
    (t: ChildThread) => {
      const pinned = !t.pinned;
      gatePoll(5_000);
      setThreads((prev) =>
        pinFirstPerGroup(prev.map((x) => (x.agentId === t.agentId ? { ...x, pinned } : x))),
      );
      setNotice(pinned ? "ピン止めしました" : "ピン止めを外しました");
      const revert = () =>
        setThreads((prev) =>
          pinFirstPerGroup(
            prev.map((x) => (x.agentId === t.agentId ? { ...x, pinned: !pinned } : x)),
          ),
        );
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
    [gatePoll, pin],
  );

  const renderThread = useCallback(
    (t: ChildThread) => (
      <ThreadRow
        thread={t}
        failed={failed}
        active={onScreen && focusId === t.agentId}
        onOpen={openThread}
        colors={colors}
        confirmingArchive={pendingId === t.agentId}
        onArchive={onArchive}
        onTogglePin={onTogglePin}
      />
    ),
    [colors, failed, focusId, onArchive, onScreen, onTogglePin, openThread, pendingId],
  );

  return (
    <>
      <SidebarRow
        id="child-threads-header"
        icon="ListTodo"
        label={headerLabel}
        active={onScreen && !focusId}
        onPress={openList}
      />
      {groups.map((g) => (
        <ThreadGroupSection
          key={g.key}
          group={g}
          open={!collapsed.has(g.key)}
          onToggle={toggleGroup}
          onOpenCoordinator={openGroup}
          onDragBegin={onDragBegin}
          onReorderGroup={onReorderGroup}
          renderThread={renderThread}
          colors={colors}
        />
      ))}
      {notice ? (
        <View style={styles.notice}>
          <Text style={noticeStyle}>{notice}</Text>
        </View>
      ) : null}
      {!failed && threads.length === 0 ? (
        <SidebarRow
          id="child-threads-empty"
          icon="ListTodo"
          label="子スレはありません"
          onPress={openList}
        />
      ) : null}
      {orderIsManual ? (
        <SidebarRow
          id="child-threads-reset-order"
          icon="RotateCcw"
          label="並び順を自動に戻す"
          onPress={resetOrder}
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
  colors,
}: {
  group: ThreadGroup;
  open: boolean;
  colors: PluginSidebarItemProps["theme"]["colors"];
  onToggle: (key: string) => void;
  /** Opens the group's coordinator agent; absent on older hosts. */
  onOpenCoordinator?: (key: string) => void;
  onDragBegin: () => void;
  onReorderGroup: (key: string, keys: string[]) => void;
  renderThread: (t: ChildThread) => React.ReactElement;
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
  const metaStyle = useMemo(() => [styles.metaText, { color: colors.foregroundMuted }], [colors]);
  const chevronStyle = useMemo(() => [styles.chevron, { color: colors.foregroundMuted }], [colors]);
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        <Text style={metaStyle}>{group.threads.length}</Text>
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
    [chevronStyle, group.key, group.threads.length, group.title, metaStyle, open, toggle],
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
          data={group.threads}
          keyExtractor={keyOfThread}
          renderItem={renderThread}
          onDragBegin={onDragBegin}
          onReorder={reorder}
        />
      ) : null}
    </>
  );
}

const keyOfThread = (t: ChildThread) => t.agentId;

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
  return pinFirstPerGroup(out);
}

function pinFirstPerGroup(threads: readonly ChildThread[]): ChildThread[] {
  // グループの並び(出現順)は変えず、グループ内だけピン止めを先頭へ(サーバーの並びと同じ規則)。
  const groups = new Map<string, ChildThread[]>();
  for (const t of threads) {
    const key = groupKeyOf(t);
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

type SidebarColors = PluginSidebarItemProps["theme"]["colors"];

function ThreadRow({
  thread: t,
  failed,
  active,
  onOpen,
  colors,
  confirmingArchive,
  onArchive,
  onTogglePin,
}: {
  thread: ChildThread;
  failed: boolean;
  active: boolean;
  /** 押したらそのスレを開く(開けない行の判定・ドロワーを閉じる処理は呼び出し側 `openThread`)。 */
  onOpen: (agentId: string, access: ChildThread["access"]) => void;
  colors: SidebarColors;
  confirmingArchive: boolean;
  onArchive: (t: ChildThread) => void;
  onTogglePin: (t: ChildThread) => void;
}) {
  const onPress = useCallback(() => onOpen(t.agentId, t.access), [onOpen, t.agentId, t.access]);
  // 開けない行は状態より先に「要復元」を出す(押しても会話に着かないことが行末で分かる)。
  const status: StatusLabel =
    t.access === "workspace-archived"
      ? { text: "要復元", kind: "closed" }
      : displayStatus(t.status, t.machineState, failed);
  const testID = `child-thread-status-${t.agentId}`;
  const pressArchive = useCallback(() => onArchive(t), [onArchive, t]);
  const pressPin = useCallback(() => onTogglePin(t), [onTogglePin, t]);
  const pinLabel = t.pinned ? `${t.title}のピン止めを外す` : `${t.title}をピン止め`;
  const archiveLabel = confirmingArchive
    ? `${t.title}をアーカイブする(もう一度押す)`
    : `${t.title}をアーカイブ`;
  const { agentId } = t;
  const archiveStyle = useMemo(
    () => [styles.iconHit, confirmingArchive && styles.iconHitConfirm],
    [confirmingArchive],
  );
  const pinColor = t.pinned ? colors.foreground : colors.foregroundMuted;
  const archiveColor = confirmingArchive ? "#b91c1c" : colors.foregroundMuted;
  // 行末: ピン止め → アーカイブ(確認待ち) → 状態ラベル。幅は状態ラベル分で固定され、題名がここへ重ならない。
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        <Pressable
          onPress={pressPin}
          testID={`child-thread-pin-${agentId}`}
          accessibilityRole="button"
          accessibilityLabel={pinLabel}
          hitSlop={6}
          style={styles.iconHit}
        >
          <PinGlyph filled={t.pinned} color={pinColor} />
        </Pressable>
        <Pressable
          onPress={pressArchive}
          testID={`child-thread-archive-${agentId}`}
          accessibilityRole="button"
          accessibilityLabel={archiveLabel}
          hitSlop={6}
          style={archiveStyle}
        >
          <ArchiveGlyph color={archiveColor} />
        </Pressable>
        {/* 司令塔の行も状態ラベルを出さない(下のグループ見出しと同じ扱い。開けない印だけは出す)。
            アーカイブのボタンは残す。 */}
        {t.coordinator && t.access !== "workspace-archived" ? null : (
          <StatusBadge text={status.text} kind={status.kind} testID={testID} />
        )}
      </View>
    ),
    [
      agentId,
      archiveColor,
      archiveLabel,
      archiveStyle,
      pinColor,
      pinLabel,
      pressArchive,
      pressPin,
      status.kind,
      status.text,
      t.access,
      t.coordinator,
      t.pinned,
      testID,
    ],
  );
  return (
    <SidebarRow
      id={t.agentId}
      icon={t.coordinator ? "Command" : ICON[status.kind]}
      label={t.title}
      active={active}
      onPress={onPress}
      trailing={trailing}
    />
  );
}

/** ピン止めのアイコン(プラグインAPIにアイコン一覧が無いため View で描く)。 */
function PinGlyph({ filled, color }: { filled: boolean; color: string }) {
  const headStyle = useMemo(
    () => [styles.pinHead, { borderColor: color, backgroundColor: filled ? color : "transparent" }],
    [color, filled],
  );
  const stemStyle = useMemo(() => [styles.pinStem, { backgroundColor: color }], [color]);
  return (
    <View style={styles.pinGlyph}>
      <View style={headStyle} />
      <View style={stemStyle} />
    </View>
  );
}

/** アーカイブのアイコン(箱)。 */
function ArchiveGlyph({ color }: { color: string }) {
  const boxStyle = useMemo(() => [styles.archiveBox, { borderColor: color }], [color]);
  const lidStyle = useMemo(() => [styles.archiveLid, { backgroundColor: color }], [color]);
  return (
    <View style={boxStyle}>
      <View style={lidStyle} />
    </View>
  );
}

const styles = StyleSheet.create({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  metaText: {
    fontSize: 12,
  },
  iconHit: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  iconHitConfirm: {
    backgroundColor: "#fee2e2",
  },
  pinGlyph: {
    alignItems: "center",
  },
  pinHead: {
    width: 9,
    height: 7,
    borderWidth: 1.5,
    borderRadius: 2,
  },
  pinStem: {
    width: 1.5,
    height: 4,
  },
  archiveBox: {
    width: 12,
    height: 9,
    borderWidth: 1.5,
    borderRadius: 1.5,
    justifyContent: "flex-start",
  },
  archiveLid: {
    height: 1.5,
    marginTop: 2,
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
