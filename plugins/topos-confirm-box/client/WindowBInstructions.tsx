/**
 * 窓口Bのスレの右側の「ぼくの指示がいまどうなっているか」の面。
 *
 * 2026-10-30 08:08 ユーザー「とりあえず僕の指示をこのスレの右側で確認できるやつ、これ作ってよ / 指示が通ってるかわからん」
 * ／確認箱の回答「右側に一覧(PCは常時・iPhoneはボタンで開閉)で作る」。
 *
 * 2026-10-30 19:13 ユーザー「まとめて(タスク台帳を指示一覧へ1本にまとめる。タスク台帳の振り先・進み具合を
 * 指示一覧に移し、タスク台帳のボタンは消す)」: 各カードに項目ごとの振り先と進み具合(`routes`)を出す。
 *
 * 中身は `shared/contract.ts` の `windowbInstructionsRpc`(RPC の先の Python
 * `antigravity/utils/window_b_instruction_panel.py`)だけを読む。**ここから台帳・受信箱は書き換えない**。
 *
 * 出し方は**ワークスペース単位のパネル**(`locations: ["workspace","right"]`、`autoOpen`=窓口Bのスレ)。
 * PC は窓口Bのスレを開くと右カラムに出る(欄に別の物があれば隠さず後ろへ足す)。狭い画面は主ペイン
 * =全画面で、入口はヘッダのボタン「指示」(窓口Bのワークスペースでだけ出る)。押すたびにページの幅で
 * 置き場所を決め直す。一覧の読み出しが15分より前に止まっていれば、上部に「古い表示(時刻)」を赤で出す。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dimensions, Pressable, ScrollView, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  windowBInstructionsRpc,
  WINDOW_B_KIND,
  type WindowBInstruction,
  type WindowBInstructionsOutput,
} from "../shared/contract.js";
import {
  doneButtonText,
  emptyText,
  filterByMode,
  type ListMode,
  freshnessText,
  keepLastOnFailure,
  paneLocation,
  rowOrder,
  routeText,
  visibleRoutes,
  summarize,
  staleNotice,
  truncationNote,
} from "../shared/windowb-instructions.js";

export const WINDOWB_PANEL_ID = "window-b-instructions";
export const WINDOWB_PANEL_TITLE = "指示一覧";
export const WINDOWB_BUTTON_ID = "windowb-instructions";
const REFRESH_MS = 30_000;

/**
 * 一覧を開く。PC 幅は右カラム、狭い画面は主ペイン(全画面。戻ると元の会話に戻る)。
 * 開けなかった(レイアウト未読み込みなど)ときは false を返すだけで、押したのに何も起きない状態を作らないよう、
 * 呼び出し側が知らせを出す。
 */
