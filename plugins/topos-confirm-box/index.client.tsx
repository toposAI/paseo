import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Linking, Text, View, type LayoutChangeEvent } from "react-native";
import {
  getPaseoClient,
  useHosts,
  useRpc,
  type PluginButtonContentProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { ChildThreadsSidebar, CHILD_THREADS_SCREEN_ID } from "./client/ChildThreadsSidebar";
import { ChildThreadsView } from "./client/ChildThreadsView";
import { ConceptNoteView } from "./client/ConceptNoteView";
import { NOTE_VIEW_SCREEN_ID } from "./shared/note-view";
import {
  SHARED_PROJECT_SCREEN_ID,
  SharedProjectView,
  useSharedUnread,
} from "./client/SharedProjects";
import { ConfirmBoxView } from "./client/ConfirmBoxView";
import {
  TASK_LEDGER_PANEL_ID,
  TASK_LEDGER_SCREEN_ID,
  TaskLedgerPanel,
  TaskLedgerScreen,
  WINDOW_B_AGENT_ID,
} from "./client/TaskLedgerView";
import {
  WINDOWB_PANEL_ID,
  WINDOWB_PANEL_TITLE,
  WindowBInstructionsPanel,
  openWindowBInstructions,
} from "./client/WindowBInstructions";
import { onBoxChanged } from "./client/events";
import { watchBoxSignal } from "./client/change-signal";
import { setSidebarMode, useSidebarMode } from "./client/sidebar-mode";
import { setScreenOpener } from "./client/screens";
import { SIDEBAR_SECTION_LABELS } from "./shared/sidebar-section-mode";
import { boxSignalRpc, confirmBoxCountRpc } from "./shared/contract";
import {
  FOOTER_TABS,
  BOX_TAB_SCREEN_ID,
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
// ワークスペース id → 「ぼくの指示」ヘッダボタンの登録(`headerButtons` の登録と寿命を揃える)。
const windowBHeaderButtons = new Map<string, { remove(): void }>();

function openMailUi() {
  void Linking.openURL(MAIL_UI_URL);
}

function MailLink() {
  return <SidebarRow icon="Mail" label={footerTitle("mail")} onPress={openMailUi} />;
}

/**
 * サイドバー下部のタブ(PC も iPhone も同じ並び: ユーザー判断 / バグ報告 / スレ一覧 /
 * 構想一覧 / メールUI)。2026-10-24 ユーザー指示で「ユーザー判断」を確認箱の中から
 * 下部バーへ出し、確認箱そのものは「バグ報告」から開く形にした。
 * 2026-10-26 ユーザー指示で「子スレ完了」を撤去した(完了報告は完了箱Cへ一本化)。
 * バーの項目はアイコンだけが出るので、`label` は読み上げ用(と設定画面の項目名)になる。
 */
function SidebarSectionLink({
  section,
  icon,
  trailing,
}: {
  section: "threads" | "concepts" | "projects";
  icon: string;
  trailing?: ReactElement;
}) {
  const mode = useSidebarMode();
  const press = useCallback(() => setSidebarMode(section), [section]);
  return (
    <SidebarRow
      icon={icon}
      label={SIDEBAR_SECTION_LABELS[section]}
      active={mode === section}
      onPress={press}
      trailing={trailing}
    />
  );
}

const badgeText = { color: "#ffffff", fontSize: 10, fontWeight: "700" as const };

/** 件数そのままのバッジ。0/取得前は出さない(既存の確認箱バッジと同じ)。
 * `unknown`(数え切れていない)は件数の代わりに「!」を出す(0 件と読ませない)。 */
function CountBadge({ n, unknown = false }: { n: number | undefined; unknown?: boolean }) {
  if (unknown) return <Text style={badgeText}>!</Text>;
  if (!n) return null;
  return <Text style={badgeText}>{n > 99 ? "99+" : n}</Text>;
}

/**
 * 下部バーの「ユーザー判断」1行の件数。確認箱のバッジと同じ回り方(30秒毎 + 変更通知)で取り直す。
 * 「子スレ完了」のバッジは 2026-10-26 に撤去した(完了報告は完了箱Cへ一本化)。
 */
function useJudgmentBadge(): { n: number | undefined; unknown: boolean } {
  const count = useRpc(confirmBoxCountRpc);
  const signalTimes = useRpc(boxSignalRpc);
  const [n, setN] = useState<number | undefined>(undefined);
  const [unknown, setUnknown] = useState(false);
  useEffect(() => {
    let alive = true;
    // 一時的な失敗では前回の件数を残す(バッジが消えると「未確認が無くなった」と読めるため)。
    // 数字は **窓口Aがいま出せる件数**(`presentable`)。判定は判断窓口の Python 1か所だけで、
    // ここでは数え直さない(確認箱の open 総数を出すと、窓口が出さない件まで数えて「バッジ2件なのに
    // 窓口Aは出せるものがない」が起きた。2026-10-28 ユーザー「そしたらバッジださないでよ」)。
    // 0 のときは `CountBadge` が何も出さない。null(数えられない)は「!」で 0 件と区別する。
    const tick = () =>
      count({})
        .then((r) => {
          if (!alive) return null;
          setUnknown(r.presentable === null);
          setN(r.presentable ?? undefined);
          return null;
        })
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
  }, [count, signalTimes]);
  return { n, unknown };
}

/**
 * 下部バーの「ユーザー判断」の1行(PC も iPhone も同じ)。
 * 件数は**窓口Aがいま出せる件数**(`presentable`。判定は判断窓口の Python 1か所)。0 件なら出さない。
 */
function BoxTabLink({ currentScreen, openScreen }: BoxTabLinkProps) {
  const badge = useJudgmentBadge();
  // 押しても数字を取る(RPC)ことはしない。押下で件を先取りすると窓口Aの台帳を書き、窓口Aが既に
  // 抱えている件の期限を縮めてしまう(claim_next は抱えた件の期限を上書きする)。バッジの数字は
  // 1/0 なので先取りの利点も無い。画面を開くだけにし、実際に出す1件は窓口Aが選ぶ(2026-10-29 出口レビュー1巡目)。
  const press = useCallback(() => {
    openScreen({ screenId: BOX_TAB_SCREEN_ID });
  }, [openScreen]);
  const active = currentScreen?.screenId === BOX_TAB_SCREEN_ID;
  // jsx を prop に渡すと lint(react-perf)に当たるので、要素は一度だけ作る。
  const trailing = CountBadge({ n: badge.n, unknown: badge.unknown });
  return (
    <SidebarRow
      icon="CircleHelp"
      label={footerTitle("judgment")}
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
  const toast = useToast();
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
            const c = client;
            registered.set(
              workspaceId,
              c.addHeaderButton({
                id: "box",
                workspaceId,
                button: {
                  title: "確認箱",
                  icon: "Inbox",
                  behavior: { kind: "popover", Content: Popover },
                },
              }),
            );
            // 窓口Bの右側の「タスク台帳」。押すと右の欄に台帳の面板が出る(2026-10-28 ユーザー指示)。
            // 窓口Bのスレを開いている間だけ出す(`visible` を書き換えて出し分ける)。
            const ledger = c.addHeaderButton({
              id: TASK_LEDGER_HEADER_ID,
              workspaceId,
              button: {
                title: "タスク台帳",
                icon: "ClipboardList",
                visible: false,
                behavior: { kind: "action", onPress: () => openTaskLedgerPanel(c, workspaceId) },
              },
            });
            ledgerButtons.set(workspaceId, ledger);
            // 窓口Bの右側の「ぼくの指示」(2026-10-30)。PC はこのボタンで右カラムを開く(いまは常時表示ではない)、
            // iPhone は同じボタンで全画面に開く(戻ると会話に戻る)。
            windowBHeaderButtons.set(
              workspaceId,
              client.addHeaderButton({
                id: "windowb-instructions",
                workspaceId,
                button: {
                  title: "指示",
                  icon: "ListChecks",
                  behavior: {
                    kind: "action",
                    onPress: () => {
                      if (!client) return;
                      const openPanel = client.openPanel.bind(client);
                      openWindowBInstructions(
                        (id, options) => openPanel(id, { workspaceId, location: options.location }),
                        workspaceId,
                        // 開けなかったとき、押したのに何も起きない状態を残さない
                        () =>
                          toast.show("「ぼくの指示」を開けませんでした", { variant: "warning" }),
                      );
                    },
                  },
                },
              }),
            );
          }
          return null;
        })
        .catch(() => {});
    }
    void refreshWindowBWorkspace(hosts);
    return () => {
      alive = false;
    };
  }, [hosts, registered, tick, toast]);

  // 窓口Bのスレがどのワークスペースにあるか(/ が無ければ null)が分かったら、そのワークスペースの
  // ヘッダにだけ台帳のボタンを出す。他のワークスペースでも、台帳の面板を右の欄に出していれば出す。
  // `windowBWorkspaceId` はモジュール側の変数(React の値ではない)なので依存には入れず、30秒ごとの
  // `tick` と、ワークスペースが増えたときの再実行で見直す。
  useEffect(() => {
    for (const [workspaceId, reg] of ledgerButtons) {
      reg.update({ visible: workspaceId === windowBWorkspaceId });
    }
  }, [tick]);

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

