import { useCallback, useEffect, useState } from "react";
import { Linking, Text, View, type LayoutChangeEvent } from "react-native";
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
import { ChildThreadsSidebar, CHILD_THREADS_SCREEN_ID } from "./client/ChildThreadsSidebar";
import { ChildThreadsView } from "./client/ChildThreadsView";
import { ConfirmBoxView } from "./client/ConfirmBoxView";
import { onBoxChanged } from "./client/events";
import { setSidebarMode, useSidebarMode } from "./client/sidebar-mode";
import { SIDEBAR_SECTION_LABELS } from "./shared/sidebar-section-mode";
import { confirmBoxCountRpc } from "./shared/contract";
import {
  BOX_TAB_MODE_PARAM,
  BOX_TAB_SCREEN_ID,
  boxTabMode,
  confirmBoxBadgeCount,
} from "./shared/footer-tabs";

const COUNT_MS = 30_000;
const SCREEN_ID = "main";
// 110番メール整理の Compose UI(launchd com.toposai.mailtriage_compose_ui、Tailscale IP限定バインド)。
const MAIL_UI_URL = "http://100.85.224.7:8731/";

// `contribute` が受けたもの。下部バーの項目(contribute の中で登録する関数)とヘッダボタンの登録で共用。
// 画面を開く・ボタンを足す操作は `contribute` 実行後だけ呼ばれるが、型を締めるため null チェックを置く。
let client: PluginClientContext | null = null;
// ワークスペース id → 確認箱ヘッダボタンの登録(重複させない)。
const headerButtons = new Map<string, { remove(): void }>();

function openMailUi() {
  void Linking.openURL(MAIL_UI_URL);
}

function MailLink() {
  return <SidebarRow icon="Mail" label="メール" onPress={openMailUi} />;
}

/**
 * サイドバー下部のタブ(PC幅の並び: ユーザー判断 / 子スレ完了 / 確認箱 / メール / スレ一覧 / 構想一覧)。
 * 2026-10-24 ユーザー指示で「ユーザー判断」「子スレ完了」を確認箱の中から下部バーへ出した。
 * バーの項目はアイコンだけが出るので、`label` は読み上げ用(と設定画面の項目名)になる。
 */
function SidebarSectionLink({ section, icon }: { section: "threads" | "concepts"; icon: string }) {
  const mode = useSidebarMode();
  const press = useCallback(() => setSidebarMode(section), [section]);
  return (
    <SidebarRow
      icon={icon}
      label={SIDEBAR_SECTION_LABELS[section]}
      active={mode === section}
      onPress={press}
    />
  );
}

const badgeText = { color: "#ffffff", fontSize: 10, fontWeight: "700" as const };

/** 件数そのままのバッジ。0/取得前は出さない(既存の確認箱バッジと同じ)。 */
function CountBadge({ n }: { n: number | undefined }) {
  if (!n) return null;
  return <Text style={badgeText}>{n > 99 ? "99+" : n}</Text>;
}

/** 下部バーの「ユーザー判断」「子スレ完了」の id(= 確認箱のタブと `?mode=` の値)。 */
type BoxTab = "items" | "childdone";

const BOX_TAB: Record<BoxTab, { icon: string; label: string }> = {
  items: { icon: "CircleHelp", label: "ユーザー判断" },
  childdone: { icon: "CircleCheck", label: "子スレ完了" },
};

/** 下部バーの2項目が持つ件数。確認箱のバッジと同じ回り方(30秒毎 + 変更通知)で取り直す。 */
function useBoxTabCount(tab: BoxTab): number | undefined {
  const count = useRpc(confirmBoxCountRpc);
  const [n, setN] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      count({})
        .then((r) => alive && setN(tab === "items" ? r.open : r.childDone))
        .catch(() => alive && setN(undefined));
    void tick();
    const timer = setInterval(tick, COUNT_MS);
    const off = onBoxChanged(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [count, tab]);
  return n;
}

