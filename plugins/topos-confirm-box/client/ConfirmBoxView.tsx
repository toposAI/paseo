/**
 * 統合確認箱の画面本体。全画面(サイドバーから)とヘッダボタンのポップオーバーで共用する。
 *
 * v1: 一覧(優先度順)・展開・背景の4段階開示・選択して決定を記録・Paseo承認待ちへの応答。
 * 決定の記録は押した時だけ(自動では何も決めない)。
 * カードごとの会話は 💬 から開く専用ペイン(CardChatPane)に一本化した(旧・カード内の自由記述欄は廃止)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { useHosts, useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  REJECT_CHOICE,
  canRejectItem,
  confirmBoxCountRpc,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
  countOpen,
  judgmentTabRows,
  rejectComment,
} from "../shared/contract.js";
import { confirmBoxTabs, isWideLayout } from "../shared/footer-tabs.js";
import { LIST_GRID_GAP, listCellWidth, listColumns } from "../shared/list-grid.js";
import { onBoxChanged, notifyBoxChanged } from "./events.js";
import { PriorityView } from "./PriorityView.js";
import { BugReportsView } from "./BugReportsView.js";
import {
  HeaderIconBar,
  type HeaderTabId,
  type HeaderToggle,
  type ToggleInfo,
} from "./HeaderIconBar.js";
import { NotificationsView } from "./NotificationsView.js";
import { BellIcon, BugIcon, InboxIcon, ListIcon } from "./Icons.js";
import { ChatDock, PRIORITY_CHAT_AGENT_ID } from "./ChatDock.js";
import { CardChatPane } from "./CardChatPane.js";
import { openThreadInPane } from "./open-pane-thread.js";
import type { OpenThreadContext } from "./open-pane-thread.js";
import { resolveOpenThreadId } from "./thread-target.js";
import { useCoordinatorTargets } from "./useCoordinatorTargets.js";
import { shouldSwitchPaneOnCardPress } from "../shared/card-pane.js";
import { useCardPaneRoute } from "./useCardPaneRoute.js";
import { useConfirmBoxPane } from "./useConfirmBoxPane.js";
import { QuestionAnswer } from "./QuestionAnswer.js";
import type { QuestionAnswerColors } from "./QuestionAnswer.js";
import type {
  ConfirmBoxDepth,
  ConfirmBoxItem,
  ConfirmBoxListOutput,
  ConfirmBoxPriority,
} from "../shared/contract.js";

const REFRESH_MS = 30_000;

export function ConfirmBoxView({
  theme,
  openAgent,
  containerWidth,
  mode = "box",
  layout,
  openScreen,
  initialTab,
}: Pick<PluginHostProps, "theme"> & {
  /** 渡されたら最上部に5画面のアイコン列+更新ボタンを出す(全画面のとき。ポップオーバーは渡さない)。 */
  openScreen?: (input: { screenId: string; params?: Record<string, string> }) => void;
  /** 確認箱そのもの(`box`)を開いたときの最初のタブ。 */
  initialTab?: "bugs" | "notify" | "priority";
  /** ホストの `layout`。省略時(ポップオーバー)は幅・高さだけで判定する。 */
  layout?: PluginHostProps["layout"];
  /**
   * スレを開く関数(ホストの `navigation.openAgent`。`placement: "right"` で右カラム)。
   * 全画面・「ユーザー判断」の画面では渡され、ポップオーバーでは渡されない(=「スレを開く」を出さない)。
   */
  openAgent?: (input: { agentId: string; placement?: "right" }) => Promise<void>;
  /** 描画先の箱の幅。省略時は窓幅。ポップオーバーは窓が広くても箱が狭いので実測値を渡す。 */
  containerWidth?: number;
  /**
   * 開き方。`box`=確認箱そのもの(下部バー:「バグ報告」等から開く。中は バグ報告・通知・優先順位 の3枚)、
   * `items`=下部バーの「ユーザー判断」から開いた画面(そのタブだけ)。
   */
  mode?: "box" | "items";
}) {
  const list = useRpc(confirmBoxListRpc);
  const decide = useRpc(confirmBoxDecideRpc);
  const permit = useRpc(confirmBoxPermitRpc);
  const [data, setData] = useState<ConfirmBoxListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [depth, setDepth] = useState<ConfirmBoxDepth>("list");
  const [notice, setNotice] = useState<string>("");
  const counts = useBadgeCounts();
  const [prio, setPrio] = useState<string>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortNew, setSortNew] = useState(false);
  const [showDone, setShowDone] = useState(false);
  // 判断印(`judgment: true`)の無い旧形式(選択肢つき)は既定では出さない。押した時だけ並べる。
  const [legacyOff, setLegacyOff] = useState(true);

  const lastOpen = useRef<number | null>(null);
  const reload = useCallback(async () => {
    try {
      const next = await list({});
      setData(next);
      setError(null);
      // 一覧とバッジは別の取得なので、30秒の周期次第で数がずれて見える(2026-10-26 20対18の報告)。
      // 一覧の未決数が前回から変わったら、バッジ側も同時に取り直して揃える。
      const open = countOpen(next.items);
      if (lastOpen.current !== null && lastOpen.current !== open) notifyBoxChanged();
      lastOpen.current = open;
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // 手動の更新。取れた時だけバッジ(件数)も取り直す(カードとバッジが同じ時点になる)
  const manualReload = useCallback(async () => {
    const ok = await reload();
    if (ok) notifyBoxChanged();
    return ok;
  }, [reload]);

  const c = theme.colors;
  // 開くスレの一覧を引く先のホスト(直接開いた画面は navigation を受け取らないので自前で探す)。
  const hosts = useHosts();
  // タッチ幅(iPhone等)ではタップ領域を44pt以上・間隔8pxに広げる。PC幅は従来の大きさ。
  const windowSize = useWindowDimensions();
  // 幅の判定は「描画されている箱」基準。ポップオーバーは窓が広くても箱は最大420pxなので、
  // 窓幅で判定すると一覧とチャットペインが同じ狭い箱に横並びで押し込まれる。
  const width = layoutWidth(containerWidth, windowSize.width);
  const touch = width < 600;
  // 「ユーザー判断」は下部バーへ出した。「子スレ完了」は 2026-10-26 に撤去したので、確認箱の中は
  // PC も iPhone も3枚(バグ報告・通知・優先順位)。下部バーから開いた画面はそのタブだけ。
  // 幅の判定は一覧とチャットの並べ方にだけ使う(PC幅なら横並び、狭い幅は全画面で重ねる)。
  const wide = isBoxWide(containerWidth, windowSize, layout);
  const compact = !wide;
  // 判断一覧の幅。PC幅ではカードを複数列に並べる(右ペインが開いて一覧が狭くなったら列も減らす)。
  // 列数は箱幅ではなく一覧の実測幅で決めるので、ポップオーバー(箱幅あり)でもそのまま使える。
  const [listWidth, setListWidth] = useState(0);
  const onListLayout = useCallback(
    (e: LayoutChangeEvent) => setListWidth(Math.round(e.nativeEvent.layout.width)),
    [],
  );
  const listCols = listColumns(listWidth, wide);
  const cellWidth = listCellWidth(listWidth, listCols);
  // lint(jsx-no-new-object-as-prop)対策: 1枚ぶんの幅は幅が変わったときだけ作り直す。
  const cellStyle = useMemo(
    () => (cellWidth === undefined ? undefined : { width: cellWidth }),
    [cellWidth],
  );
  const { shownTab, tabs, selectTab } = useBoxTabs(mode, initialTab);
  // カードチャットは画面を問わずこのペインに一本化した(旧・自由記述欄は廃止=2026-10-22ユーザー決定)。
  // ヘッダのポップオーバーも幅<720なので、ペインは全画面スライドとして重なる。
  // ペインの相手は2種: カードの投函元スレ(💬)と、優先順位の行の担当スレ(行タップ)。
  // どちらも同じペイン・同じURL面(`?card=` / `?thread=`)を使う(2026-10-23 ユーザー指示)。
  const { pane, open: openPane, close: closePane, fold: foldPane } = useCardPaneRoute(true);
  const {
    paneCardId,
    paneThreadId,
    paneItem,
    paneThreadTitle,
    threadNotice,
    openCard: openPaneFor,
    openThread,
  } = useConfirmBoxPane({ items: data?.items, pane, openPane });
  const openCard = useCallback(
    (item: ConfirmBoxItem) => {
      setDepth("chat");
      openPaneFor(item);
    },
    [openPaneFor],
  );
  const s = useMemo(() => {
    const tap = touch ? { minHeight: 44, justifyContent: "center" as const } : {};
    return {
      root: { flex: 1, backgroundColor: c.surface0 },
      flex: { flex: 1 },
      splitRow: { flex: 1, flexDirection: "row" as const },
      body: { padding: 12, gap: 8 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      },
      // 右ペインに出ているカードの軽い強調(枠線と薄い背景)。
      cardActive: {
        backgroundColor: c.surface1,
        borderColor: c.accent,
        borderWidth: 2,
        borderRadius: 8,
        padding: 9,
        gap: 6,
      },
      subject: {
        color: c.foreground,
        fontSize: 15,
        fontWeight: "600" as const,
      },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      badge: { color: c.accent, fontSize: 11 },
      link: {
        color: c.accent,
        fontSize: 13,
        textDecorationLine: "underline" as const,
      },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: touch ? 8 : 6,
      },
      plainBlock: { gap: 6 },
      plainSymbol: { color: c.accent, fontWeight: "700" as const },
      reporter: {
        color: c.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      // サブ操作(背景・💬・元スレ)は小さめ。最下行は必ず1行に収める。
      footBtn: { paddingVertical: 4, paddingHorizontal: 4 },
      footBtnOff: { paddingVertical: 4, paddingHorizontal: 4, opacity: 0.45 },
      created: {
        color: c.foregroundMuted,
        fontSize: 12,
        marginLeft: "auto" as const,
        flexShrink: 0,
      },
      footText: { color: c.accent, fontSize: 12 },
      footRow: {
        flexDirection: "row" as const,
        flexWrap: "nowrap" as const,
        alignItems: "center" as const,
        justifyContent: "flex-start" as const,
        gap: 4,
      },
      filterLine: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        ...tap,
      },
      bottomBar: {
        flexGrow: 0,
        flexShrink: 0,
        borderTopWidth: 1,
        borderTopColor: c.border,
        backgroundColor: c.surface1,
        // iPhoneのホームバー分(web: env(safe-area-inset-bottom))
        paddingBottom: "env(safe-area-inset-bottom)" as unknown as number,
      },
      tabStrip: { flexGrow: 1 },
      // 5枚を等分する。iPhone幅390pxなら1枚78px、最小56pxを割る幅では横スクロールへ落ちる。
      tabBtn: {
        flex: 1,
        minWidth: 56,
        minHeight: 56,
        paddingHorizontal: 4,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      // アイコンと**同じ大きさ**の箱。バッジはこの箱の右上角を基準に absolute で置く(はみ出しは許容)。
      tabIcon: {
        width: 24,
        height: 24,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      badgeDot: {
        position: "absolute" as const,
        top: -7,
        right: -9,
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 4,
        backgroundColor: c.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      badgeText: {
        color: c.accentForeground,
        fontSize: 10,
        fontWeight: "700" as const,
      },
      btn: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: touch ? 10 : 6,
        paddingHorizontal: touch ? 14 : 10,
        ...tap,
      },
      btnRec: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingVertical: touch ? 10 : 6,
        paddingHorizontal: touch ? 14 : 10,
        ...tap,
      },
      btnText: { color: c.foreground, fontSize: 13 },
      btnRecText: { color: c.accentForeground, fontSize: 13 },
      warn: { color: c.statusWarning, fontSize: 12 },
      rejectBox: {
        borderColor: c.statusWarning,
        borderWidth: 1,
        borderRadius: 8,
        padding: 8,
        gap: 8,
      },
      rejectInput: {
        color: c.foreground,
        fontSize: 16, // iOS は 16px 未満の入力欄でフォーカス時に拡大する
        minHeight: 72,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 8,
        textAlignVertical: "top" as const,
      },
      // 判断一覧の並べ(PC幅は複数列。1枚ごとの幅は listCellWidth で決める)。
      grid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "flex-start" as const,
        gap: LIST_GRID_GAP,
      },
    };
  }, [c, touch]);

  const toggle = useCallback((id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    setDepth("expanded");
  }, []);
  const openBackground = useCallback(() => setDepth("background"), []);
  const choose = useCallback(
    async (item: ConfirmBoxItem, optionId: string) => {
      try {
        if (item.kind === "permit" && item.agentId) {
          const requestId = item.id.split(":").slice(2).join(":");
          const r = await permit({
            agentId: item.agentId,
            requestId,
            actionId: optionId,
          });
          setNotice(r.message);
        } else if (item.key) {
          const r = await decide({
            key: item.key,
            chosen: optionId,
            recommended: item.recommended,
            depth,
            reason: "",
            source: "paseo-plugin",
          });
          setNotice(r.message);
        } else {
          setNotice("この項目は決定を記録できません(key なし)");
        }
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      void reload();
      notifyBoxChanged();
    },
    [decide, permit, depth, reload],
  );

  /** 却下(コメント必須)。成功したら true を返し、カードは一覧から消える。 */
  const reject = useCallback(
    async (item: ConfirmBoxItem, comment: string): Promise<boolean> => {
      const text = rejectComment(comment);
      if (!text || !item.key) {
        setNotice("却下にはコメントが必要です");
        return false;
      }
      try {
        const r = await decide({
          key: item.key,
          chosen: REJECT_CHOICE,
          recommended: item.recommended,
          depth,
          reason: text,
          source: "paseo-plugin",
        });
        setNotice(r.message);
        if (!r.ok) return false;
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
        return false;
      }
      void reload();
      notifyBoxChanged();
      return true;
    },
    [decide, depth, reload],
  );

  /** 質問への回答。押された選択肢/自由記述を `answers` として送る。 */
  const answer = useCallback(
    async (item: ConfirmBoxItem, answers: Record<string, string>) => {
      if (item.kind !== "permit" || !item.agentId) {
        setNotice("この項目は回答を送れません");
        return;
      }
      try {
        const r = await permit({
          agentId: item.agentId,
          requestId: item.id.split(":").slice(2).join(":"),
          actionId: null,
          answers,
        });
        setNotice(r.message);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      void reload();
      notifyBoxChanged();
    },
    [permit, reload],
  );

  // 判断タブは判断印のある項目と Paseo 承認待ちだけ。通知・バグ報告・完了報告は専用タブにだけ出す。
  // 印の無い旧形式(選択肢つき)は「印なし(旧形式)」を押した時だけ加える。
  const visible = useMemo(
    () =>
      judgmentTabRows(data?.items ?? [], {
        showDone,
        prio: prio === "all" ? null : (prio as ConfirmBoxPriority),
        newestFirst: sortNew,
        legacy: !legacyOff,
      }),
    [data, showDone, prio, sortNew, legacyOff],
  );

  const chip = (label: string, on: boolean, press: () => void) => (
    <Pressable key={label} accessibilityRole="button" style={on ? s.btnRec : s.btn} onPress={press}>
      <Text style={on ? s.btnRecText : s.btnText}>{label}</Text>
    </Pressable>
  );

  const toggleFilter = useCallback(() => setFilterOpen((v) => !v), []);
  const filterSummary = summarizeFilter({
    prio,
    sortNew,
    showDone,
    legacyOff,
    count: visible.length,
    permits: visible.filter((i) => i.kind === "permit").length,
  });

  const { selectFromHeader, refreshFromHeader, reloadN } = useHeaderNav({
    openScreen,
    shownTab,
    manualReload,
  });
  const { showAll, setToggleInfo, headerToggle } = useHeaderToggle(shownTab);

  // 幅で置き場所が変わる(右に並べる/全画面で重ねる)ので、SplitLayout へ要素ごと渡す。
  // ペインの相手は投函元スレ(2026-10-22 ユーザー決定)。まだ一覧に来ていないカードは null。
  const { answer: paneAgentId, open: openTarget } = paneTargets(paneItem, paneThreadId);
  const openPaneThread = usePaneOpenThread({
    agentId: openTarget,
    item: paneItem,
    destination: paneItem ? paneAgentId : null,
    // ペインに今出ている相手。URL の `?card=` にはカードIDしか無いので、答えるスレを添える
    // (「分からない(null)」と「同じ」を取り違えないため。round1 F2)。
    currentPane: currentPaneWithAnswer(pane, paneAgentId),
    onFold: foldPane,
    threadTitle: paneThreadTitle,
    wide,
    hosts,
    openAgent,
    onNotice: setNotice,
  });
  // eslint-disable-next-line eslint-plugin-react-perf/jsx-no-jsx-as-prop -- 同一レンダーの子として一度だけ置く
  const paneEl = pane ? (
    <CardChatPane
      item={paneItem}
      agentId={paneAgentId}
      title={paneThreadTitle ?? undefined}
      colors={c}
      compact={compact}
      width={width}
      onClose={closePane}
      onOpenThread={openPaneThread}
    />
  ) : null;

  // タブごとの中身。入れ子の三項を JSX へ書かないよう if 連鎖で組み立てる。
  let content: ReactNode;
  if (shownTab === "priority") {
    content = (
      <>
        {threadNotice ? <Text style={s.muted}>{threadNotice}</Text> : null}
        <PriorityView styles={s} colors={c} onOpenThread={openThread} />
      </>
    );
  } else if (shownTab === "bugs") {
    content = (
      <BugReportsView theme={theme} showArchived={showAll.bugs} onToggleInfo={setToggleInfo} />
    );
  } else if (shownTab === "notify") {
    content = <NotificationsView theme={theme} />;
  } else {
    content = (
      <>
        <Pressable accessibilityRole="button" style={s.filterLine} onPress={toggleFilter}>
          <Text style={s.text}>{filterSummary}</Text>
          <Text style={s.muted}>{filterOpen ? "▲" : "▼"}</Text>
        </Pressable>
        {filterOpen ? (
          <View style={s.row}>
            {chip("全て", prio === "all", () => setPrio("all"))}
            {(Object.keys(PRIORITY_LABEL) as (keyof typeof PRIORITY_LABEL)[]).map((k) =>
              chip(PRIORITY_LABEL[k], prio === k, () => setPrio(k)),
            )}
            {chip(sortNew ? "新しい順" : "優先度順", true, () => setSortNew((v) => !v))}
            {chip("決定済みも表示", showDone, () => setShowDone((v) => !v))}
            {chip("印なし(旧形式)", !legacyOff, () => setLegacyOff((v) => !v))}
          </View>
        ) : null}
        {error ? <Text style={s.warn}>読み込めません: {error}</Text> : null}
        {data?.sources
          .filter((x) => !x.ok)
          .map((x) => (
            <Text key={x.id} style={s.warn}>
              {x.label}: {x.detail}
            </Text>
          ))}
        {notice ? <Text style={s.muted}>{notice}</Text> : null}
        {data && visible.length === 0 ? <Text style={s.muted}>判断待ちはありません</Text> : null}
        {/* PC幅は複数列(2026-10-28 ユーザー決定)。1列のときは今までと同じ並び。 */}
        <View style={listCols > 1 ? s.grid : undefined}>
          {visible.map((item) => (
            <View key={item.id} style={cellStyle}>
              <ItemCard
                item={item}
                styles={s}
                colors={c}
                open={openId === item.id}
                onToggle={toggle}
                onBackground={openBackground}
                onChoose={choose}
                onAnswer={answer}
                onReject={reject}
                paneOpen={paneCardId === item.id}
                anyPaneOpen={pane !== null}
                onOpenPane={openCard}
              />
            </View>
          ))}
        </View>
      </>
    );
  }

  return (
    <SplitLayout styles={s} compact={compact} pane={paneEl}>
      <View style={s.flex} onLayout={onListLayout}>
        <HeaderSlot
          show={openScreen !== undefined}
          active={shownTab}
          counts={counts}
          colors={c}
          onSelect={selectFromHeader}
          onRefresh={refreshFromHeader}
          toggle={headerToggle}
          touch={touch}
        />
        <ScrollView key={reloadN} style={s.flex} contentContainerStyle={s.body}>
          <InlineToggle show={openScreen === undefined} toggle={headerToggle} styles={s} />
          {content}
        </ScrollView>
        {shownTab === "priority" ? <ChatDock colors={c} agentId={PRIORITY_CHAT_AGENT_ID} /> : null}
        {/* 下部バーから開いた画面(`mode` が box 以外)はタブ1枚だけなので、並びは出さない。 */}
        <TabStrip
          mode={stripMode(mode, openScreen !== undefined)}
          tabs={tabs}
          shownTab={shownTab}
          counts={counts}
          selectTab={selectTab}
          styles={s}
          colors={c}
        />
      </View>
    </SplitLayout>
  );
}

/**
 * 一覧とチャットペインの並べ方。720px以上は右に並べ(一覧は残る)、
 * 狭い幅(iPhone)は右から全画面で重ねる。
 */
function SplitLayout({
  styles,
  compact,
  pane,
  children,
}: {
  styles: Styles;
  compact: boolean;
  pane: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.splitRow}>
        {children}
        {compact ? null : pane}
      </View>
      {compact ? pane : null}
    </View>
  );
}

/** 幅の判定に使う値。ポップオーバーは窓が広くても箱が狭いので、測った箱幅を優先する。 */
function layoutWidth(containerWidth: number | undefined, windowWidth: number): number {
  return containerWidth ?? windowWidth;
}

/**
 * 高さの判定に使う値。箱幅を渡された(ポップオーバー)ときは**箱の幅だけで決める**ので高さは見ない
 * (窓は高くても箱は狭いため。横倒しの iPhone 判定は画面全体を描くときにだけ効かせる)。
 */
function boxHeight(containerWidth: number | undefined, windowHeight: number): number | undefined {
  return containerWidth === undefined ? windowHeight : undefined;
}

/**
 * 一覧とチャットを横に並べるか(PC 幅で出すか)。箱幅を渡された(ポップオーバー)ときは
 * 高さを見ず、箱の幅だけで決める。
 */
function isBoxWide(
  containerWidth: number | undefined,
  windowSize: { width: number; height: number },
  layout: PluginHostProps["layout"] | undefined,
): boolean {
  const width = layoutWidth(containerWidth, windowSize.width);
  return isWideLayout(
    width,
    boxHeight(containerWidth, windowSize.height),
    layout?.compact ?? false,
  );
}

/**
 * 最上部のアイコン列の動き。押した画面へ移る(今の画面なら何もしない): ユーザー判断は下部バーと同じ
 * `box-tab` 画面、それ以外は確認箱(`main`)の `?tab=`。
 * 更新: 判断一覧は取り直しの成否を返す。他の画面は各画面が開いた時に取り直すので、作り直して取らせる。
 */
function useHeaderNav({
  openScreen,
  shownTab,
  manualReload,
}: {
  openScreen: ((input: { screenId: string; params?: Record<string, string> }) => void) | undefined;
  shownTab: TabId;
  manualReload: () => Promise<boolean>;
}) {
  const selectFromHeader = useCallback(
    (id: HeaderTabId) => {
      if (!openScreen || id === shownTab) return;
      if (id === "items") {
        openScreen({ screenId: "box-tab" });
      } else {
        openScreen({ screenId: "main", params: { tab: id } });
      }
    },
    [openScreen, shownTab],
  );
  const [reloadN, setReloadN] = useState(0);
  const refreshFromHeader = useCallback(async () => {
    if (shownTab === "items") return manualReload();
    setReloadN((v) => v + 1);
    notifyBoxChanged();
    return true;
  }, [shownTab, manualReload]);
  return { selectFromHeader, refreshFromHeader, reloadN };
}

/**
 * バグ報告(完了済み)の「も表示」切替。ボタンはアイコン列の更新ボタンの左に置くので、
 * 出す/隠すの状態はここで持ち、画面は表示の有無とラベルだけを `setToggleInfo` で知らせる。
 */
function useHeaderToggle(shownTab: TabId) {
  const [showAll, setShowAll] = useState({ bugs: false });
  const [toggleInfo, setToggleInfo] = useState<ToggleInfo | null>(null);
  const onPress = useCallback(() => {
    if (shownTab === "bugs") {
      setShowAll((v) => ({ ...v, bugs: !v.bugs }));
    }
  }, [shownTab]);
  const headerToggle = useMemo<HeaderToggle | null>(
    () => (toggleInfo ? { ...toggleInfo, onPress } : null),
    [toggleInfo, onPress],
  );
  return { showAll, setToggleInfo, headerToggle };
}

/** アイコン列が無い画面(ポップオーバー)では、切替ボタンを一覧の先頭に出す。 */
function InlineToggle({
  show,
  toggle,
  styles,
}: {
  show: boolean;
  toggle: HeaderToggle | null;
  styles: { filterLine: object; text: object };
}) {
  if (!show || !toggle) return null;
  return (
    <Pressable accessibilityRole="button" style={styles.filterLine} onPress={toggle.onPress}>
      <Text style={styles.text}>{toggle.a11y}</Text>
    </Pressable>
  );
}

/** アイコン列を出す画面では、下の並び(TabStrip)は要らない(`items` を渡すと何も描かない)。 */
function stripMode(mode: "box" | "items", hasHeader: boolean) {
  return hasHeader ? "items" : mode;
}

function HeaderSlot({ show, ...props }: { show: boolean } & ComponentProps<typeof HeaderIconBar>) {
  return show ? <HeaderIconBar {...props} /> : null;
}

type TabId = "items" | "bugs" | "notify" | "priority";

/**
 * 出すタブの並びと現在のタブ。
 * - `box`: 確認箱そのもの。下部バーへ移した1枚(ユーザー判断)を外した3枚(PC も iPhone も同じ)
 * - `items`: 下部バーから開いた画面。そのタブだけを出す(並びは出さない)
 * 初期タブは、開いた画面ならそのタブ、確認箱ならバグ報告。
 */
function useBoxTabs(
  mode: "box" | "items",
  initialTab: "bugs" | "notify" | "priority" = "bugs",
): {
  shownTab: TabId;
  tabs: readonly (typeof TABS)[number][];
  selectTab: (id: TabId) => void;
} {
  const [picked, setPicked] = useState<TabId | null>(null);
  const forcedTab: TabId | null = mode === "box" ? null : mode;
  const tabs = mode === "box" ? confirmBoxTabs(TABS) : TABS.filter((tb) => tb.id === forcedTab);
  // 選んだタブが今の並びに無くなったときは、選んだ値を捨てて既定へ戻す
  // (並びに無いタブの中身が出続けるのを防ぐ)。
  const valid = picked !== null && tabs.some((tb) => tb.id === picked);
  const shownTab: TabId = (valid && picked) || forcedTab || initialTab;
  const selectTab = useCallback((id: TabId) => setPicked(id), []);
  return { shownTab, tabs, selectTab };
}

/** 下の並び。確認箱そのもののときだけ出す(下部バーから開いた画面はタブ1枚だけなので出さない)。 */
function TabStrip({
  mode,
  tabs,
  shownTab,
  counts,
  selectTab,
  styles: s,
  colors: c,
}: {
  mode: "box" | "items";
  tabs: readonly (typeof TABS)[number][];
  shownTab: TabId;
  counts: Partial<Record<TabId, number>>;
  selectTab: (id: TabId) => void;
  styles: Styles;
  colors: Pick<PluginTheme["colors"], "accent" | "foregroundMuted">;
}) {
  if (mode !== "box") return null;
  return (
    <View style={s.bottomBar}>
      {/* `flexGrow:1` で等分(PC も iPhone も3枚)。狭い幅では等分を保ったまま横スクロールへ落ちる。 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tabStrip}
      >
        {tabs.map((tb) => (
          <TabButton
            key={tb.id}
            tab={tb}
            on={shownTab === tb.id}
            styles={s}
            accent={c.accent}
            muted={c.foregroundMuted}
            count={counts[tb.id] ?? 0}
            onSelect={selectTab}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const TABS: { id: TabId; label: string; Icon: typeof InboxIcon }[] = [
  { id: "items", label: "判断待ち", Icon: InboxIcon },
  { id: "bugs", label: "Toposバグ報告", Icon: BugIcon },
  { id: "notify", label: "通知", Icon: BellIcon },
  { id: "priority", label: "優先順位", Icon: ListIcon },
];

/** バッジ用の件数。30秒毎 + 決定/既読の直後(`notifyBoxChanged`)に取り直す。 */
function useBadgeCounts(): Partial<Record<TabId, number>> {
  const count = useRpc(confirmBoxCountRpc);
  const [n, setN] = useState<Partial<Record<TabId, number>>>({});
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await count({});
        if (alive) {
          setN({
            items: r.open,
            bugs: r.bugs,
            notify: r.notifications,
          });
        }
      } catch {
        // 一時的な失敗では前回の件数を残す(バッジが消えると「未確認が無くなった」と読めるため。
        // 一覧そのものは各タブが別途読む)。
      }
    };
    void tick();
    const timer = setInterval(tick, REFRESH_MS);
    const off = onBoxChanged(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [count]);
  return n;
}

function TabButton({
  tab,
  on,
  styles,
  accent,
  muted,
  count,
  onSelect,
}: {
  tab: (typeof TABS)[number];
  on: boolean;
  styles: Styles;
  accent: string;
  muted: string;
  count: number;
  onSelect: (id: TabId) => void;
}) {
  const press = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
  const label = count > 0 ? `${tab.label}(${count})` : tab.label;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={on ? SELECTED : UNSELECTED}
      style={styles.tabBtn}
      onPress={press}
    >
      {/* バッジの基準は**アイコン**。タブ幅いっぱいのボタンに absolute で置くと、幅が伸びた分だけ右へずれる
          (iPad幅で顕著)。アイコンと同じ箱に重ね、右上へのはみ出し分は箱側の余白で確保する。 */}
      <View style={styles.tabIcon}>
        <tab.Icon color={on ? accent : muted} size={24} />
        {count > 0 ? (
          <View style={styles.badgeDot}>
            <Text style={styles.badgeText} numberOfLines={1}>
              {count > 99 ? "99+" : count}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };
/** 質問が無い項目で毎回新しい配列を作らないため(react-perf の lint 対策)。 */
const NO_QUESTIONS: NonNullable<ConfirmBoxItem["questions"]> = [];

type Styles = Record<string, object>;

/** 判断タブの絞り込みバーの1行要約。 */
function summarizeFilter({
  prio,
  sortNew,
  showDone,
  legacyOff,
  count,
  permits,
}: {
  prio: string;
  sortNew: boolean;
  showDone: boolean;
  legacyOff: boolean;
  count: number;
  permits: number;
}): string {
  const parts = [
    prio === "all" ? "全て" : PRIORITY_LABEL[prio as keyof typeof PRIORITY_LABEL],
    sortNew ? "新しい順" : "優先度順",
    showDone ? "決定済み含む" : "",
    legacyOff ? "" : "旧形式含む",
    // 判断窓口の「全N件」は判断ノートだけ。Paseo の承認待ちは別枠なので、含むときは内訳を出す
    // (バッジが窓口の件数より大きく見える理由を画面で分かるようにする。2026-10-27)
    permits > 0 ? `${count}件(うちPaseo承認待ち${permits}件)` : `${count}件`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * ペイン見出しの「スレを開く」のハンドラ。PC幅(wide)は右カラムで、狭い幅は従来どおり遷移で開く
 * (2026-10-25 ユーザー指示)。2026-10-27: 宛先を一覧で確かめ、無ければ持ち主のスレへ振り替える
 * (`openThreadInPane`)。開けなかった/振り替えた理由は画面の1行(`onNotice`)に出す。
 */
function usePaneOpenThread({
  agentId,
  item,
  destination,
  currentPane,
  onFold,
  threadTitle,
  wide,
  hosts,
  openAgent,
  onNotice,
}: {
  /** 開くスレ(投函に `thread_id` があれば投函元そのもの)。無ければ宛先決めが持ち主へ振り替える。 */
  agentId: string | null;
  item: ConfirmBoxItem | null;
  /** この欄に答えるスレ。開くスレが閉じていて宛先が決まらないときの次点。 */
  destination: string | null;
  /** 確認箱のペインに今出ている相手(カードは答えるスレ付き)。開くスレがこれと同じなら主ペイン化。 */
  currentPane: OpenThreadContext["currentPane"];
  /** 同じ相手を主ペインで開き直すとき、確認箱のペインを外す。 */
  onFold: () => void;
  threadTitle: string | null;
  wide: boolean;
  hosts: ReturnType<typeof useHosts>;
  openAgent: ((input: { agentId: string; placement?: "right" }) => Promise<void>) | undefined;
  onNotice: (text: string) => void;
}): (() => void) | undefined {
  // 宛先の検証に使う司令塔のID。カードを開いている間だけ引く(スレ直接=カード無しでは不要)。
  const coordinators = useCoordinatorTargets(item !== null);
  const notice = useCallback((text: string) => void onNotice(text), [onNotice]);
  return useMemo(() => {
    if ((!agentId && !destination) || !openAgent) return undefined;
    const input = {
      serverId: hosts.find((h) => h.status === "online")?.serverId ?? "",
      target: agentId,
      // 開くスレが閉じていて宛先が決まらないときの次点(この欄に答えるスレ)。
      ...(destination && destination !== agentId ? { destination } : {}),
      context: {
        currentPane,
        // 同じ相手なら主ペイン化するかは、**実際に開いた後**の宛先で判定する(`open-pane-thread.ts`)。
        // ここで URL の相手から先に決めると、宛先が振り替わったときに誤って畳む。
        ...(wide ? { placement: "right" as const } : {}),
        title: item !== null ? (item.subject ?? threadTitle) : null,
        coordinatorId: coordinators?.agentId ?? null,
        hubIds: coordinators?.hubIds,
        direct: item === null,
      },
      open: openAgent,
      onFold,
      onNotice: notice,
    };
    return () => void openThreadInPane(input);
  }, [
    agentId,
    destination,
    currentPane,
    onFold,
    openAgent,
    wide,
    item,
    threadTitle,
    coordinators,
    hosts,
    notice,
  ]);
}

/**
 * ペインに出す2つの相手。カードが無い(スレ直接)ときはどちらも URL のスレそのもの。
 * - `answer` … この欄に答えるスレ(チャットの送り先)。
 * - `open`   … 「スレを開く」の宛先(投函元)。答えるスレ(親)は、開くスレが閉じているときの次点。
 */
/**
 * ペインの相手に「カードのときは答えるスレ」を添える。`paneItem` を引けていない(まだ一覧に来ていない)間は
 * 答えるスレが分からないので、そのカードを開くスレと同じ扱いにはしない(畳まない=右に開く)。
 */
function currentPaneWithAnswer(
  pane: ReturnType<typeof useCardPaneRoute>["pane"],
  answerId: string | null,
): OpenThreadContext["currentPane"] {
  if (pane?.kind !== "card") return pane;
  return { kind: "card", id: pane.id, answerId };
}

function paneTargets(
  paneItem: ConfirmBoxItem | null,
  paneThreadId: string | null,
): { answer: string | null; open: string | null } {
  if (!paneItem) return { answer: paneThreadId, open: paneThreadId };
  return {
    answer: threadAgentId(paneItem),
    open: resolveOpenThreadId(paneItem),
  };
}

/**
 * この欄に答えるスレ(=チャットの送り先)。サーバが決めた `threadRef`(投函元の親)を使う。
 * 「スレを開く」の宛先は別(`resolveOpenThreadId` = 投函に `thread_id` があれば投函元そのもの)。
 */
function threadAgentId(item: ConfirmBoxItem): string | null {
  if (item.threadRef?.kind === "paseo_agent") return item.threadRef.id;
  return item.agentId;
}

function formatCreated(ts: number): string {
  // 単位はソースにより秒/ミリ秒。年月日として読めない値(連番等)は出さない。
  let ms = 0;
  if (ts > 1e12) ms = ts;
  else if (ts > 1e9) ms = ts * 1000;
  if (ms === 0) return "日時なし";
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 選択肢の記号。id が a〜f / 1 桁の英数ならそれ、そうでなければ 1 始まりの番号。 */
function optionSymbol(option: ConfirmBoxItem["options"][number], index: number): string {
  return /^[a-z0-9]$/i.test(option.id) ? option.id : String(index + 1);
}

function OptionButton({
  item,
  option,
  symbol,
  styles,
  onChoose,
}: {
  item: ConfirmBoxItem;
  option: ConfirmBoxItem["options"][number];
  /** 指定時は記号だけのボタンにする(文章は別途、平文で全文を出す)。 */
  symbol?: string;
  styles: Styles;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
}) {
  const rec = option.id === item.recommended;
  const press = useCallback(() => void onChoose(item, option.id), [onChoose, item, option.id]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={symbol ? `${symbol}: ${option.label}` : undefined}
      style={rec ? styles.btnRec : styles.btn}
      onPress={press}
    >
      <Text style={rec ? styles.btnRecText : styles.btnText}>
        {symbol ?? option.label}
        {!symbol && rec && !option.label.includes("推奨") ? "(推奨)" : ""}
      </Text>
    </Pressable>
  );
}

/** 選択肢の文章は平文で全文を折り返して出し、ボタンは記号(a b c / 1 2 3)だけを1列に並べる。
 * 承認待ち(permit)の許可/拒否は文言が短いので従来どおり文言ボタン。 */
function PlainOptions({
  item,
  styles,
  onChoose,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
}) {
  if (item.kind === "permit") {
    return (
      <View style={styles.row}>
        {item.options.map((o) => (
          <OptionButton key={o.id} item={item} option={o} styles={styles} onChoose={onChoose} />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.plainBlock}>
      {item.options.map((o, i) => {
        const rec = o.id === item.recommended;
        return (
          <Text key={o.id} style={styles.text}>
            <Text style={styles.plainSymbol}>{optionSymbol(o, i)}</Text>
            {"  "}
            {o.label}
            {rec && !o.label.includes("推奨") ? "(推奨)" : ""}
          </Text>
        );
      })}
      <View style={styles.row}>
        {item.options.map((o, i) => (
          <OptionButton
            key={o.id}
            item={item}
            option={o}
            symbol={optionSymbol(o, i)}
            styles={styles}
            onChoose={onChoose}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * 却下パネル(押し間違い防止の確認ステップを兼ねる)。コメント必須: 空白だけでは送れない。
 * 送ると Vault の判断ノートが superseded になり、コメントが回答原文へ逐語で残り、投函元へ伝わる。
 */
function RejectPanel({
  item,
  styles,
  onReject,
  onCancel,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  onReject: (item: ConfirmBoxItem, comment: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = rejectComment(text) !== null && !busy;
  const send = useCallback(async () => {
    if (rejectComment(text) === null || busy) return;
    setBusy(true);
    await onReject(item, text);
    // 失敗時は入力を残して再送できる。成功時はカードごと消えるが、再読込が遅れても「やめる」で閉じられるよう常に戻す
    setBusy(false);
  }, [text, busy, onReject, item]);
  const sendPress = useCallback(() => void send(), [send]);
  const inputStyle = useMemo(() => styles.rejectInput, [styles.rejectInput]);
  return (
    <View style={styles.rejectBox}>
      <Text style={styles.text}>この判断を却下します。理由(コメント)を書いてください。</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="例: もう解決済み / 前提が違う"
        multiline
        autoFocus
        style={inputStyle}
      />
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          style={ready ? styles.btnRec : styles.btn}
          onPress={sendPress}
        >
          <Text style={ready ? styles.btnRecText : styles.btnText}>却下を送る</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} style={styles.btn} onPress={onCancel}>
          <Text style={styles.btnText}>やめる</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ItemCard({
  item,
  styles,
  colors,
  open,
  onToggle,
  onBackground,
  onChoose,
  onAnswer,
  onReject,
  paneOpen,
  anyPaneOpen,
  onOpenPane,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  colors: QuestionAnswerColors;
  open: boolean;
  onToggle: (id: string) => void;
  onBackground: () => void;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
  onAnswer: (item: ConfirmBoxItem, answers: Record<string, string>) => Promise<void>;
  onReject: (item: ConfirmBoxItem, comment: string) => Promise<boolean>;
  /** このカードの会話ペインが開いているか。 */
  paneOpen: boolean;
  /** 右ペインが(どの相手でも)開いているか。開いている間だけ、カード本体のタップで相手を切り替える。 */
  anyPaneOpen: boolean;
  onOpenPane: (item: ConfirmBoxItem) => void;
}) {
  const [bgOpen, setBgOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const startReject = useCallback(() => setRejecting(true), []);
  const cancelReject = useCallback(() => setRejecting(false), []);
  const toggleBg = useCallback(() => {
    setBgOpen((v) => {
      if (!v) onBackground();
      return !v;
    });
  }, [onBackground]);
  const openPane = useCallback(() => onOpenPane(item), [onOpenPane, item]);
  // カード本体の何もない所のタップ。内側のボタン・リンクは自分で処理する(入れ子の Pressable は内側が勝つ)。
  const switchPane = shouldSwitchPaneOnCardPress(anyPaneOpen, paneOpen) ? openPane : undefined;
  // 件名の押下: 従来どおり展開の切替。右ペインが開いている間は、そのカードをペインの相手に切り替える。
  const headerPress = useCallback(() => {
    onToggle(item.id);
    switchPane?.();
  }, [onToggle, item.id, switchPane]);
  const deny = useCallback(() => void onChoose(item, "__deny"), [item, onChoose]);
  const answer = useCallback(
    (answers: Record<string, string>) => void onAnswer(item, answers),
    [item, onAnswer],
  );
  const created = useMemo(() => formatCreated(item.ts), [item.ts]);
  const questions = item.questions ?? NO_QUESTIONS;
  return (
    <View style={paneOpen ? styles.cardActive : styles.card}>
      {item.reporter ? <Text style={styles.reporter}>報告者: {item.reporter}</Text> : null}
      {/* ペイン切替は件名の押下だけ。外枠を Pressable にすると、右ペインが開いている間 react-native-web が
          disabled でカード全体を pointer-events:none にし、選択肢のボタンまで押せなくなる(6203a53 の切り分け)。
          PC幅は一覧を出したまま操作できることが前提なので、外枠はただの View にする。 */}
      <Pressable accessibilityRole="button" onPress={headerPress} disabled={!switchPane}>
        <Text style={styles.badge}>
          {PRIORITY_LABEL[item.priority]} · {KIND_LABEL[item.kind]}
          {item.state === "approved" ? " · 決定済み" : ""}
          {item.onHold ? ` · ${item.onHold}(窓口では出ません)` : ""}
        </Text>
        <Text style={styles.subject}>{item.subject}</Text>
        {open || questions.length > 0 ? null : (
          <Text style={styles.muted} numberOfLines={2}>
            {item.summary}
          </Text>
        )}
      </Pressable>
      {questions.length > 0 ? (
        <QuestionAnswer
          questions={questions}
          colors={colors}
          disabled={false}
          onAnswer={answer}
          onDeny={deny}
        />
      ) : (
        <PlainOptions item={item} styles={styles} onChoose={onChoose} />
      )}
      {rejecting ? (
        <RejectPanel item={item} styles={styles} onReject={onReject} onCancel={cancelReject} />
      ) : null}
      {open && questions.length === 0 ? <Text style={styles.text}>{item.summary}</Text> : null}
      {bgOpen && item.background ? <Text style={styles.text}>{item.background}</Text> : null}
      <View style={styles.footRow}>
        {item.background ? (
          <Pressable accessibilityRole="button" style={styles.footBtn} onPress={toggleBg}>
            <Text style={styles.footText}>{bgOpen ? "▼背景" : "▶背景"}</Text>
          </Pressable>
        ) : null}
        {/* 会話ボタンは1つだけ(2026-10-23 ユーザー指示)。押すと投函元スレの会話を右ペイン(狭い幅は全画面)で開く。
            実スレ画面への全面遷移(旧 ↩ スレ)は、単独ボタンからの「スレを開く」としてペインのヘッダーだけに残している。 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="投函元スレの会話を右に開く"
          style={styles.footBtn}
          onPress={openPane}
        >
          <Text style={styles.footText}>{paneOpen ? "▼会話" : "💬 会話"}</Text>
        </Pressable>
        {canRejectItem(item) && !rejecting ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="この判断を却下する(コメント必須)"
            style={styles.footBtn}
            onPress={startReject}
          >
            <Text style={styles.footText}>✕ 却下</Text>
          </Pressable>
        ) : null}
        <Text style={styles.created} numberOfLines={1}>
          {created}
        </Text>
      </View>
    </View>
  );
}
