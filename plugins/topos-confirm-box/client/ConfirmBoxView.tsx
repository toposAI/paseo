/**
 * 統合確認箱の画面本体。全画面(サイドバーから)とヘッダボタンのポップオーバーで共用する。
 *
 * v1: 一覧(優先度順)・展開・背景の4段階開示・選択して決定を記録・Paseo承認待ちへの応答。
 * 決定の記録は押した時だけ(自動では何も決めない)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
} from "../shared/contract.js";
import { notifyBoxChanged } from "./events.js";
import { CardChat } from "./CardChat.js";
import { PriorityView } from "./PriorityView.js";
import { InboxIcon, ListIcon } from "./Icons.js";
import { ChatDock, PRIORITY_CHAT_AGENT_ID } from "./ChatDock.js";
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
  const [tab, setTab] = useState<"items" | "priority">("items");
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
      tabBtn: {
        minWidth: 72,
        minHeight: 56,
        paddingHorizontal: 16,
        alignItems: "center" as const,
        justifyContent: "center" as const,
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

  const visible = useMemo(() => {
    const rows = (data?.items ?? []).filter(
      (i) => (showDone || i.state !== "approved") && (prio === "all" || i.priority === prio),
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

  return (
    <View style={s.root}>
      <ScrollView style={s.flex} contentContainerStyle={s.body}>
        {tab === "priority" ? (
          <PriorityView styles={s} colors={c} />
        ) : (
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
            {data && visible.length === 0 ? (
              <Text style={s.muted}>判断待ちはありません</Text>
            ) : null}
            {visible.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                styles={s}
                open={openId === item.id}
                onToggle={toggle}
                onBackground={openBackground}
                onChat={openChat}
                canNavigate={Boolean(navigation)}
                onChoose={choose}
              />
            ))}
          </>
        )}
      </ScrollView>
      {tab === "priority" ? <ChatDock colors={c} agentId={PRIORITY_CHAT_AGENT_ID} /> : null}
      <View style={s.bottomBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {TABS.map((tb) => (
            <TabButton
              key={tb.id}
              tab={tb}
              on={tab === tb.id}
              styles={s}
              accent={c.accent}
              muted={c.foregroundMuted}
              onSelect={setTab}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const TABS: { id: "items" | "priority"; label: string; Icon: typeof InboxIcon }[] = [
  { id: "items", label: "判断待ち", Icon: InboxIcon },
  { id: "priority", label: "優先順位", Icon: ListIcon },
];

function TabButton({
  tab,
  on,
  styles,
  accent,
  muted,
  onSelect,
}: {
  tab: (typeof TABS)[number];
  on: boolean;
  styles: Styles;
  accent: string;
  muted: string;
  onSelect: (id: "items" | "priority") => void;
}) {
  const press = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={tab.label}
      accessibilityState={on ? SELECTED : UNSELECTED}
      style={styles.tabBtn}
      onPress={press}
    >
      <tab.Icon color={on ? accent : muted} size={24} />
    </Pressable>
  );
}

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

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
  open,
  onToggle,
  onBackground,
  onChat,
  canNavigate,
  onChoose,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  open: boolean;
  onToggle: (id: string) => void;
  onBackground: () => void;
  onChat: (item: ConfirmBoxItem) => void;
  canNavigate: boolean;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
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
  const created = useMemo(() => formatCreated(item.ts), [item.ts]);
  return (
    <View style={styles.card}>
      {item.reporter ? <Text style={styles.reporter}>報告者: {item.reporter}</Text> : null}
      <Pressable accessibilityRole="button" onPress={toggle}>
        <Text style={styles.badge}>
          {PRIORITY_LABEL[item.priority]} · {KIND_LABEL[item.kind]}
          {item.state === "approved" ? " · 決定済み" : ""}
        </Text>
        <Text style={styles.subject}>{item.subject}</Text>
        {open ? null : (
          <Text style={styles.muted} numberOfLines={2}>
            {item.summary}
          </Text>
        )}
      </Pressable>
      <View style={styles.row}>
        {item.options.map((o) => (
          <OptionButton key={o.id} item={item} option={o} styles={styles} onChoose={onChoose} />
        ))}
      </View>
      {open ? <Text style={styles.text}>{item.summary}</Text> : null}
      {bgOpen && item.background ? <Text style={styles.text}>{item.background}</Text> : null}
      {chatOpen ? <CardChat itemKey={item.key ?? undefined} styles={styles} /> : null}
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