/**
 * 下部バーの「ユーザー判断」「子スレ完了」。PC幅だけ出す(狭い幅は確認箱の中のタブのまま=従来どおり)。
 * 件数は確認箱のタブと同じ数え方(`open`=判断印つきで未承認 / `childDone`=完了かつ未確認)。
 */
function BoxTabLink({
  tab,
  currentScreen,
  openScreen,
  layout,
}: { tab: BoxTab } & Pick<PluginSidebarItemProps, "currentScreen" | "openScreen" | "layout">) {
  const n = useBoxTabCount(tab);
  const press = useCallback(
    () => openScreen({ screenId: BOX_TAB_SCREEN_ID, params: { [BOX_TAB_MODE_PARAM]: tab } }),
    [openScreen, tab],
  );
  const active =
    currentScreen?.screenId === BOX_TAB_SCREEN_ID &&
    currentScreen.params[BOX_TAB_MODE_PARAM] === tab;
  // jsx を prop に渡すと lint(react-perf)に当たるので、要素は一度だけ作る。
  const trailing = CountBadge({ n });
  if (layout.compact) return null;
  return (
    <SidebarRow
      icon={BOX_TAB[tab].icon}
      label={BOX_TAB[tab].label}
      active={active}
      onPress={press}
      trailing={trailing ?? undefined}
    />
  );
}

/**
 * 下部バーの「確認箱」のバッジ。PC幅は中に残る項目(バグ報告+通知)の合計、狭い幅は従来どおり判断待ちの数
 * (狭い幅では「ユーザー判断」をバーに出さないので、二重にならず1か所で数える)。
 */
function useBoxBadge(compact: boolean): number | undefined {
  const count = useRpc(confirmBoxCountRpc);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      count({})
        .then(
          (r) =>
            alive &&
            setN(
              compact ? r.open : confirmBoxBadgeCount({ bugs: r.bugs, notify: r.notifications }),
            ),
        )
        .catch(() => alive && setN(null));
    void tick();
    const timer = setInterval(tick, COUNT_MS);
    const off = onBoxChanged(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [count, compact]);
  return n ?? undefined;
}

function Sidebar({ currentScreen, openScreen, layout }: PluginSidebarItemProps) {
  const n = useBoxBadge(layout.compact);
  return <SidebarWithHeaderButton currentScreen={currentScreen} openScreen={openScreen} n={n} />;
}

/**
 * ワークスペースごとの確認箱ヘッダボタンの登録と、下部バーの「確認箱」1行。
 * 登録簿はモジュール側に置く(項目が再マウントされても取り直さず、ワークスペースの増減だけを見る)。
 */
function SidebarWithHeaderButton({
  currentScreen,
  openScreen,
  n,
}: Pick<PluginSidebarItemProps, "currentScreen" | "openScreen"> & { n: number | undefined }) {
  const hosts = useHosts();
  const open = useCallback(() => openScreen({ screenId: SCREEN_ID }), [openScreen]);
  const registered = useRegisteredHeaderButtons();

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
            if (registered.has(workspaceId) || !client) continue;
            registered.set(
              workspaceId,
              client.addHeaderButton({
                id: "box",
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
  }, [hosts, registered]);

  const trailing = CountBadge({ n });
  return (
    <SidebarRow
      icon="Inbox"
      label="確認箱"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={open}
      trailing={trailing ?? undefined}
    />
  );
}

/** ヘッダボタンの登録簿。ワークスペースは後から増えるので、一定間隔で列挙し直す。 */
function useRegisteredHeaderButtons() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), COUNT_MS);
    return () => clearInterval(timer);
  }, []);
  return headerButtons;
}

function Screen({ theme, navigation }: PluginScreenProps) {
  return <ConfirmBoxView theme={theme} navigation={navigation} />;
}

