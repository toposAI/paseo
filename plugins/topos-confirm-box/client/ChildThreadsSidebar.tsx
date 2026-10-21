/**
 * サイドバーの子スレ行。1スレ=1行(`SidebarRow id=agentId`)。題名+状態を出し、
 * 押すと子スレ一覧画面を開く(そのスレを先頭で展開)。
 *
 * 並び順はドラッグで変更でき、`child_threads_order.json` に保存される
 * (既存の `child_threads.json` は触らない)。保存が無ければサーバーの既定順。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarReorderableList, SidebarRow } from "@getpaseo/plugin/client/ui";
import { childThreadsListRpc, childThreadsSetOrderRpc } from "../shared/child-threads.js";
import type { ChildThread, ChildThreadStatus } from "../shared/child-threads.js";

const POLL_MS = 30_000;
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

export function ChildThreadsSidebar(props: PluginSidebarItemProps) {
  const { currentScreen, openScreen } = props;
  const navigation = (props as PluginSidebarItemProps & AgentNavigation).navigation;
  const list = useRpc(childThreadsListRpc);
  const setOrder = useRpc(childThreadsSetOrderRpc);
  const [threads, setThreads] = useState<ChildThread[]>([]);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
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

  const onReorder = useCallback(
    (keys: string[]) => {
      dragGateUntilRef.current = 0;
      // 先に画面へ反映し、保存は後追い。失敗したら次の取得でサーバーの順に戻る。
      setThreads((prev) => applyOrder(prev, keys));
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

  const focusId = (currentScreen?.params as { focusId?: string } | undefined)?.focusId;
  const onScreen = currentScreen?.screenId === CHILD_THREADS_SCREEN_ID;

  const openList = useCallback(
    () => openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: {} }),
    [openScreen],
  );
  const keyOf = useCallback((t: ChildThread) => t.agentId, []);
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
      <SidebarReorderableList
        testID="child-threads-list"
        data={threads}
        keyExtractor={keyOf}
        renderItem={renderThread}
        onDragBegin={onDragBegin}
        onReorder={onReorder}
      />
    </>
  );
}

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
