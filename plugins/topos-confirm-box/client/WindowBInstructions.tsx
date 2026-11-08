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
import { Dimensions, Platform, Pressable, ScrollView, Text, View } from "react-native";
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
  type ListMode,
  hiddenAutoText,
  keepLastOnFailure,
  NOTICE_MAX_LINES,
  ownerLine,
  stageText,
  noticeLines,
  joinTitleWords,
  paneLocation,
  routeText,
  rowTitle,
  visibleRoutes,
  visibleRows,
  headCountText,
  staleNotice,
  truncationNote,
  WIDE_MIN_WIDTH,
} from "../shared/windowb-instructions.js";

/**
 * 末尾の「11/07 16:32(16時間前)」が、日付と時刻の間や括弧の前で折れて数文字だけ次の行に
 * 残らないよう、日時の部分ごと1語に繋ぐ(U+2060)。日時が無い行は括弧の中だけを繋ぐ。
 */
function keepAgoTogether(line: string): string {
  // \u672b\u5c3e\u306b\u7a7a\u767d\u304c\u4ed8\u304f\u884c\u3067\u3082\u540c\u3058\u3088\u3046\u306b\u6271\u3046(\u672b\u5c3e\u7a7a\u767d\u3067\u5224\u5b9a\u3092\u5916\u3059\u3068\u3001\u65e5\u4ed8\u3068\u6642\u523b\u306e\u9593\u304c
  // \u305d\u306e\u307e\u307e\u6298\u308c\u3066\u300c11/08\u300d/\u300c09:13(19\u5206\u524d)\u300d\u306b\u5272\u308c\u308b\u884c\u304c\u6b8b\u308b)\u3002
  const dated = line.match(/(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2}(?:\([^)]*\))?)\s*$/);
  if (dated) {
    const start = line.length - dated[0].length;
    const head = line.slice(0, start);
    // \u533a\u5207\u308a\u306f U+00A0(NBSP)\u306b\u3059\u308b\u3002\u3053\u306e\u884c\u306f white-space: pre-wrap \u306a\u306e\u3067\u3001\u666e\u901a\u306e\u7a7a\u767d\u3060\u3068
    // U+2060 \u3092\u631f\u3093\u3067\u3082\u7a7a\u767d\u306e\u76f4\u5f8c\u3067\u6539\u884c\u3067\u304d\u3066\u3057\u307e\u3046(\u5b9f\u6e2c: \u534a\u89d2\u30b9\u30da\u30fc\u30b9\u306e\u5f8c\u308d\u3067\u5272\u308c\u305f)\u3002
    const chunk = `${dated[1]}\u00a0${dated[2]}`;
    return head + Array.from(chunk).join("\u2060");
  }
  // \u65e5\u6642\u304c\u7121\u3044\u884c(\u62ec\u5f27\u3060\u3051)\u306f\u3001\u62ec\u5f27\u306e\u4e2d\u3092\u7e4b\u3044\u3067\u9589\u3058\u62ec\u5f27\u3060\u3051\u6b21\u884c\u306b\u843d\u3061\u306a\u3044\u3088\u3046\u306b\u3059\u308b\u3002
  const i = line.trimEnd().lastIndexOf("(");
  if (i < 0 || !line.trimEnd().endsWith(")")) return line;
  return line.slice(0, i) + "\u2060" + Array.from(line.slice(i)).join("\u2060");
}

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

/** 閉じたカードの状態語に添える、赤の短い理由(長い文は開いたときだけ)。 */
const ALERT_SHORT: Record<string, string> = { no_reply: "返事なし", unassigned: "担当未定" };

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

/** 枠の色: 赤(要対応) > 橙(止まっている) > 通常。 */
function borderOf(c: PluginTheme["colors"], urgent: boolean, stalled: boolean): string {
  if (urgent) return c.statusDanger;
  return stalled ? c.statusWarning : c.border;
}

/** 知っている語か(Python が語を足したら、読めなくするのではなく橙で出す)。 */
function isKnownKind(kind: string): boolean {
  return (Object.values(WINDOW_B_KIND) as string[]).includes(kind);
}