export function openWindowBInstructions(
  openPanel: (id: string, options: { location: "right" | "workspace" }) => void,
  workspaceId: string,
  onError?: () => void,
): boolean {
  try {
    openPanel(WINDOWB_PANEL_ID, {
      location: paneLocation(Dimensions.get("window").width),
    });
  } catch (e) {
    console.warn("[topos] window B instructions were not opened", workspaceId, e);
    onError?.();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 一覧のデータ

/**
 * 一覧を30秒毎に引く。失敗したときは**前回の一覧を残して**知らせだけ出す(取れない瞬間に空にすると、
 * 指示が消えた=指示が通った、と読めてしまう)。
 */
function useInstructions(): {
  data: WindowBInstructionsOutput | null;
  error: string | null;
} {
  const list = useRpc(windowBInstructionsRpc);
  const [state, setState] = useState<{
    data: WindowBInstructionsOutput | null;
    error: string | null;
  }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    let alive = true;
    const apply = (
      next: { ok: true; data: WindowBInstructionsOutput } | { ok: false; error: string },
    ) => {
      if (alive) setState((prev) => keepLastOnFailure(prev.data, next));
    };
    const tick = () =>
      list({ limit: 100 })
        .then((data) => apply({ ok: true, data }))
        .catch((e: unknown) =>
          apply({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
    void tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [list]);
  return state;
}

// ---------------------------------------------------------------- 行

const ALERT_TEXT: Record<string, string> = {
  no_reply: "送ってから10分、返事が無い",
  unassigned: "担当が1時間たっても決まっていない",
};

/** 状態の文字の色。赤=返事なし/担当未定(alert)、橙=台帳にない・未投函・届いたか不明・知らない語、他は状態ごと。 */
function kindColor(c: PluginTheme["colors"], kind: string, urgent: boolean, warn: boolean): string {
  if (urgent) return c.statusDanger;
  if (warn) return c.statusWarning;
  if (kind === WINDOW_B_KIND.unknown || kind === WINDOW_B_KIND.noReply) return c.statusWarning;
  if (kind === WINDOW_B_KIND.reportPending) return c.statusWarning;
  if (kind === WINDOW_B_KIND.done) return c.statusSuccess;
  if (kind === WINDOW_B_KIND.judgment) return c.accent;
  return c.foreground;
}

/** 知っている語か(Python が語を足したら、読めなくするのではなく橙で出す)。 */
function isKnownKind(kind: string): boolean {
  return (Object.values(WINDOW_B_KIND) as string[]).includes(kind);
}

/** 1行。赤=返事なし/担当未定、橙=台帳に載っていない。それ以外は状態の文字で見せる。 */
function Row({ item, colors: c }: { item: WindowBInstruction; colors: PluginTheme["colors"] }) {
  // 押すと発言の逐語が開く(カードは1行要約。要約が意味を取り違えていても逐語で確かめられる)
  const [open, setOpen] = useState(false);
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);
  const a11yState = useMemo(() => ({ expanded: open }), [open]);
  const routes = useMemo(() => visibleRoutes(item.routes, open), [item.routes, open]);
  const urgent = item.alert !== null;
  const warn = item.warn !== null || !isKnownKind(item.kind);
  const accent = kindColor(c, item.kind, urgent, warn);
  const s = useMemo(
    () => ({
      card: {
        backgroundColor: c.surface1,
        borderColor: urgent ? c.statusDanger : c.border,
        borderLeftColor: accent,
        borderWidth: urgent || warn ? 2 : 1,
        borderLeftWidth: 4,
        borderRadius: 8,
        padding: 8,
        gap: 3,
      },
      head: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      time: { color: c.foregroundMuted, fontSize: 12 },
      kind: { color: accent, fontSize: 12, fontWeight: "700" as const },
      title: { color: c.foreground, fontSize: 14 },
      meta: { color: c.foregroundMuted, fontSize: 12 },
      alert: { color: c.statusDanger, fontSize: 12, fontWeight: "600" as const },
      verbatim: {
        color: c.foregroundMuted,
        fontSize: 12,
        borderTopColor: c.border,
        borderTopWidth: 1,
        paddingTop: 4,
      },
    }),
    [c, accent, urgent, warn],
  );
  return (
    <Pressable
      style={s.card}
      testID={`windowb-row-${item.key}`}
      accessibilityRole="button"
      accessibilityState={a11yState}
      onPress={toggleOpen}
    >
      <View style={s.head}>
        <Text style={s.time}>{item.atText}</Text>
        <Text style={s.kind}>{item.kind}</Text>
      </View>
      <Text style={s.title} numberOfLines={open ? undefined : 2}>
        {item.title}
      </Text>
      <Text style={s.meta}>
        {item.assigneeText}
        {item.detail ? ` ・ ${item.detail}` : ""}
      </Text>
      {routes.shown.map((r) => (
        <Text
          key={`${r.no}-${r.summary}`}
          style={s.meta}
          testID={`windowb-route-${item.key}-${r.no}`}
        >
          {routeText(r)}
        </Text>
      ))}
      {routes.hidden > 0 ? <Text style={s.meta}>ほか{routes.hidden}項目(押すと全部)</Text> : null}
      {item.alert ? (
        <Text style={s.alert}>{ALERT_TEXT[item.alert] ?? item.alertReason}</Text>
      ) : null}
      {open ? (
        <Text style={s.verbatim} selectable testID={`windowb-verbatim-${item.key}`}>
          {item.text}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------- 一覧の面

/**
 * 一覧の面。置き場所はホストが決めるので、右カラムでも主ペインでも同じ一覧を出す(読み取り専用)。
 */
export function WindowBInstructionsPanel({ theme }: { theme: PluginTheme }) {
  const { data, error } = useInstructions();
  // 「古い表示」は時間で変わるので、1分ごとに時計を進めて見直す(引けている間は普通は出ない)。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // 既定は完了を隠す。「完了だけ」ボタンで直近3日の完了だけを見せる(2026-10-30 ユーザー指示)
  const [mode, setMode] = useState<ListMode>("active");
  const rows = useMemo(() => (data ? filterByMode(rowOrder(data.items), mode) : []), [data, mode]);
  const toggleMode = useCallback(() => setMode((m) => (m === "done" ? "active" : "done")), []);
  const doneCount = data ? data.items.filter((i) => i.kind === WINDOW_B_KIND.done).length : 0;
  const c = theme.colors;
  const s = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: c.surface0 },
      head: { padding: 10, gap: 4, borderBottomColor: c.border, borderBottomWidth: 1 },
      headRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      headTitle: { color: c.foreground, fontSize: 14, fontWeight: "700" as const },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      notice: { color: c.statusWarning, fontSize: 12 },
      error: { color: c.statusDanger, fontSize: 12 },
      stale: {
        color: c.statusDanger,
        backgroundColor: c.surface1,
        borderColor: c.statusDanger,
        borderWidth: 2,
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 8,
        fontSize: 14,
        fontWeight: "700" as const,
      },
      list: { padding: 10, gap: 8 },
      toggle: {
        alignSelf: "flex-start" as const,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingVertical: 4,
        paddingHorizontal: 10,
        backgroundColor: c.surface1,
      },
      toggleText: { color: c.foreground, fontSize: 13 },
    }),
    [c],
  );
  // 一覧の読み出し時刻(`generatedAt`)から15分たっていたら、一覧の一番上に目立つ色で出す。時計は1分ごとに
  // 進めて見直す(引けている間は普通は出ない)。
  const stale = data ? staleNotice(data, now) : null;
  let notice: React.ReactElement | null = null;
  if (error) {
    notice = (
      <Text style={s.error}>
        いま読めません({error}){data ? "。下は前回読めた内容です" : ""}
      </Text>
    );
  } else if (data && data.notices.length > 0) {
    notice = <Text style={s.notice}>{data.notices.join(" / ")}</Text>;
  }
  const truncated = data ? truncationNote(data) : null;
  const truncate = truncated ? <Text style={s.muted}>{truncated}</Text> : null;
  return (
    <View style={s.root} testID="windowb-instructions">
      {stale ? (
        <Text style={s.stale} testID="windowb-stale" accessibilityLiveRegion="polite">
          {stale}
        </Text>
      ) : null}
      <View style={s.head}>
        <View style={s.headRow}>
          <Text style={s.headTitle}>指示一覧</Text>
          <Text style={s.muted}>{summarize(data)}</Text>
        </View>
        {data ? <Text style={s.muted}>{freshnessText(data)}</Text> : null}
        {data && data.warns > 0 ? (
          <Text style={s.muted}>
            橙=受信箱には届いているが、依頼台帳に載っていないか、判断が確認箱に投函されていない(状態を引けない)
          </Text>
        ) : null}
        <Pressable
          style={s.toggle}
          testID="windowb-done-toggle"
          accessibilityRole="button"
          onPress={toggleMode}
        >
          <Text style={s.toggleText}>{doneButtonText(mode, doneCount)}</Text>
        </Pressable>
        {truncate}
        {notice}
      </View>
      <ScrollView contentContainerStyle={s.list}>
        {!data && !error ? <Text style={s.muted}>読み込み中…</Text> : null}
        {data && rows.length === 0 ? <Text style={s.muted}>{emptyText(mode)}</Text> : null}
        {rows.map((item) => (
          <Row key={item.key} item={item} colors={c} />
        ))}
      </ScrollView>
    </View>
  );
}
