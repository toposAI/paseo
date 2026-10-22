/**
 * 統合確認箱の画面本体。全画面(サイドバーから)とヘッダボタンのポップオーバーで共用する。
 *
 * v1: 一覧(優先度順)・展開・背景の4段階開示・選択して決定を記録・Paseo承認待ちへの応答。
 * 決定の記録は押した時だけ(自動では何も決めない)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  confirmBoxCountRpc,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
  isJudgmentItem,
} from "../shared/contract.js";
import { onBoxChanged, notifyBoxChanged } from "./events.js";
import { PriorityView } from "./PriorityView.js";
import { BugReportsView } from "./BugReportsView.js";
import { ChildDoneView } from "./ChildDoneView.js";
import { NotificationsView } from "./NotificationsView.js";
import { BellIcon, BugIcon, CheckCircleIcon, InboxIcon, ListIcon } from "./Icons.js";
import { ChatDock, PRIORITY_CHAT_AGENT_ID } from "./ChatDock.js";
import { CardChat } from "./CardChat.js";
import { QuestionAnswer } from "./QuestionAnswer.js";
import type { QuestionAnswerColors } from "./QuestionAnswer.js";
import type { ConfirmBoxDepth, ConfirmBoxItem, ConfirmBoxListOutput } from "../shared/contract.js";

const REFRESH_MS = 30_000;

export function ConfirmBoxView({
  theme,
  navigation,
}: Pick<PluginHostProps, "theme"> & {
  navigation?: { openAgent: (input: { agentId: string; serverId?: string }) => void };
}) {
  const list = useRpc(confirmBoxListRpc);
  const decide = useRpc(confirmBoxDecideRpc);
  const permit = useRpc(confirmBoxPermitRpc);
  const [data, setData] = useState<ConfirmBoxListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [depth, setDepth] = useState<ConfirmBoxDepth>("list");
  const [notice, setNotice] = useState<string>("");
  const [tab, setTab] = useState<TabId>("items");
  const counts = useBadgeCounts();
  const [prio, setPrio] = useState<string>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortNew, setSortNew] = useState(false);
  const [showDone, setShowDone] = useState(false);

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
  const { width } = useWindowDimensions();
  const touch = width < 600;
  const s = useMemo(() => {
    const tap = touch ? { minHeight: 44, justifyContent: "center" as const } : {};
    return {
      root: { flex: 1, backgroundColor: c.surface0 },
      flex: { flex: 1 },
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
  const openChat = useCallback(
    (item: ConfirmBoxItem) => {
      const agentId = threadAgentId(item);
      if (agentId && navigation) {
        setDepth("chat");
        navigation.openAgent({ agentId });
      } else {
        setNotice(threadDisabledReason(item, Boolean(navigation)) ?? "スレを開けません");
      }
    },
    [navigation],
  );

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

  // 判断タブは判断だけ(選択肢のある項目・Paseo承認待ち)。通知・バグ報告・完了報告は専用タブにだけ出す。
  const visible = useMemo(() => {
    const rows = (data?.items ?? []).filter(
      (i) =>
        isJudgmentItem(i) &&
        (showDone || i.state !== "approved") &&
        (prio === "all" || i.priority === prio),
    );
    return sortNew ? [...rows].sort((a, b) => b.ts - a.ts) : rows;
  }, [data, showDone, prio, sortNew]);

  const chip = (label: string, on: boolean, press: () => void) => (
    <Pressable key={label} accessibilityRole="button" style={on ? s.btnRec : s.btn} onPress={press}>
      <Text style={on ? s.btnRecText : s.btnText}>{label}</Text>
    </Pressable>
  );

  const toggleFilter = useCallback(() => setFilterOpen((v) => !v), []);
  const filterSummary = `${prio === "all" ? "全て" : PRIORITY_LABEL[prio as keyof typeof PRIORITY_LABEL]} · ${sortNew ? "新しい順" : "優先度順"}${showDone ? " · 決定済み含む" : ""} · ${visible.length}件`;

  // タブごとの中身。入れ子の三項を JSX へ書かないよう if 連鎖で組み立てる。
  let content: ReactNode;
  if (tab === "priority") {
    content = <PriorityView styles={s} colors={c} />;
  } else if (tab === "bugs") {
    content = <BugReportsView theme={theme} />;
  } else if (tab === "childdone") {
    content = <ChildDoneView theme={theme} navigation={navigation} />;
  } else if (tab === "notify") {
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
            onChat={openChat}
            canNavigate={Boolean(navigation)}
            onChoose={choose}
            onAnswer={answer}
          />
        ))}
      </>
    );
  }

  return (
    <View style={s.root}>
      <ScrollView style={s.flex} contentContainerStyle={s.body}>
        {content}
      </ScrollView>
      {tab === "priority" ? <ChatDock colors={c} agentId={PRIORITY_CHAT_AGENT_ID} /> : null}
      <View style={s.bottomBar}>
        {/* `flexGrow:1` で5枚を等分。狭い幅では等分を保ったまま横スクロールへ落ちる。 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.tabStrip}
        >
          {TABS.map((tb) => (
            <TabButton
              key={tb.id}
              tab={tb}
              on={tab === tb.id}
              styles={s}
              accent={c.accent}
              muted={c.foregroundMuted}
              count={counts[tb.id] ?? 0}
              onSelect={setTab}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

type TabId = "items" | "bugs" | "childdone" | "notify" | "priority";

const TABS: { id: TabId; label: string; Icon: typeof InboxIcon }[] = [
  { id: "items", label: "判断待ち", Icon: InboxIcon },
  { id: "bugs", label: "Toposバグ報告", Icon: BugIcon },
  { id: "childdone", label: "子スレ完了報告", Icon: CheckCircleIcon },
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
        // 件数が取れない時はバッジを出さない(一覧そのものは各タブが別途読む)
        if (alive) setN({});
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

/** 元スレの agent ID。投函の thread_ref(paseo_agent)優先、無ければ承認待ちの agentId。 */
function threadAgentId(item: ConfirmBoxItem): string | null {
  if (item.threadRef?.kind === "paseo_agent") return item.threadRef.id;
  return item.agentId;
}