/** 1行。赤=返事なし/担当未定、橙=台帳に載っていない。それ以外は状態の文字で見せる。 */
function Row({
  item,
  colors: c,
  now,
}: {
  item: WindowBInstruction;
  colors: PluginTheme["colors"];
  now: number;
}) {
  // 既定は日付とタイトル(1行)だけ。押すと全文・振り先と進み具合・赤の理由が開き、もう一度押すと閉じる。
  // 開閉はカードごとの状態で、30秒ごとの引き直しでは閉じない(key=item.key で同じカードを引き継ぐ)。
  const [open, setOpen] = useState(false);
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);
  const a11yState = useMemo(() => ({ expanded: open }), [open]);
  const routes = useMemo(() => visibleRoutes(item.routes, open), [item.routes, open]);
  const urgent = item.alert !== null;
  const warn = item.warn !== null || !isKnownKind(item.kind);
  // 止まっている(進行中で長く動きがない)は橙の太枠で目立たせる。完了は止まりに数えない。
  const stalled = item.stalled === true && item.kind !== WINDOW_B_KIND.done;
  const accent =
    stalled && !urgent && !warn ? c.statusWarning : kindColor(c, item.kind, urgent, warn);
  const s = useMemo(
    () => ({
      card: {
        backgroundColor: c.surface1,
        borderColor: borderOf(c, urgent, stalled),
        borderLeftColor: accent,
        borderWidth: urgent || warn || stalled ? 2 : 1,
        borderLeftWidth: 4,
        borderRadius: 8,
        padding: 8,
        gap: 3,
      },
      head: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      time: { color: c.foregroundMuted, fontSize: 12 },
      kind: { color: accent, fontSize: 12, fontWeight: "700" as const },
      // 折り返しの最後の行に1〜2文字だけ残る(「…必須をやめ／る」)と読みにくいので、
      // Web では行の長さをならす(CSS の text-wrap: balance)。RN の型に無いので Web だけに足す。
      title: Platform.select({
        web: {
          color: c.foreground,
          fontSize: 14,
          // text-wrap: balance は行の長さをならすが、日本語は語の間に空白が無いので「ボタ/ン」の
          // ように語の途中で割れる(2026-11-07 指摘)。語中で折らない指定は CSS では効かなかったので、
          // 題の字を語ごとに繋いで渡す(shared の joinTitleWords)。
          textWrap: "balance" as const,
          lineBreak: "strict" as const,
        },
        default: { color: c.foreground, fontSize: 14 },
      }),
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
    [c, accent, urgent, warn, stalled],
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
        <Text style={s.kind}>
          {stageText(item)}
          {item.alert ? ` ・ ${ALERT_SHORT[item.alert] ?? "要確認"}` : ""}
          {stalled ? " ・ 止まっている" : ""}
        </Text>
      </View>
      <Text style={s.title}>{joinTitleWords(rowTitle(item))}</Text>
      <Text style={s.meta} testID={`windowb-owner-${item.key}`}>
        {keepAgoTogether(ownerLine(item, now))}
      </Text>
      {open && item.detail ? <Text style={s.meta}>{item.detail}</Text> : null}
      {open
        ? routes.shown.map((r) => (
            <Text
              key={`${r.no}-${r.summary}`}
              style={s.meta}
              testID={`windowb-route-${item.key}-${r.no}`}
            >
              {routeText(r)}
            </Text>
          ))
        : null}
      {open && item.alert ? (
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
  // 右カラム(PC幅)か全画面(狭い幅)かで、見出しの重複を避ける。
  const wide = Dimensions.get("window").width >= WIDE_MIN_WIDTH;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // 既定は完了を隠す。「完了だけ」ボタンで直近3日の完了だけを見せる(2026-10-30 ユーザー指示)
  const [mode, setMode] = useState<ListMode>("active");
  const rows = useMemo(() => visibleRows(data, mode), [data, mode]);
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
      noticeBox: { gap: 1 },
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
  // PC幅は会話の上の帯が「指示 N件・赤N」を出しているので、件数はここで繰り返さない。
  const headCount = headCountText(data, wide);
  const truncated = data ? truncationNote(data, wide) : null;
  let notice: React.ReactElement | null = null;
  if (error) {
    notice = (
      <Text style={s.error}>
        いま読めません({error}){data ? "。下は前回読めた内容です" : ""}
      </Text>
    );
  } else if (data && data.notices.length > 0) {
    // 技術的な説明をそのまま並べると一覧の頭が埋まるので、短い行に直して出す。
    // 切り詰めの注記(灰色1行)と合わせて注意書き全体が2行に収まるよう、残り行数を渡す。
    notice = (
      <View style={s.noticeBox} testID="windowb-notices">
        {noticeLines(data.notices, truncated ? 1 : NOTICE_MAX_LINES).map((line) => (
          <Text key={line} style={s.notice}>
            {line}
          </Text>
        ))}
      </View>
    );
  }
  const hiddenAuto = hiddenAutoText(data);
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
          {/* PC幅はパネルの見出し(タブ)が「指示一覧」を出しているので、本文では繰り返さない。
              狭い画面は全画面で開くので、タブが無く、ここに題が要る。 */}
          {wide ? null : <Text style={s.headTitle}>{WINDOWB_PANEL_TITLE}</Text>}
          {headCount ? <Text style={s.muted}>{headCount}</Text> : null}
        </View>
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
        {hiddenAuto ? (
          <Text style={s.muted} testID="windowb-hidden-auto">
            {hiddenAuto}
          </Text>
        ) : null}
        {truncate}
        {notice}
      </View>
      <ScrollView contentContainerStyle={s.list}>
        {!data && !error ? <Text style={s.muted}>読み込み中…</Text> : null}
        {data && rows.length === 0 ? <Text style={s.muted}>{emptyText(mode)}</Text> : null}
        {rows.map((item) => (
          <Row key={item.key} item={item} colors={c} now={now} />
        ))}
      </ScrollView>
    </View>
  );
}
