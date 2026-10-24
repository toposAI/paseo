import { useCallback, useEffect, useState, type ReactElement } from "react";
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
import { watchBoxSignal } from "./client/change-signal";
import { setSidebarMode, useSidebarMode } from "./client/sidebar-mode";
import { SIDEBAR_SECTION_LABELS } from "./shared/sidebar-section-mode";
import { boxSignalRpc, confirmBoxCountRpc } from "./shared/contract";
import {
  BOX_TAB_MODE_PARAM,
  FOOTER_TABS,
  BOX_TAB_SCREEN_ID,
  boxTabMode,
  bugBadgeCount,
  footerTitle,
  type FooterTabId,
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
  return <SidebarRow icon="Mail" label={footerTitle("mail")} onPress={openMailUi} />;
}

/**
 * サイドバー下部のタブ(PC も iPhone も同じ並び: ユーザー判断 / 子スレ完了 / バグ報告 / スレ一覧 /
 * 構想一覧 / メールUI)。2026-10-24 ユーザー指示で「ユーザー判断」「子スレ完了」を確認箱の中から
 * 下部バーへ出し、確認箱そのものは「バグ報告」から開く形にした。
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

/**
 * 下部バーの「ユーザー判断」「子スレ完了」。`tab` は確認箱のタブの id と `?mode=` の値、
 * `footerId` は下部バーの項目 id(表示名は `FOOTER_TABS` から取る)。
 */
const BOX_TAB: Record<
  "items" | "childdone",
  { icon: string; footerId: FooterTabId; pick: (r: { open: number; childDone?: number }) => number }
> = {
  items: { icon: "CircleHelp", footerId: "judgment", pick: (r) => r.open },
  childdone: { icon: "CircleCheck", footerId: "childdone", pick: (r) => r.childDone ?? 0 },
};
type BoxTab = keyof typeof BOX_TAB;

/** 下部バーの2項目が持つ件数。確認箱のバッジと同じ回り方(30秒毎 + 変更通知)で取り直す。 */
function useBoxTabCount(tab: BoxTab): number | undefined {
  const count = useRpc(confirmBoxCountRpc);
  const signalTimes = useRpc(boxSignalRpc);
  const pick = BOX_TAB[tab].pick;
  const [n, setN] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    // 一時的な失敗では前回の件数を残す(バッジが消えると「未確認が無くなった」と読めるため)。
    const tick = () =>
      count({})
        .then((r) => alive && setN(pick(r)))
        .catch(() => {});
    void tick();
    const timer = setInterval(tick, COUNT_MS);
    const off = onBoxChanged(() => void tick());
    // 子スレの完了・取り下げの合図でも取り直す(下部バーのバッジを30秒待たせない。2026-10-24)
    const stop = watchBoxSignal(
      () => signalTimes({}),
      () => void tick(),
    );
    return () => {
      alive = false;
      clearInterval(timer);
      off();
      stop();
    };
  }, [count, pick, signalTimes]);
  return n;
}

/**
 * 下部バーの「ユーザー判断」「子スレ完了」の1行(PC も iPhone も同じ)。
 * 件数は確認箱のタブと同じ数え方(`open`=判断印つきで未承認 / `childDone`=完了かつ未確認)。
 */
function BoxTabLink({ tab, currentScreen, openScreen }: { tab: BoxTab } & BoxTabLinkProps) {
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
  return (
    <SidebarRow
      icon={BOX_TAB[tab].icon}
      label={footerTitle(BOX_TAB[tab].footerId)}
      active={active}
      onPress={press}
      trailing={trailing ?? undefined}
    />
  );
}

type BoxTabLinkProps = Pick<PluginSidebarItemProps, "currentScreen" | "openScreen">;

/** 下部バーの「バグ報告」のバッジ=未対応のバグ報告の数(通知の未読は箱の中に出す)。 */
function useBugBadge(): number | undefined {
  const count = useRpc(confirmBoxCountRpc);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      count({})
        .then((r) => alive && setN(bugBadgeCount(r)))
        // 一時的な失敗では前回の件数を残す(`BoxTabLink` と同じ)。
        .catch(() => {});
    void tick();
    const timer = setInterval(tick, COUNT_MS);
    const off = onBoxChanged(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [count]);
  return n ?? undefined;
}

/**
 * 下部バーの「バグ報告」1行。確認箱そのものを開く(中は バグ報告・通知・優先順位 の3枚)。
 * ヘッダボタン(各ワークスペースの確認箱ポップオーバー)の登録もここで行う
 * (この行は どの幅でも必ず描かれるので、登録の入口として常駐する)。
 */
