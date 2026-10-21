/**
 * サイドバーの子スレ行。1スレ=1行(`SidebarRow id=agentId`)。題名+状態を出し、
 * 押すと子スレ一覧画面を開く(そのスレを先頭で展開)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { childThreadsListRpc } from "../shared/child-threads.js";
import type { ChildThread, ChildThreadStatus } from "../shared/child-threads.js";

const POLL_MS = 30_000;
export const CHILD_THREADS_SCREEN_ID = "child-threads";

const ICON: Record<ChildThreadStatus, string> = {
  ユーザー判断待ち: "CircleHelp",
  実装中: "Loader",
  完了: "CircleCheck",
};

export function ChildThreadsSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const list = useRpc(childThreadsListRpc);
  const [threads, setThreads] = useState<ChildThread[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      list({})
        .then((r) => {
          if (!alive) return null;
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

  const focusId = (currentScreen?.params as { focusId?: string } | undefined)?.focusId;
  const onScreen = currentScreen?.screenId === CHILD_THREADS_SCREEN_ID;

  const openList = useCallback(
    () => openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: {} }),
    [openScreen],
  );
  const headerLabel = failed
    ? `子スレ ${threads.length}件(取得失敗)`
    : `子スレ ${threads.length}件`;

  return (
    <>
      <SidebarRow
        id="child-threads-header"
        icon="ListTodo"
        label={headerLabel}
        active={onScreen && !focusId}
        onPress={openList}
      />
      {threads.map((t) => (
        <ThreadRow
          key={t.agentId}
          thread={t}
          failed={failed}
          active={onScreen && focusId === t.agentId}
          openScreen={openScreen}
        />
      ))}
    </>
  );
}

function ThreadRow({
  thread: t,
  failed,
  active,
  openScreen,
}: {
  thread: ChildThread;
  failed: boolean;
  active: boolean;
  openScreen: PluginSidebarItemProps["openScreen"];
}) {
  const onPress = useCallback(
    () => openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: t.agentId } }),
    [openScreen, t.agentId],
  );
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
