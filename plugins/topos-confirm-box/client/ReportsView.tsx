/**
 * 「報告」タブ。各スレが `report_file_url.py` で出した報告書をまとめて並べ、未読・既読を付ける。
 * 開くと確認箱の中で本文(markdown と画像)が読め、読みながら報告元のスレへコメントを送れる。
 *
 * - 一覧: 未読を上に出し、既読は「既読も表示」で見る(消さない)。開いたら既読。同じ報告書が更新されたら未読に戻る。
 * - 本文: プラグインのサーバーが読んで返す(画像は data URI)ので、Mac Studio 以外(iPhone など)からも読める。
 *   Tailscale 経由の :8445 の URL も別に開ける。
 * - コメント: チャット入力欄と同じ部品(`PaneComposer`)。送ると返信ワーカーが報告元スレへ届ける
 *   (閉じていれば復元して届ける)。コメントと返事は同じ画面に残り、開き直しても消えない。
 *   報告元が分からない報告にはコメント欄を出さない。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Linking, Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import {
  cardChatListRpc,
  reportsAckAllRpc,
  reportsCommentRpc,
  reportsImageRpc,
  reportsListRpc,
  reportsOpenRpc,
} from "../shared/contract.js";
import type { ReportRowView } from "../shared/contract.js";
import { splitReportBody } from "../shared/report-body.js";
import { notifyBoxChanged } from "./events.js";
import { PaneComposer } from "./PaneComposer.js";
import { Markdown } from "./shared-projects/Markdown.js";
import { usePaneInputTools } from "./usePaneInputTools.js";

const REFRESH_MS = 30_000;
const CHAT_POLL_MS = 4_000;
const COMMENT_MAX = 4000;
const BUSY = { disabled: true } as const;
const IDLE = { disabled: false } as const;

interface ChatMsg {
  ts: number;
  role: "user" | "reply";
  by: string;
  text: string;
}

function formatTs(ts: number): string {
  if (!ts) return "日時なし";
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function describe(error: string | null, loaded: boolean, total: number, unread: number): string {
  if (error) return `取得できません: ${error}`;
  if (!loaded) return "読み込み中…";
  return `報告 ${total}件(未読 ${unread}件)`;
}

function origin(r: ReportRowView): string {
  return r.agentId ? `${r.agentName || "名前のないスレ"}` : "報告元不明";
}

// oxlint-disable-next-line eslint/complexity
export function ReportsView({ theme }: Pick<PluginHostProps, "theme">) {
  const list = useRpc(reportsListRpc);
  const ackAll = useRpc(reportsAckAllRpc);
  const [reports, setReports] = useState<ReportRowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [showRead, setShowRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setReports((await list({})).reports);
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
  const s = useMemo(
    () => ({
      root: { gap: 8 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      },
      cardRead: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
        opacity: 0.6,
      },
      title: {
        color: c.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flexShrink: 1,
        textWrap: "balance" as unknown as "auto",
        wordBreak: "auto-phrase" as unknown as "auto",
      },
      // 題名は文節の切れ目(phrase())でだけ折り返す。
      titlePhrase: {
        color: c.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flexShrink: 1,
        minWidth: 0,
        wordBreak: "keep-all" as unknown as "auto",
        overflowWrap: "anywhere" as unknown as "auto",
      },
      meta: {
        color: c.foregroundMuted,
        fontSize: 12,
        textWrap: "balance" as unknown as "auto",
        wordBreak: "auto-phrase" as unknown as "auto",
      },
      text: { color: c.foreground, fontSize: 13 },
      dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent },
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      btn: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
      },
      btnText: { color: c.accentForeground, fontSize: 13 },
      sub: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
      },
      subOff: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        opacity: 0.5,
      },
      subText: { color: c.foreground, fontSize: 13 },
    }),
    [c],
  );

  const unread = (reports ?? []).filter((r) => r.unread).length;
  const visible = (reports ?? []).filter((r) => showRead || r.unread);
  const toggleShowRead = useCallback(() => setShowRead((v) => !v), []);
  const closeDetail = useCallback(() => {
    setOpenId(null);
    notifyBoxChanged();
    void reload();
  }, [reload]);

  const markAll = useCallback(async () => {
    setBusy(true);
    try {
      setNotice((await ackAll({})).message);
      notifyBoxChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    void reload();
  }, [ackAll, reload]);

  const opened = openId ? (reports ?? []).find((r) => r.id === openId) : undefined;
  if (opened) {
    return <ReportDetail report={opened} theme={theme} styles={s} onBack={closeDetail} />;
  }

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Text style={s.meta}>
          {describe(error, reports !== null, reports?.length ?? 0, unread)}
        </Text>
        {unread > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={busy ? BUSY : IDLE}
            style={busy ? s.subOff : s.btn}
            onPress={busy ? undefined : markAll}
          >
            <Text style={busy ? s.subText : s.btnText}>{busy ? "処理中…" : "すべて既読"}</Text>
          </Pressable>
        ) : null}
      </View>
      {notice ? <Text style={s.meta}>{notice}</Text> : null}
      {(reports?.length ?? 0) > 0 ? (
        <View style={s.row}>
          <Pressable accessibilityRole="button" style={s.sub} onPress={toggleShowRead}>
            <Text style={s.subText}>{showRead ? "既読を隠す" : "既読も表示"}</Text>
          </Pressable>
        </View>
      ) : null}
      {reports && visible.length === 0 && !error ? (
        <Text style={s.meta}>
          {reports.length === 0 ? "報告はありません" : "未読の報告はありません"}
        </Text>
      ) : null}
      {visible.map((r) => (
        <ReportCard key={r.id} report={r} styles={s} onOpen={setOpenId} />
      ))}
    </View>
  );
}

type Styles = Record<string, object>;

function whoLabel(m: { role: string; by?: string }, reporter: string): string {
  if (m.role === "user") return "あなた";
  return m.by === "ack" ? "受領" : reporter;
}

/** 日本語の文節の切れ目に零幅スペースを入れる。keep-all と組み合わせ、熟語の途中で折り返さない。 */
function phrase(text: string): string {
  const Seg = (
    Intl as unknown as {
      Segmenter?: new (
        l: string,
        o: object,
      ) => { segment(t: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Seg) return text;
  return [...new Seg("ja", { granularity: "word" }).segment(text)]
    .map((x) => x.segment)
    .join("\u200b")
    .replace(/\u200b([、。，．）」])/g, "$1");
}

function ReportCard({
  report,
  styles,
  onOpen,
}: {
  report: ReportRowView;
  styles: Styles;
  onOpen: (id: string) => void;
}) {
  const press = useCallback(() => onOpen(report.id), [onOpen, report.id]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${report.unread ? "未読 " : ""}${report.title}`}
      style={report.unread ? styles.card : styles.cardRead}
      onPress={press}
    >
      <View style={styles.titleRow}>
        {report.unread ? <View style={styles.dot} testID="report-unread-dot" /> : null}
        <Text style={styles.titlePhrase} numberOfLines={2}>
          {phrase(report.title)}
        </Text>
      </View>
      <Text style={styles.meta}>
        {origin(report)} · {formatTs(report.ts)}
        {report.unread ? "" : " · 既読"}
      </Text>
    </Pressable>
  );
}

function ReportDetail({
  report,
  theme,
  styles,
  onBack,
}: {
  report: ReportRowView;
  theme: PluginHostProps["theme"];
  styles: Styles;
  onBack: () => void;
}) {
  const open = useRpc(reportsOpenRpc);
  const [body, setBody] = useState<{ ok: boolean; message: string; markdown: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setBody(null);
    open({ id: report.id })
      .then((r) => alive && setBody(r))
      .catch((e: unknown) => {
        if (alive)
          setBody({ ok: false, message: e instanceof Error ? e.message : String(e), markdown: "" });
      });
    return () => {
      alive = false;
    };
  }, [open, report.id, report.ts]);

  const c = theme.colors;
  const segments = useMemo(() => splitReportBody(body?.markdown ?? ""), [body]);
  const openUrl = useCallback(() => void Linking.openURL(report.url), [report.url]);
  const st = useMemo(
    () => ({
      wrap: { gap: 10 },
      body: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        gap: 10,
      },
      path: {
        color: c.foregroundMuted,
        fontSize: 11,
        overflowWrap: "anywhere" as unknown as "auto",
      },
      link: { color: "#3b82f6", fontSize: 12, textDecorationLine: "underline" as const },
    }),
    [c],
  );
  return (
    <View style={st.wrap}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" style={styles.sub} onPress={onBack}>
          <Text style={styles.subText}>← 一覧へ</Text>
        </Pressable>
        {report.url ? (
          <Pressable accessibilityRole="link" style={styles.sub} onPress={openUrl}>
            <Text style={styles.subText}>別のページで開く</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.titlePhrase}>{phrase(report.title)}</Text>
      <Text style={styles.meta}>
        {origin(report)} · {formatTs(report.ts)}
      </Text>
      <Text style={st.path} selectable>
        {report.path.replace(/^.*?\.local\/state\/toposai\//, "").replace(/([/_])/g, "$1\u200b")}
      </Text>
      <View style={st.body}>
        {body === null ? <Text style={styles.meta}>読み込み中…</Text> : null}
        {body && !body.ok ? <Text style={styles.meta}>{body.message}</Text> : null}
        {segments.map((seg) =>
          seg.t === "md" ? (
            <Markdown key={seg.id} source={seg.text} colors={c} />
          ) : (
            <ReportImage key={seg.id} path={seg.path} alt={seg.alt} colors={c} />
          ),
        )}
      </View>
      {report.agentId ? (
        <CommentArea report={report} theme={theme} styles={styles} />
      ) : (
        <Text style={styles.meta}>{phrase("報告元が分からないため、コメントは送れません")}</Text>
      )}
    </View>
  );
}

function ReportImage({
  path,
  alt,
  colors,
}: {
  path: string;
  alt: string;
  colors: PluginHostProps["theme"]["colors"];
}) {
  const fetchImage = useRpc(reportsImageRpc);
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(1.5);
  useEffect(() => {
    let alive = true;
    fetchImage({ path })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setUri(r.dataUri);
        else setFailed(true);
        return null;
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [fetchImage, path]);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  const onLoad = useCallback(
    (e: { nativeEvent?: { source?: { width: number; height: number } } }) => {
      const src = e.nativeEvent?.source;
      if (src && src.width > 0 && src.height > 0) setRatio(src.width / src.height);
    },
    [],
  );
  const st = useMemo(
    () => ({
      img: { width: "100%" as const, aspectRatio: ratio, backgroundColor: colors.surface2 },
      note: { color: colors.foregroundMuted, fontSize: 12 },
    }),
    [colors, ratio],
  );
  if (failed) return <Text style={st.note}>(画像を読めません: {path.split("/").pop()})</Text>;
  if (!uri) return <Text style={st.note}>画像を読み込み中…</Text>;
  return (
    <Image
      source={source}
      style={st.img}
      resizeMode="contain"
      accessibilityLabel={alt || path.split("/").pop()}
      onLoad={onLoad}
    />
  );
}

function CommentArea({
  report,
  theme,
  styles,
}: {
  report: ReportRowView;
  theme: PluginHostProps["theme"];
  styles: Styles;
}) {
  const chatList = useRpc(cardChatListRpc);
  const comment = useRpc(reportsCommentRpc);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const appendDictated = useCallback((said: string) => setText((cur) => cur + said), []);
  const baseTools = usePaneInputTools(appendDictated);
  // コメントは文字だけ(画像は送らない)。部品の「＋」は出さない。
  const tools = useMemo(() => ({ ...baseTools, attachSupported: false }), [baseTools]);
  const chatId = `report:${report.id}`;

  const refresh = useCallback(async () => {
    try {
      setMsgs((await chatList({ id: chatId, key: null })).messages);
    } catch {
      // 一時的な失敗は前回の履歴を残す
    }
  }, [chatList, chatId]);

  useEffect(() => {
    setText("");
    setMsgs([]);
    void refresh();
    const timer = setInterval(() => void refresh(), CHAT_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const sendable = text.trim().length > 0 && !sending;
  const send = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const r = await comment({ id: report.id, text });
      setNotice(r.ok ? "" : r.message);
      if (r.ok) setText("");
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [comment, refresh, report.id, sending, text]);

  const c = theme.colors;
  const st = useMemo(
    () => ({
      wrap: { gap: 8 },
      bubble: {
        alignSelf: "flex-start" as const,
        maxWidth: "92%" as const,
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        gap: 2,
      },
      bubbleMine: {
        alignSelf: "flex-end" as const,
        maxWidth: "92%" as const,
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        gap: 2,
      },
      who: { color: c.foregroundMuted, fontSize: 11 },
      // 入力欄は本文を読みながら使えるよう、画面の下に貼り付ける(スクロールの末尾で本文と重ならない)。
      dock: {
        position: "sticky" as unknown as "relative",
        bottom: 0,
        zIndex: 2,
        paddingBottom: 12,
      },
      hint: { color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 4 },
    }),
    [c],
  );
  return (
    <View style={st.wrap}>
      <Text style={styles.meta}>報告元「{origin(report)}」へコメント</Text>
      {msgs.map((m) => (
        <View
          key={`${m.ts}-${m.role}-${m.by}`}
          style={m.role === "user" ? st.bubbleMine : st.bubble}
        >
          <Text style={st.who}>
            {whoLabel(m, origin(report))} · {formatTs(m.ts)}
          </Text>
          <Text style={styles.text} selectable>
            {m.text}
          </Text>
        </View>
      ))}
      {notice ? <Text style={styles.meta}>{notice}</Text> : null}
      <View style={st.dock}>
        <PaneComposer
          colors={c}
          text={text}
          onChangeText={setText}
          tools={tools}
          disabledReason={sending ? "送信中…" : null}
          placeholder="コメントを書く"
          maxLength={COMMENT_MAX}
          sendable={sendable}
          onSend={send}
          testID="report-composer"
        />
      </View>
    </View>
  );
}
