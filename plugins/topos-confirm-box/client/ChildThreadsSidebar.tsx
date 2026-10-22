/**
 * サイドバーの子スレ行。1スレ=1行(`SidebarRow id=agentId`)。題名+状態を出し、
 * 押すと子スレ一覧画面を開く(そのスレを先頭で展開)。
 *
 * 並び順はドラッグで変更でき、`child_threads_order.json` に保存される
 * (既存の `child_threads.json` は触らない)。保存が無ければサーバーの既定順。
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarReorderableList, SidebarRow } from "@getpaseo/plugin/client/ui";
import { childThreadsListRpc, childThreadsSetOrderRpc } from "../shared/child-threads.js";
import type { ChildThread, ChildThreadStatus } from "../shared/child-threads.js";

const POLL_MS = 30_000;
const COLLAPSED_KEY = "topos-child-groups-collapsed";
const OTHER_GROUP = "";
const OTHER_LABEL = "その他";
/** ドラッグ中は取得結果で一覧を差し替えない(キャンセル時に固まらないよう期限付き)。 */
const DRAG_POLL_GATE_MS = 60_000;
export const CHILD_THREADS_SCREEN_ID = "child-threads";

const ICON: Record<ChildThreadStatus, string> = {
  ユーザー判断待ち: "CircleHelp",
  実装中: "Loader",
  完了: "CircleCheck",
};

interface AgentNavigation {
  navigation?: { openAgent: (input: { agentId: string; serverId?: string }) => void };
}

const groupKeyOf = (t: ChildThread) => t.parentAgentId ?? OTHER_GROUP;

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

/** サーバーの並び(グループ単位でまとまっている)を出現順のままグループへ割る。 */
function groupThreads(threads: readonly ChildThread[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const t of threads) {
    const key = groupKeyOf(t);
    let g = groups.get(key);
    if (!g) {
      g = { key, title: t.parentTitle || OTHER_LABEL, threads: [] };
      groups.set(key, g);
    }
    g.threads.push(t);
  }
  return [...groups.values()];
}

export function ChildThreadsSidebar(props: PluginSidebarItemProps) {
  const { currentScreen, openScreen } = props;
  const navigation = (props as PluginSidebarItemProps & AgentNavigation).navigation;
  const list = useRpc(childThreadsListRpc);
  const setOrder = useRpc(childThreadsSetOrderRpc);
  const [threads, setThreads] = useState<ChildThread[]>([]);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [orderIsManual, setOrderIsManual] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const dragGateUntilRef = useRef(0);

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

  const onDragBegin = useCallback(() => {
    dragGateUntilRef.current = Date.now() + DRAG_POLL_GATE_MS;
  }, []);

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

  // グループ内のドラッグ結果を全体の並びへ戻す(他グループの並びはそのまま)。
  const onReorderGroup = useCallback(
    (groupKey: string, keys: string[]) => {
      const queue = [...keys];
      const flat = threads.map((t) =>
        groupKeyOf(t) === groupKey ? (queue.shift() ?? t.agentId) : t.agentId,
      );
      persistOrder(flat);
    },
    [persistOrder, threads],
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
  const groups = useMemo(() => groupThreads(threads), [threads]);

  // グループ見出し(親=司令塔)は司令塔スレを開く。「その他」だけは従来どおり開閉。
  const openAgent = navigation?.openAgent;
  const openGroup = useCallback(
    (key: string) => {
      if (!key) {
        toggleGroup(key);
        return;
      }
      if (openAgent) {
        openAgent({ agentId: key, serverId: props.host.id });
        return;
      }
      // navigationの無い古いホストは一覧画面へ退避。
      openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: key } });
    },
    [openAgent, openScreen, props.host.id, toggleGroup],
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

  const renderThread = useCallback(
    (t: ChildThread) => (
      <ThreadRow
        thread={t}
        failed={failed}
        active={onScreen && focusId === t.agentId}
        openScreen={openScreen}
        openAgent={navigation?.openAgent}
        serverId={props.host.id}
      />
    ),
    [failed, focusId, navigation?.openAgent, onScreen, openScreen, props.host.id],
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
        />
      ))}
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
}: {
  group: ThreadGroup;
  open: boolean;
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
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        <Text>{group.threads.length}</Text>
        <Pressable
          onPress={toggle}
          testID={`child-group-toggle-${group.key || "other"}`}
          accessibilityRole="button"
          accessibilityLabel={open ? `${group.title}をたたむ` : `${group.title}を開く`}
          hitSlop={8}
          style={styles.toggleHit}
        >
          <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        </Pressable>
      </View>
    ),
    [group.key, group.threads.length, group.title, open, toggle],
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

/** 画面の並び(keys)を先に、keysに無い行(取得の隙間に入った新規)を既定順のまま後ろに。 */
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
  return out;
}

function ThreadRow({
  thread: t,
  failed,
  active,
  openScreen,
  openAgent,
  serverId,
}: {
  thread: ChildThread;
  failed: boolean;
  active: boolean;
  openScreen: PluginSidebarItemProps["openScreen"];
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
}) {
  // 押したらそのスレの会話(エージェント画面)を開く。navigationが無い古いホストだけ一覧画面へ退避。
  const onPress = useCallback(() => {
    if (openAgent) openAgent({ agentId: t.agentId, serverId });
    else openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: t.agentId } });
  }, [openAgent, openScreen, serverId, t.agentId]);
  const trailing = useMemo(
    () => <Text>{failed ? `${t.status}(古い表示)` : t.status}</Text>,
    [failed, t.status],
  );
  return (
    <SidebarRow
      id={t.agentId}
      icon={ICON[t.status]}
      label={t.title}
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
    gap: 4,
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
