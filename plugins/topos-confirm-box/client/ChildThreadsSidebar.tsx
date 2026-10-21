/**
 * サイドバーの子スレ行。1スレ=1行(`SidebarRow id=agentId`)。題名+状態を出し、
 * 押すと子スレ一覧画面を開く(そのスレを先頭で展開)。
 */
import { useEffect, useState } from "react";
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

  useEffect(() => {
    let alive = true;
    const tick = () =>
      list({})
        .then((r) => alive && setThreads(r.threads))
        .catch(() => {});
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [list]);

  return (
    <>
      {threads.map((t) => (
        <SidebarRow
          key={t.agentId}
          id={t.agentId}
          icon={ICON[t.status]}
          label={t.title}
          active={currentScreen?.screenId === CHILD_THREADS_SCREEN_ID}
          onPress={() =>
            openScreen({ screenId: CHILD_THREADS_SCREEN_ID, params: { focusId: t.agentId } })
          }
          trailing={<Text>{t.status}</Text>}
        />
      ))}
    </>
  );
}