/** 確認箱の最上部のアイコン列が画面を切り替えるための入口(`contribute` が受けた ctx 経由)。 */
function openBoxScreen(input: { screenId: string; params?: Record<string, string> }) {
  client?.openScreen(input);
}

/**
 * スレを、ホストの画面遷移の受け口(`navigation.openAgent`)で開く関数。確認箱の「スレを開く」は
 * 右カラムの配置(`placement`)を自分で選ぶので、`navigation` そのものではなくこの関数を受け取る。
 * スクリーン(全画面)と「ユーザー判断」の両方で同じものを使う。
 */
function useOpenAgent(
  navigation: PluginScreenProps["navigation"],
): ((input: { agentId: string; placement?: "right" }) => Promise<void>) | undefined {
  return useMemo(
    () =>
      navigation
        ? async (input: { agentId: string; placement?: "right" }) => {
            navigation.openAgent(input);
          }
        : undefined,
    [navigation],
  );
}

/** 確認箱の `?tab=`。不正な値はバグ報告に倒す(下部バーから開いたときの既定)。 */
function boxInitialTab(param: string | undefined): "bugs" | "notify" | "priority" {
  return param === "notify" || param === "priority" ? param : "bugs";
}

function Screen({ theme, navigation, layout, params }: PluginScreenProps) {
  const tab = boxInitialTab(params.tab);
  const openAgent = useOpenAgent(navigation);
  return (
    <ConfirmBoxView
      key={tab}
      theme={theme}
      openAgent={openAgent}
      layout={layout}
      openScreen={openBoxScreen}
      initialTab={tab}
    />
  );
}

