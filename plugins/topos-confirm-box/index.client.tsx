import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  getPaseoClient,
  useHosts,
  useRpc,
  type PluginButtonContentProps,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ConfirmBoxView } from "./client/ConfirmBoxView";
import { confirmBoxCountRpc } from "./shared/contract";

const COUNT_MS = 30_000;
const SCREEN_ID = "main";

function useOpenCount(): number | null {
  const count = useRpc(confirmBoxCountRpc);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      count({})
        .then((r) => alive && setN(r.open))
        .catch(() => alive && setN(null));
    void tick();
    const timer = setInterval(tick, COUNT_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [count]);
  return n;
}

function Screen({ theme }: PluginScreenProps) {
  return <ConfirmBoxView theme={theme} />;
}

const popoverStyle = { height: 480 };

function Popover({ theme }: PluginButtonContentProps) {
  return (
    <View style={popoverStyle}>
      <ConfirmBoxView theme={theme} />
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  // ヘッダボタンはワークスペース単位でしか登録できないため、サイドバー項目(常駐)が
  // ホストのワークスペース一覧を見て各々へ登録する。登録済みIDは重複させない。
  const registered = new Map<string, { remove(): void }>();

  function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
    const n = useOpenCount();
    const hosts = useHosts();
    const open = useCallback(() => openScreen({ screenId: SCREEN_ID }), [openScreen]);

    useEffect(() => {
      let alive = true;
      for (const host of hosts) {
        if (host.status !== "online") continue;
        getPaseoClient(host.serverId)
          .workspaces.list()
          .then((res) => {
            if (!alive) return null;
            for (const ws of res.entries ?? []) {
              const workspaceId = (ws as { id: string }).id;
              if (registered.has(workspaceId)) continue;
              registered.set(
                workspaceId,
                client.addHeaderButton({
                  id: `box-${workspaceId}`,
                  workspaceId,
                  button: {
                    title: "確認箱",
                    icon: "Inbox",
                    behavior: { kind: "popover", Content: Popover },
                  },
                }),
              );
            }
            return null;
          })
          .catch(() => {});
      }
      return () => {
        alive = false;
      };
    }, [hosts]);

    const trailing = useMemo(() => (n ? <Text>{n}</Text> : undefined), [n]);

    return (
      <SidebarRow
        icon="Inbox"
        label="確認箱"
        active={currentScreen?.screenId === SCREEN_ID}
        onPress={open}
        trailing={trailing}
      />
    );
  }

  client.addScreen({ id: SCREEN_ID, title: "確認箱", Component: Screen });
  client.addSidebarHeaderItem({ id: "box", title: "確認箱", Component: Sidebar });
  return () => {
    for (const r of registered.values()) r.remove();
    registered.clear();
  };
}