/** 下部バーの「ユーザー判断」「子スレ完了」から開く画面。そのタブを出し、下の並びで確認箱の中へ移れる。 */
function BoxTabScreen({ theme, navigation, params }: PluginScreenProps) {
  return (
    <ConfirmBoxView
      theme={theme}
      navigation={navigation}
      mode={boxTabMode(params[BOX_TAB_MODE_PARAM])}
    />
  );
}

function ChildThreadsScreen({ theme, params }: PluginScreenProps) {
  const focusId = params.focusId ?? null;
  return <ChildThreadsView theme={theme} focusId={focusId} />;
}

// ホストのポップオーバー面は maxHeight 440 で、超えた分は中でスクロールになる。
// チャットペインは下端に入力欄を置くので、箱からはみ出させない(440 に収める)。
const popoverStyle = { height: 420 };

/**
 * ポップオーバーは最大420pxの箱に収まる(ホスト側 `PluginPopoverContent` の maxWidth)。
 * ペインの出し分けは**窓幅ではなく箱の幅**で決める必要があるので、自分の幅を測って渡す
 * (窓が広いPCでもポップオーバーは狭いため、窓幅で判定すると一覧とチャットが同じ箱に
 * 押し込まれて潰れる)。
 */
function Popover({ theme }: PluginButtonContentProps) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)),
    [],
  );
  return (
    <View style={popoverStyle} onLayout={onLayout}>
      <ConfirmBoxView theme={theme} containerWidth={width || undefined} />
    </View>
  );
}

export default function contribute(ctx: PluginClientContext) {
  client = ctx;
  // ヘッダボタンはワークスペース単位でしか登録できないため、サイドバー項目(常駐)が
  // ホストのワークスペース一覧を見て各々へ登録する(`useRegisteredHeaderButtons` が登録簿を持つ)。

  ctx.addScreen({ id: CHILD_THREADS_SCREEN_ID, title: "子スレ", Component: ChildThreadsScreen });
  ctx.addSidebarHeaderItem({
    id: "child-threads",
    title: "子スレ",
    Component: ChildThreadsSidebar,
  });
  ctx.addScreen({ id: SCREEN_ID, title: "確認箱", Component: Screen });
  ctx.addScreen({ id: BOX_TAB_SCREEN_ID, title: "確認箱", Component: BoxTabScreen });
  // 並びは登録順(ユーザー判断 → 子スレ完了 → 確認箱 → メール → スレ一覧 → 構想一覧)。
  // 先頭2つは PC幅だけその場で描画する(狭い幅では何も出さない=iPhone のバーは従来どおり)。
  ctx.addSidebarFooterItem({
    id: "judgment",
    title: BOX_TAB.items.label,
    Component: (props) => <BoxTabLink {...props} tab="items" />,
  });
  ctx.addSidebarFooterItem({
    id: "childdone",
    title: BOX_TAB.childdone.label,
    Component: (props) => <BoxTabLink {...props} tab="childdone" />,
  });
  ctx.addSidebarFooterItem({ id: "box", title: "確認箱", Component: Sidebar });
  ctx.addSidebarFooterItem({ id: "mail", title: "メール", Component: MailLink });
  ctx.addSidebarFooterItem({
    id: "sidebar-threads",
    title: SIDEBAR_SECTION_LABELS.threads,
    Component: () => <SidebarSectionLink section="threads" icon="ListTree" />,
  });
  ctx.addSidebarFooterItem({
    id: "sidebar-concepts",
    title: SIDEBAR_SECTION_LABELS.concepts,
    Component: () => <SidebarSectionLink section="concepts" icon="Lightbulb" />,
  });
  // ヘッダボタンの登録簿は下部バーの項目の寿命に合わせて消す(再マウント時に作り直す)。
  headerButtons.clear();
  return () => {
    for (const r of headerButtons.values()) r.remove();
    headerButtons.clear();
    client = null;
  };
}
