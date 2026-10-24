/**
 * 統合確認箱の画面本体。全画面(サイドバーから)とヘッダボタンのポップオーバーで共用する。
 *
 * v1: 一覧(優先度順)・展開・背景の4段階開示・選択して決定を記録・Paseo承認待ちへの応答。
 * 決定の記録は押した時だけ(自動では何も決めない)。
 * カードごとの会話は 💬 から開く専用ペイン(CardChatPane)に一本化した(旧・カード内の自由記述欄は廃止)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  confirmBoxCountRpc,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
  judgmentTabRows,
} from "../shared/contract.js";
import { confirmBoxTabs, isWideLayout } from "../shared/footer-tabs.js";
import { onBoxChanged, notifyBoxChanged } from "./events.js";
import { PriorityView } from "./PriorityView.js";
import { BugReportsView } from "./BugReportsView.js";
import { ChildDoneView } from "./ChildDoneView.js";
import { NotificationsView } from "./NotificationsView.js";
import { BellIcon, BugIcon, CheckCircleIcon, InboxIcon, ListIcon } from "./Icons.js";
import { ChatDock, PRIORITY_CHAT_AGENT_ID } from "./ChatDock.js";
import { CardChatPane } from "./CardChatPane.js";
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
  navigation,
  containerWidth,
  mode = "box",
  layout,
}: Pick<PluginHostProps, "theme"> & {
  /** ホストの `layout`。省略時(ポップオーバー)は幅・高さだけで判定する。 */
  layout?: PluginHostProps["layout"];
  navigation?: { openAgent: (input: { agentId: string; serverId?: string }) => void };
  /** 描画先の箱の幅。省略時は窓幅。ポップオーバーは窓が広くても箱が狭いので実測値を渡す。 */
  containerWidth?: number;
  /**
   * 開き方。`box`=確認箱そのもの(下部バー:「バグ報告」等から開く。中は バグ報告・通知・優先順位 の3枚)、
   * `items`/`childdone`=下部バーの「ユーザー判断」「子スレ完了」から開いた画面(そのタブだけ)。
   */
  mode?: "box" | "items" | "childdone";
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

  const reload = useCallback(async () => {
    try {
      setData(await list({}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const c = theme.colors;
  // タッチ幅(iPhone等)ではタップ領域を44pt以上・間隔8pxに広げる。PC幅は従来の大きさ。
  const windowSize = useWindowDimensions();
  // 幅の判定は「描画されている箱」基準。ポップオーバーは窓が広くても箱は最大420pxなので、
  // 窓幅で判定すると一覧とチャットペインが同じ狭い箱に横並びで押し込まれる。
  const width = layoutWidth(containerWidth, windowSize.width);
  const touch = width < 600;
  // 「ユーザー判断」「子スレ完了」は下部バーへ出したので、確認箱の中は PC も iPhone も3枚
  // (バグ報告・通知・優先順位)。下部バーから開いた画面はそのタブだけ。
  // 幅の判定は一覧とチャットの並べ方にだけ使う(PC幅なら横並び、狭い幅は全画面で重ねる)。
  const wide = isBoxWide(containerWidth, windowSize, layout);
  const compact = !wide;
  const { shownTab, tabs, selectTab } = useBoxTabs(mode);
  // カードチャットは画面を問わずこのペインに一本化した(旧・自由記述欄は廃止=2026-10-22ユーザー決定)。
  // ヘッダのポップオーバーも幅<720なので、ペインは全画面スライドとして重なる。
  // ペインの相手は2種: カードの投函元スレ(💬)と、優先順位の行の担当スレ(行タップ)。
  // どちらも同じペイン・同じURL面(`?card=` / `?thread=`)を使う(2026-10-23 ユーザー指示)。
  const { pane, open: openPane, close: closePane } = useCardPaneRoute(true);
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
      subject: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      badge: { color: c.accent, fontSize: 11 },
      link: { color: c.accent, fontSize: 13, textDecorationLine: "underline" as const },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: touch ? 8 : 6 },
      reporter: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
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
      badgeText: { color: c.accentForeground, fontSize: 10, fontWeight: "700" as const },
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
          const r = await permit({ agentId: item.agentId, requestId, actionId: optionId });
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
  });

  // 幅で置き場所が変わる(右に並べる/全画面で重ねる)ので、SplitLayout へ要素ごと渡す。
  // ペインの相手は投函元スレ(2026-10-22 ユーザー決定)。まだ一覧に来ていないカードは null。
  const paneAgentId = paneItem ? threadAgentId(paneItem) : paneThreadId;
  const openPaneThread = useMemo(() => {
    if (!paneAgentId || !navigation) return undefined;
    return () => navigation.openAgent({ agentId: paneAgentId });
  }, [paneAgentId, navigation]);
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
    content = <BugReportsView theme={theme} />;
  } else if (shownTab === "childdone") {
    content = <ChildDoneView theme={theme} navigation={navigation} />;
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
        {visible.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            styles={s}
            colors={c}
            open={openId === item.id}
            onToggle={toggle}
            onBackground={openBackground}
            onChoose={choose}
            onAnswer={answer}
            paneOpen={paneCardId === item.id}
            onOpenPane={openCard}
          />
        ))}
      </>
    );
  }

  return (
    <SplitLayout styles={s} compact={compact} pane={paneEl}>
      <View style={s.flex}>
        <ScrollView style={s.flex} contentContainerStyle={s.body}>
          {content}
        </ScrollView>
        {shownTab === "priority" ? <ChatDock colors={c} agentId={PRIORITY_CHAT_AGENT_ID} /> : null}
        {/* 下部バーから開いた画面(`mode` が box 以外)はタブ1枚だけなので、並びは出さない。 */}
        <TabStrip
          mode={mode}
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

type TabId = "items" | "bugs" | "childdone" | "notify" | "priority";

/**
 * 出すタブの並びと現在のタブ。
 * - `box`: 確認箱そのもの。下部バーへ移した2枚(ユーザー判断/子スレ完了)を外した3枚(PC も iPhone も同じ)
 * - `items`/`childdone`: 下部バーから開いた画面。そのタブだけを出す(並びは出さない)
 * 初期タブは、開いた画面ならそのタブ、確認箱ならバグ報告。
 */
function useBoxTabs(mode: "box" | "items" | "childdone"): {
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
  const shownTab: TabId = (valid && picked) || forcedTab || "bugs";
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
  mode: "box" | "items" | "childdone";
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
  { id: "childdone", label: "子スレ完了", Icon: CheckCircleIcon },
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
            childdone: r.childDone,
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
}: {
  prio: string;
  sortNew: boolean;
  showDone: boolean;
  legacyOff: boolean;
  count: number;
}): string {
  const parts = [
    prio === "all" ? "全て" : PRIORITY_LABEL[prio as keyof typeof PRIORITY_LABEL],
    sortNew ? "新しい順" : "優先度順",
    showDone ? "決定済み含む" : "",
    legacyOff ? "" : "旧形式含む",
    `${count}件`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** 元スレの agent ID。投函の thread_ref(paseo_agent)優先、無ければ承認待ちの agentId。 */
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

function OptionButton({
  item,
  option,
  styles,
  onChoose,
}: {
  item: ConfirmBoxItem;
  option: ConfirmBoxItem["options"][number];
  styles: Styles;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
}) {
  const rec = option.id === item.recommended;
  const press = useCallback(() => void onChoose(item, option.id), [onChoose, item, option.id]);
  return (
    <Pressable accessibilityRole="button" style={rec ? styles.btnRec : styles.btn} onPress={press}>
      <Text style={rec ? styles.btnRecText : styles.btnText}>
        {option.label}
        {rec && !option.label.includes("推奨") ? "(推奨)" : ""}
      </Text>
    </Pressable>
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
  paneOpen,
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
  /** このカードの会話ペインが開いているか。 */
  paneOpen: boolean;
  onOpenPane: (item: ConfirmBoxItem) => void;
}) {
  const [bgOpen, setBgOpen] = useState(false);
  const toggle = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const toggleBg = useCallback(() => {
    setBgOpen((v) => {
      if (!v) onBackground();
      return !v;
    });
  }, [onBackground]);
  const openPane = useCallback(() => onOpenPane(item), [onOpenPane, item]);
  const deny = useCallback(() => void onChoose(item, "__deny"), [item, onChoose]);
  const answer = useCallback(
    (answers: Record<string, string>) => void onAnswer(item, answers),
    [item, onAnswer],
  );
  const created = useMemo(() => formatCreated(item.ts), [item.ts]);
  const questions = item.questions ?? NO_QUESTIONS;
  return (
    <View style={styles.card}>
      {item.reporter ? <Text style={styles.reporter}>報告者: {item.reporter}</Text> : null}
      <Pressable accessibilityRole="button" onPress={toggle}>
        <Text style={styles.badge}>
          {PRIORITY_LABEL[item.priority]} · {KIND_LABEL[item.kind]}
          {item.state === "approved" ? " · 決定済み" : ""}
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
        <View style={styles.row}>
          {item.options.map((o) => (
            <OptionButton key={o.id} item={item} option={o} styles={styles} onChoose={onChoose} />
          ))}
        </View>
      )}
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
        <Text style={styles.created} numberOfLines={1}>
          {created}
        </Text>
      </View>
    </View>
  );
}