/** 押せない理由。押せるなら null。 */
function threadDisabledReason(item: ConfirmBoxItem, canNavigate: boolean): string | null {
  if (!threadAgentId(item)) return "元スレを特定できません(投函に thread_ref がありません)";
  if (!canNavigate) return "この画面からはスレを開けません(全画面の確認箱から開いてください)";
  return null;
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
  onChat,
  canNavigate,
  onChoose,
  onAnswer,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  colors: QuestionAnswerColors;
  open: boolean;
  onToggle: (id: string) => void;
  onBackground: () => void;
  onChat: (item: ConfirmBoxItem) => void;
  canNavigate: boolean;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
  onAnswer: (item: ConfirmBoxItem, answers: Record<string, string>) => Promise<void>;
}) {
  const [bgOpen, setBgOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const toggle = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const thread = useCallback(() => onChat(item), [onChat, item]);
  const threadReason = threadDisabledReason(item, canNavigate);
  const toggleBg = useCallback(() => {
    setBgOpen((v) => {
      if (!v) onBackground();
      return !v;
    });
  }, [onBackground]);
  const toggleChat = useCallback(() => setChatOpen((v) => !v), []);
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
      {chatOpen ? <CardChat itemId={item.id} itemKey={item.key} styles={styles} /> : null}
      <View style={styles.footRow}>
        {item.background ? (
          <Pressable accessibilityRole="button" style={styles.footBtn} onPress={toggleBg}>
            <Text style={styles.footText}>{bgOpen ? "▼背景" : "▶背景"}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="このカードのチャット欄を開く"
          style={styles.footBtn}
          onPress={toggleChat}
        >
          <Text style={styles.footText}>{chatOpen ? "▼💬" : "💬"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="元のスレに戻る"
          style={threadReason === null ? styles.footBtn : styles.footBtnOff}
          onPress={thread}
        >
          <Text style={styles.footText}>↩ スレ</Text>
        </Pressable>
        <Text style={styles.created} numberOfLines={1}>
          {created}
        </Text>
      </View>
      {threadReason && open ? <Text style={styles.muted}>{threadReason}</Text> : null}
    </View>
  );
}
