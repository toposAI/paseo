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
import { buildUpperRows } from "../shared/sidebar-rows.js";
import type { SidebarRowView } from "../shared/sidebar-rows.js";
import { pickReadableText } from "../shared/contrast.js";
import { ConceptNotesSection, useSidebarNotes } from "./ConceptNotes.js";

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

/**
 * 行右端に確保する幅。ピン止め・アーカイブの2ボタン(6f957aa9 が実装)が同じ行に入る前提で
 * 状態文字の前を空けておく。ボタン実装時にここを置き場に使う。
 */
const TRAILING_ACTIONS_WIDTH = 44;

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
  rows: SidebarRowView<ChildThread>[];
}

/**
 * サーバーの並び(グループ単位でまとまっている)を出現順のままグループへ割る。
 * 上段の絞り込み(実装ノートの status)を通した後の行で割る。
 */
function groupRows(rows: readonly SidebarRowView<ChildThread>[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const r of rows) {
    const key = groupKeyOf(r.thread);
    let g = groups.get(key);
    if (!g) {
      g = { key, title: r.thread.parentTitle || OTHER_LABEL, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()];
}

export function ChildThreadsSidebar(props: PluginSidebarItemProps) {
  const { currentScreen, openScreen } = props;
  const navigation = (props as PluginSidebarItemProps & AgentNavigation).navigation;
  const list = useRpc(childThreadsListRpc);
  const setOrder = useRpc(childThreadsSetOrderRpc);
  const { notes, error: notesError, implByThread } = useSidebarNotes();
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

  // 上段の行(ノートの status で絞り込んだ後)。並びはスレ一覧の順を保つ。
  const rows = useMemo(() => buildUpperRows(threads, implByThread), [threads, implByThread]);
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.thread.agentId)), [rows]);

  // グループ内のドラッグ結果を全体の並びへ戻す(他グループ・上段に出ていない行の並びはそのまま)。
  // 絞り込みで隠れている行を詰めて並べ替えると、隠れた行の順序まで動いてしまうため、
  // 画面に出ている行だけを keys で置き換える。
  const onReorderGroup = useCallback(
    (groupKey: string, keys: string[]) => {
      const queue = [...keys];
      const flat = threads.map((t) =>
        groupKeyOf(t) === groupKey && visibleIds.has(t.agentId)
          ? (queue.shift() ?? t.agentId)
          : t.agentId,
      );
      persistOrder(flat);
    },
    [persistOrder, threads, visibleIds],
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
  const groups = useMemo(() => groupRows(rows), [rows]);

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
  // 状態文字は行の背景に対して WCAG AA(4.5:1)を満たす色を選ぶ。テーマの
  // foregroundMuted が薄すぎるテーマでも読めるよう、満たさなければ foreground に落とす。
  const colors = props.theme.colors;
  const statusColor = pickReadableText(colors.foregroundMuted, colors.foreground, [
    colors.surface0,
    colors.surface1,
    colors.surface2,
  ]);

  let headerLabel: string;
  if (failed) headerLabel = `子スレ ${threads.length}件(取得失敗)`;
  else if (saveFailed) headerLabel = `子スレ ${threads.length}件(並び順を保存できません)`;
  else headerLabel = `子スレ ${threads.length}件`;

  const renderThread = useCallback(
    (row: SidebarRowView<ChildThread>) => (
      <ThreadRow
        row={row}
        failed={failed}
        active={onScreen && focusId === row.thread.agentId}
        openScreen={openScreen}
        openAgent={navigation?.openAgent}
        serverId={props.host.id}
        statusColor={statusColor}
      />
    ),
    [failed, focusId, navigation?.openAgent, onScreen, openScreen, props.host.id, statusColor],
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
          statusColor={statusColor}
        />
      ))}
      {!failed && rows.length === 0 ? (
        <SidebarRow
          id="child-threads-empty"
          icon="ListTodo"
          label="実装中のスレはありません"
          onPress={openList}
        />
      ) : null}
      {/* 下段: 進行中の構想(折りたたみ可)。スレがまだ無い構想は Obsidian でノートを開く。 */}
      <ConceptNotesSection
        notes={notes}
        error={notesError}
        openAgent={navigation?.openAgent}
        serverId={props.host.id}
        openScreen={openScreen}
        statusColor={statusColor}
      />
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

/** 印(アイコン)はノート由来の status で選ぶ。ノートの無い行はスレ側の status。 */
function rowIcon(row: SidebarRowView<ChildThread>, t: ChildThread): string {
  if (row.note?.status === "確認待ち") return "CircleCheck";
  if (row.statusLabel === "判断待ち") return "CircleHelp";
  if (row.statusLabel === "実装中" && t.status === "完了") return "Loader";
  return ICON[t.status];
}

function ThreadRow({
  row,
  failed,
  active,
  openScreen,
  openAgent,
  serverId,
  statusColor,
}: {
  row: SidebarRowView<ChildThread>;
  failed: boolean;
  active: boolean;
  openScreen: PluginSidebarItemProps["openScreen"];
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
  /** 状態文字の色(WCAG AA)。 */
  statusColor: string;
}) {
  const t = row.thread;
  // 押したらそのスレの会話(エージェント画面)を開く。navigationが無い古いホストだけ一覧画面へ退避。
  const onPress = useCallback(() => {
    if (openAgent) openAgent({ agentId: t.agentId, serverId });
    else openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: t.agentId } });
  }, [openAgent, openScreen, serverId, t.agentId]);
  const textStyle = useMemo(() => ({ color: statusColor }), [statusColor]);
  const statusText = failed ? `${row.statusLabel}(古い表示)` : row.statusLabel;
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        {/* ピン止め・アーカイブの置き場(6f957aa9 が同じ行に実装する)。状態文字がずれないよう幅を確保。 */}
        <View style={styles.actionsSlot} testID={`child-row-actions-${t.agentId}`} />
        <Text style={textStyle}>{statusText}</Text>
      </View>
    ),
    [statusText, textStyle, t.agentId],
  );
  const icon = rowIcon(row, t);
  return (
    <SidebarRow
      id={t.agentId}
      icon={icon}
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
    gap: 4,
  },
  chevron: {
    fontSize: 11,
  },
  // ピン止め・アーカイブ(6f957aa9)の置き場。今は空けておく。
  actionsSlot: {
    width: TRAILING_ACTIONS_WIDTH,
  },
  // タッチ端末でも開閉を狙えるよう当たり判定を広げる(見出し本体は司令塔を開く)。
  toggleHit: {
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