/**
 * 下部バーの「ユーザー判断」から開く画面。そのタブだけを出す(並びは出さない)。
 * タブごとに状態(絞り込み・並び)を持ち越さないよう `key` で作り直す。
 */
function BoxTabScreen({ theme, navigation, layout, params }: PluginScreenProps) {
  const openAgent = useOpenAgent(navigation);
  // `tab=priority` で開かれたら（タスク台帳の行の開発プロジェクトから）優先順位のタブだけを出す。
  const tab = params.tab === "priority" ? "priority" : "items";
  return (
    <ConfirmBoxView
      key={tab}
      theme={theme}
      openAgent={openAgent}
      layout={layout}
      mode={tab}
      openScreen={openBoxScreen}
    />
  );
}

function ChildThreadsScreen({ theme, params }: PluginScreenProps) {
  const focusId = params.focusId ?? null;
  return <ChildThreadsView theme={theme} focusId={focusId} />;
}

function ConceptNoteScreen({ theme, params, navigation, host }: PluginScreenProps) {
  return (
    <ConceptNoteView
      theme={theme}
      path={params.path ?? null}
      openScreen={openBoxScreen}
      openAgent={navigation?.openAgent}
      serverId={host.id}
    />
  );
}

function SharedProjectScreen({ theme, params }: PluginScreenProps) {
  return (
    <SharedProjectView
      theme={theme}
      projectId={params.id ?? null}
      title={params.name ?? ""}
      openScreen={openBoxScreen}
      screenId={SHARED_PROJECT_SCREEN_ID}
    />
  );
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
const FooterJudgment = (props: PluginSidebarItemProps) => <BoxTabLink {...props} />;
const FooterThreads = () => <SidebarSectionLink section="threads" icon="ListTree" />;
const FooterConcepts = () => <SidebarSectionLink section="concepts" icon="Lightbulb" />;
// 共有プロジェクトの未読合計をバッジに出す(参加中のものだけ。設定が無いときは出さない)。
function FooterProjects() {
  const n = useSharedUnread();
  const trailing = CountBadge({ n });
  return <SidebarSectionLink section="projects" icon="Users" trailing={trailing ?? undefined} />;
}

const FOOTER_COMPONENTS: Record<FooterTabId, (props: PluginSidebarItemProps) => ReactElement> = {
  judgment: FooterJudgment,
  bugs: Sidebar,
  "sidebar-threads": FooterThreads,
  "sidebar-concepts": FooterConcepts,
  "sidebar-projects": FooterProjects,
  mail: MailLink,
};

// ---------------------------------------------------------------- タスク台帳(窓口Bの右側)
// 窓口Bのスレ(固定ID)のワークスペースを10秒ごとに探し直す。見つかったらそのワークスペースのヘッダに
// 「タスク台帳」ボタンを出し、押すと右の欄(`explorer`)に台帳の面板を開く。狭い画面では幕
// (右端から左へスワイプして出る欄)がその面板を出したまま開く(Paseo 本体 `navigation.ts`)。
const TASK_LEDGER_HEADER_ID = "task-ledger";
const ledgerButtons = new Map<string, PluginButtonRegistration>();
let windowBWorkspaceId: string | null = null;
let shownWindowBWorkspace: string | null = null;

function openTaskLedgerPanel(c: PluginClientContext, workspaceId: string) {
  try {
    // パネルはワークスペースのものなので agentId は渡さない(窓口Bのスレが閉じていても開ける)。
    // 狭い画面の幕(スワイプで出る右の欄)は、ホスト側の `navigateToWorkspace` が開く。
    c.openPanel(TASK_LEDGER_PANEL_ID, { workspaceId, location: "explorer" });
  } catch {
    // 右の欄を作れない画面(古いホスト・狭すぎる画面)では全画面の画面で出す。
    c.openScreen({ screenId: TASK_LEDGER_SCREEN_ID });
  }
}

const WINDOW_B_LOOKUP_MS = 10_000;
let windowBLookupAt = 0;

/**
 * 窓口Bのスレのワークスペースを探す(見つかったらそのボタンを出す)。30秒ごとの巡回から呼ばれるが、
 * スレ一覧の取得は重いので、前回から `WINDOW_B_LOOKUP_MS` 経っていなければ何もしない。
 * 分からないままなら、30秒ごとに1回だけ取り直す。
 */
async function refreshWindowBWorkspace(hosts: ReturnType<typeof useHosts>): Promise<void> {
  const now = Date.now();
  if (shownWindowBWorkspace && ledgerButtons.has(shownWindowBWorkspace)) return;
  if (now - windowBLookupAt < WINDOW_B_LOOKUP_MS) return;
  windowBLookupAt = now;
  for (const host of hosts) {
    if (host.status !== "online") continue;
    const c = getPaseoClient(host.serverId);
    try {
      const res = await c.agents.list({ scope: "active", includeBackground: true });
      // 1件は `{ agent, project }` の入れ子(スレの本体は `agent`)。
      const entry = res.entries.find((e) =>
        String((e as { agent?: { id?: string } }).agent?.id ?? "")
          .toLowerCase()
          .startsWith(WINDOW_B_AGENT_ID.slice(0, 8)),
      ) as { agent?: { workspaceId?: string } } | undefined;
      const workspaceId = entry?.agent?.workspaceId;
      if (!workspaceId) continue;
      windowBWorkspaceId = workspaceId;
      const reg = ledgerButtons.get(workspaceId);
      if (reg && shownWindowBWorkspace !== workspaceId) {
        reg.update({ visible: true });
        shownWindowBWorkspace = workspaceId;
      }
      return;
    } catch {
      // 次の巡回で取り直す。
    }
  }
}

/** ヘッダボタンを外す。`contribute` 冒頭と片付けの両方から呼ぶ(登録簿を残したまま捨てると外せなくなる)。 */
function removeHeaderButtons() {
  for (const r of headerButtons.values()) r.remove();
  headerButtons.clear();
  for (const r of ledgerButtons.values()) r.remove();
  ledgerButtons.clear();
  windowBWorkspaceId = null;
  shownWindowBWorkspace = null;
  for (const r of windowBHeaderButtons.values()) r.remove();
  windowBHeaderButtons.clear();
}

export default function contribute(ctx: PluginClientContext) {
  client = ctx;
  // 面板・行からも画面を開けるように、画面を開く入口を預けておく(タスク台帳の行の開発プロジェクト→
  // 優先順位の画面)。`contribute` より前に描かれることはない(プラグインの読み込み時に1度だけ呼ばれる)。
  setScreenOpener(openBoxScreen);
  // ヘッダボタンはワークスペース単位でしか登録できないため、サイドバー項目(常駐)が
  // ホストのワークスペース一覧を見て各々へ登録する(`useRegisteredHeaderButtons` が登録簿を持つ)。

  ctx.addScreen({ id: CHILD_THREADS_SCREEN_ID, title: "子スレ", Component: ChildThreadsScreen });
  ctx.addSidebarHeaderItem({
    id: "child-threads",
    title: "子スレ",
    Component: ChildThreadsSidebar,
  });
  ctx.addScreen({
    id: SHARED_PROJECT_SCREEN_ID,
    title: "共有プロジェクト",
    Component: SharedProjectScreen,
  });
  ctx.addScreen({ id: NOTE_VIEW_SCREEN_ID, title: "構想ノート", Component: ConceptNoteScreen });
  ctx.addScreen({ id: SCREEN_ID, title: "確認箱", Component: Screen });
  ctx.addScreen({ id: BOX_TAB_SCREEN_ID, title: "確認箱", Component: BoxTabScreen });
  // 窓口Bの右側の「タスク台帳」(2026-10-28 ユーザー指示)。面板は右の欄に出し、
  // 全画面の画面は右の欄を作れないときの落ち先。
  ctx.addWorkspacePanel({
    id: TASK_LEDGER_PANEL_ID,
    title: "タスク台帳",
    icon: "ClipboardList",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: TaskLedgerPanel,
  });
  ctx.addScreen({ id: TASK_LEDGER_SCREEN_ID, title: "タスク台帳", Component: TaskLedgerScreen });
  // 並びは `FOOTER_TABS`(SSOT)の順で登録する。PC も iPhone も同じ5項目を出す。
  for (const tab of FOOTER_TABS) {
    ctx.addSidebarFooterItem({
      id: tab.id,
      title: tab.title,
      Component: FOOTER_COMPONENTS[tab.id],
    });
  }
  // 窓口Bの右側の「ぼくの指示」の一覧(2026-10-30)。中身は Python 1か所が組み立てる読み取り専用の面。
  // 右カラム(`right`)と主ペイン(`workspace`)の両方に置けるようにする: PC は右、iPhone は全画面。
  // ワークスペース単位のパネルとして登録する(中身は窓口Bが開いているかに関係なく同じ一覧なので、
  // コマンドセンター・ヘッダボタンというワークスペース単位の入口から素直に開ける)。
  ctx.addWorkspacePanel({
    id: WINDOWB_PANEL_ID,
    title: WINDOWB_PANEL_TITLE,
    icon: "ListChecks",
    context: "workspace",
    locations: ["workspace", "right"],
    Component: WindowBInstructionsPanel,
  });
  // ヘッダボタンの登録簿は下部バーの項目の寿命に合わせて消す(再マウント時に作り直す)。
  removeHeaderButtons();
  return () => {
    removeHeaderButtons();
    client = null;
  };
}
