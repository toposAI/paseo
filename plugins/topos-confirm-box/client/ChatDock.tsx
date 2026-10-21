/**
 * 優先順位ページ右下のフローティング会話。吹き出しボタンで展開し、専用の会話スレッド
 * (agent)へ送信してそのスレの応答を表示する。
 *
 * Paseo本体の composer はプラグインAPIに公開されていないため、同じ操作感の簡易入力欄を自前で持つ。
 * 送信先 agent ID はバックエンド確定後に `PRIORITY_CHAT_AGENT_ID` へ入れる(未設定の間は送れず理由を表示)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { BubbleIcon } from "./Icons.js";
import { notifyBoxChanged } from "./events.js";

/** このページ専用の会話スレッドの agent ID。総司令から連絡があり次第ここへ設定する。 */
export const PRIORITY_CHAT_AGENT_ID: string | null = "887a6133-01de-498a-be7e-0262c61e0bc9";

interface ChatLine {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface DockColors {
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  foreground: string;
  foregroundMuted: string;
  accent: string;
  accentForeground: string;
}

interface TimelineItemLike {
  type?: string;
  text?: string;
}

function lineFromItem(item: TimelineItemLike | undefined, id: string): ChatLine | null {
  if (!item?.text) return null;
  if (item.type === "user_message") return { id, role: "user", text: item.text };
  if (item.type === "assistant_message") return { id, role: "assistant", text: item.text };
  return null;
}

/** assistant の連続ストリーム断片は直前の assistant 行へ連結する。 */
function appendLine(lines: ChatLine[], next: ChatLine): ChatLine[] {
  const last = lines[lines.length - 1];
  if (last && last.role === "assistant" && next.role === "assistant") {
    return [...lines.slice(0, -1), { ...last, text: last.text + next.text }];
  }
  return [...lines, next];
}

export function ChatDock({ colors, agentId }: { colors: DockColors; agentId: string | null }) {
  const hosts = useHosts();
  const serverId = hosts.find((h) => h.status === "online")?.serverId ?? null;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [notice, setNotice] = useState("");
  const seq = useRef(0);

  const reason = useMemo(() => {
    if (!agentId) return "会話先のスレッドが未設定です(準備中)";
    if (!serverId) return "ホストに接続できません";
    return null;
  }, [agentId, serverId]);

  useEffect(() => {
    if (!open || !agentId || !serverId) return undefined;
    const handle = getPaseoClient(serverId).agents.ref(agentId);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 履歴(開き直しても会話が残る)。失敗しても会話自体は続けられる。
    handle.timeline
      .refetch({ limit: 30 })
      .then((res) => {
        if (!alive) return null;
        const past: ChatLine[] = [];
        (res.entries ?? []).forEach((entry, idx) => {
          const line = lineFromItem(entry.item as TimelineItemLike, `h${idx}`);
          if (line) past.push(line);
        });
        setLines((cur) => (cur.length === 0 ? past : cur));
        return null;
      })
      .catch(() => {});
    const sub = handle.timeline.subscribe((evt) => {
      if (!alive) return;
      const ev = (evt as { event?: { type?: string; item?: TimelineItemLike } }).event;
      if (ev?.type !== "timeline") return;
      // ユーザー発言は送信時に表示済み(二重表示を避ける)。
      if (ev.item?.type !== "assistant_message") return;
      seq.current += 1;
      const line = lineFromItem(ev.item, `s${seq.current}`);
      if (line) setLines((cur) => appendLine(cur, line));
      // 台帳が更新されている可能性があるので、少し待って順位を再読込させる。
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => notifyBoxChanged(), 800);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      sub();
    };
  }, [open, agentId, serverId]);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || !agentId || !serverId) return;
    setText("");
    seq.current += 1;
    setLines((cur) => [...cur, { id: `u${seq.current}`, role: "user", text: t }]);
    try {
      await getPaseoClient(serverId).agents.ref(agentId).send(t);
      setNotice("");
    } catch (e) {
      setNotice(`送れません: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [text, agentId, serverId]);

  const st = useMemo(
    () => ({
      fab: {
        position: "absolute" as const,
        right: 16,
        bottom: 76,
        width: 52,
        height: 52,
        borderRadius: 26,
        backgroundColor: colors.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      panel: {
        position: "absolute" as const,
        left: 12,
        right: 12,
        bottom: 140,
        maxHeight: 420,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 10,
        gap: 8,
      },
      list: { maxHeight: 280 },
      listBody: { gap: 6 },
      mine: {
        alignSelf: "flex-end" as const,
        backgroundColor: colors.accent,
        borderRadius: 10,
        padding: 8,
        maxWidth: "85%" as const,
      },
      theirs: {
        alignSelf: "flex-start" as const,
        backgroundColor: colors.surface2,
        borderRadius: 10,
        padding: 8,
        maxWidth: "85%" as const,
      },
      mineText: { color: colors.accentForeground, fontSize: 13 },
      theirsText: { color: colors.foreground, fontSize: 13 },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      inputRow: { flexDirection: "row" as const, gap: 8, alignItems: "flex-end" as const },
      input: {
        flex: 1,
        minHeight: 44,
        maxHeight: 120,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
      sendBtn: {
        minHeight: 44,
        minWidth: 56,
        borderRadius: 8,
        backgroundColor: colors.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      sendText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
    }),
    [colors],
  );

  return (
    <>
      {open ? (
        <View style={st.panel}>
          <ScrollView style={st.list} contentContainerStyle={st.listBody}>
            {lines.length === 0 ? (
              <Text style={st.muted}>{reason ?? "メッセージを送ると返答が表示されます"}</Text>
            ) : null}
            {lines.map((l) => (
              <View key={l.id} style={l.role === "user" ? st.mine : st.theirs}>
                <Text style={l.role === "user" ? st.mineText : st.theirsText}>{l.text}</Text>
              </View>
            ))}
          </ScrollView>
          {notice ? <Text style={st.muted}>{notice}</Text> : null}
          <View style={st.inputRow}>
            <TextInput
              style={st.input}
              value={text}
              onChangeText={setText}
              multiline
              editable={reason === null}
              placeholder={reason ?? "メッセージを入力"}
              placeholderTextColor={colors.foregroundMuted}
            />
            <Pressable
              accessibilityRole="button"
              style={st.sendBtn}
              onPress={send}
              disabled={reason !== null}
            >
              <Text style={st.sendText}>送信</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="会話を開く"
        style={st.fab}
        onPress={toggle}
      >
        <BubbleIcon color={colors.accentForeground} size={26} />
      </Pressable>
    </>
  );
}
