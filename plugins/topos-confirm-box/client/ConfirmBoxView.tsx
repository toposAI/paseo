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
  const [grp, setGrp] = useState<string>("all");
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
      footBtn: { paddingHorizontal: touch ? 8 : 0, ...tap },
      footRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
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
      setDepth("chat");
      if (item.threadRef?.kind === "paseo_agent" && navigation) {
        navigation.openAgent({ agentId: item.threadRef.id });
      } else {
        setNotice("この項目には開けるチャット(投函元スレ)がありません");
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

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const i of data?.items ?? []) set.add(i.group ?? "(なし)");
    return [...set].sort();
  }, [data]);

  const visible = useMemo(() => {
    const rows = (data?.items ?? []).filter(
      (i) =>
        (showDone || i.state !== "approved") &&
        (prio === "all" || i.priority === prio) &&
        (grp === "all" || (i.group ?? "(なし)") === grp),
    );
    return sortNew ? [...rows].sort((a, b) => b.ts - a.ts) : rows;
  }, [data, showDone, prio, grp, sortNew]);

  const chip = (label: string, on: boolean, press: () => void) => (
    <Pressable key={label} accessibilityRole="button" style={on ? s.btnRec : s.btn} onPress={press}>
      <Text style={on ? s.btnRecText : s.btnText}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={s.root} contentContainerStyle={s.body}>
      <View style={s.row}>
        {chip("判断待ち", tab === "items", () => setTab("items"))}
        {chip("優先順位", tab === "priority", () => setTab("priority"))}
      </View>
      {tab === "priority" ? (
        <PriorityView styles={s} colors={c} />
      ) : (
        <>
          <View style={s.row}>
            {chip("全て", prio === "all", () => setPrio("all"))}
            {(Object.keys(PRIORITY_LABEL) as (keyof typeof PRIORITY_LABEL)[]).map((k) =>
              chip(PRIORITY_LABEL[k], prio === k, () => setPrio(k)),
            )}
          </View>
          <View style={s.row}>
            {chip("全グループ", grp === "all", () => setGrp("all"))}
            {groups.map((g) => chip(g, grp === g, () => setGrp(g)))}
          </View>
          <View style={s.row}>
            {chip(sortNew ? "新しい順" : "優先度順", true, () => setSortNew((v) => !v))}
            {chip("決定済みも表示", showDone, () => setShowDone((v) => !v))}
            <Text style={s.muted}>{visible.length}件</Text>
          </View>
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
              open={openId === item.id}
              onToggle={toggle}
              onBackground={openBackground}
              onChat={openChat}
              onChoose={choose}
            />
          ))}
        </>
      )}
    </ScrollView>
  );
}

type Styles = Record<string, object>;

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
        {rec ? "(推奨)" : ""}
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
  onChoose,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  open: boolean;
  onToggle: (id: string) => void;
  onBackground: () => void;
  onChat: (item: ConfirmBoxItem) => void;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
}) {
  const [bgOpen, setBgOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const toggle = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  const thread = useCallback(() => onChat(item), [onChat, item]);
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
        <Text style={styles.muted} numberOfLines={1}>
          {created}
        </Text>
        {item.background ? (
          <Pressable accessibilityRole="button" style={styles.footBtn} onPress={toggleBg}>
            <Text style={styles.link}>{bgOpen ? "▼ 背景を閉じる" : "▶ 背景"}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="このカードのチャット欄を開く"
          style={styles.footBtn}
          onPress={toggleChat}
        >
          <Text style={styles.link}>{chatOpen ? "▼ 💬" : "💬"}</Text>
        </Pressable>
      </View>
      {item.threadRef ? (
        <Pressable accessibilityRole="button" onPress={thread}>
          <Text style={styles.muted}>投函元のスレを開く</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