function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const n = useBugBadge();
  return <SidebarWithHeaderButton currentScreen={currentScreen} openScreen={openScreen} n={n} />;
}

/**
 * ワークスペースごとの確認箱ヘッダボタンの登録と、下部バーの「バグ報告」1行。
 * 登録簿はモジュール側に置く(項目が再マウントされても取り直さず、ワークスペースの増減だけを見る)。
 * ワークスペースを1つも持たないとき(登録先が無いとき)は何も描かない。
 */
function SidebarWithHeaderButton({
  currentScreen,
  openScreen,
  n,
}: Pick<PluginSidebarItemProps, "currentScreen" | "openScreen"> & { n: number | undefined }) {
  const hosts = useHosts();
  const open = useCallback(() => openScreen({ screenId: SCREEN_ID }), [openScreen]);
  const { registered, tick } = useRegisteredHeaderButtons();

  // `useHosts()` は同じ配列を返し続ける(ホスト一覧が変わった時だけ差し替わる)ので、後から増えた
  // ワークスペースを取りに行くには tick を依存に入れる必要がある(30秒毎。1ホストにつき `workspaces.list` 1回)。
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
  }, [hosts, registered, tick]);

  const trailing = CountBadge({ n });
  return (
    <SidebarRow
      icon="Bug"
      label={footerTitle("bugs")}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={open}
      trailing={trailing ?? undefined}
    />
  );
}

/**
 * ヘッダボタンの登録簿。ワークスペースは後から増えるので、一定間隔で列挙し直す
 * (`tick` を効果の依存に入れて再実行させる。`registered` は Map なので、古い参照でも中身は最新)。
 */
function useRegisteredHeaderButtons(): { registered: typeof headerButtons; tick: number } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), COUNT_MS);
    return () => clearInterval(timer);
  }, []);
  return { registered: headerButtons, tick };
}

function Screen({ theme, navigation, layout }: PluginScreenProps) {
  return <ConfirmBoxView theme={theme} navigation={navigation} layout={layout} />;
}

/**
 * 下部バーの「ユーザー判断」「子スレ完了」から開く画面。そのタブだけを出す(並びは出さない)。
 * 画面は寄与 id でしか分かれないので、同じ画面のまま `?mode=` だけ変わっても同じ部品が使い回される。
 * タブごとに状態(絞り込み・並び)を持ち越さないよう `key` で作り直す。
 */
function BoxTabScreen({ theme, navigation, layout, params }: PluginScreenProps) {
  const mode = boxTabMode(params[BOX_TAB_MODE_PARAM]);
  return (
    <ConfirmBoxView key={mode} theme={theme} navigation={navigation} layout={layout} mode={mode} />
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

// 下部バーの各項目の中身。キーは `FOOTER_TABS` の id(並び順だけを SSOT に持たせ、中身はここで結ぶ)。
const FooterJudgment = (props: PluginSidebarItemProps) => <BoxTabLink {...props} tab="items" />;
const FooterChildDone = (props: PluginSidebarItemProps) => (
  <BoxTabLink {...props} tab="childdone" />
);
const FooterThreads = () => <SidebarSectionLink section="threads" icon="ListTree" />;
const FooterConcepts = () => <SidebarSectionLink section="concepts" icon="Lightbulb" />;

const FOOTER_COMPONENTS: Record<FooterTabId, (props: PluginSidebarItemProps) => ReactElement> = {
  judgment: FooterJudgment,
  childdone: FooterChildDone,
  bugs: Sidebar,
  "sidebar-threads": FooterThreads,
  "sidebar-concepts": FooterConcepts,
  mail: MailLink,
};

/** ヘッダボタンを外す。`contribute` 冒頭と片付けの両方から呼ぶ(登録簿を残したまま捨てると外せなくなる)。 */
function removeHeaderButtons() {
  for (const r of headerButtons.values()) r.remove();
  headerButtons.clear();
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
  // 並びは `FOOTER_TABS`(SSOT)の順で登録する。PC も iPhone も同じ6項目を出す。
  for (const tab of FOOTER_TABS) {
    ctx.addSidebarFooterItem({
      id: tab.id,
      title: tab.title,
      Component: FOOTER_COMPONENTS[tab.id],
    });
  }
  // ヘッダボタンの登録簿は下部バーの項目の寿命に合わせて消す(再マウント時に作り直す)。
  removeHeaderButtons();
  return () => {
    removeHeaderButtons();
    client = null;
  };
}
