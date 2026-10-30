/**
 * 窓口Bの右側の「タスク台帳」(ユーザー指示 2026-10-28。決まりごとは `shared/task-ledger.ts` の先頭)。
 *
 * - 一番上が最新。1行 = 依頼の1項目。要約と「タップで原文を開く」。
 * - 1行に、いつ受付したか・子スレに振ったか(子スレ名/代理決定/投函/説明のみ)・子スレの進捗・開発プロジェクト。
 * - 一番上の切り替えで「完了は隠す」(既定)と「完了だけ表示」。
 * - PC は右の欄の面板(`addWorkspacePanel` の `explorer`)として出す。窓口Bの画面のヘッダの
 *   「タスク台帳」ボタンで開く(iPhone では同じボタンが幕をそのまま開く)。
 *   狭い(iPhone)画面では右端から左へスワイプして出る幕に載る(Paseo 本体の
 *   `CompactExplorerSidebarHost` が、右の欄のプラグイン面板を幕に載せる)。
 *
 * 読み込みは 15 秒ごとに取り直す(裏方が受付・振り分けを書いたら、少し待てば台帳に載る)。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import type { PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  LEDGER_KIND_LABEL,
  LEDGER_PROGRESS_LABEL,
  filterLedgerRows,
  isLedgerDone,
  taskLedgerListRpc,
} from "../shared/task-ledger.js";
import { openPriorityScreen } from "./screens.js";
import type {
  LedgerChild,
  LedgerMode,
  LedgerProgress,
  LedgerRow,
  TaskLedgerListOutput,
} from "../shared/task-ledger.js";

/** 窓口BのスレID。ここを見て「窓口Bの画面か」を決め、窓口Bの画面だけでヘッダボタンを出す。 */
export const WINDOW_B_AGENT_ID = "29f7ab97-3c33-407e-8a2b-c5284dd38f99";
/** 面板の id(`ctx.openPanel` と `Contribute` の両方で使う)。 */
export const TASK_LEDGER_PANEL_ID = "window-b-ledger";
/** 全画面で開くときの画面の id(右の欄を作れないときに落ち先として使う)。 */
export const TASK_LEDGER_SCREEN_ID = "task-ledger";

const REFRESH_MS = 15_000;

type Theme = PluginWorkspacePanelProps["theme"];
type Styles = Record<string, object>;

function timeOf(row: LedgerRow): string {
  const m = /^(\d{2}\/\d{2}\s+\d{2}:\d{2})/.exec(row.key);
  return m ? m[1] : row.key;
}

/** スレIDが窓口Bか(短縮IDでもよい)。 */
export function isWindowB(agentId: string | null | undefined): boolean {
  return Boolean(agentId && agentId.toLowerCase().startsWith(WINDOW_B_AGENT_ID.slice(0, 8)));
}

const PROGRESS_COLOR: Record<
  LedgerProgress,
  "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted"
> = {
  working: "statusSuccess",
  stopped: "statusDanger",
  waiting: "statusWarning",
  done: "foregroundMuted",
  unknown: "foregroundMuted",
};

/**
 * 行の状態の1語。子スレの進捗のうち一番悪いもの(止まっている > 判断待ち > 作業中)を出し、
 * 子スレで片付いていなければ「完了」、子スレを振っていない行は振り先の種別で読む。
 */
export function rowStateText(row: LedgerRow): { text: string; tone: LedgerProgress | "done" } {
  // 完了の判定は共通の1本(`isLedgerDone`)だけを使う。「完了は隠す」で消えた行が「作業中」と
  // 出る食い違いを避ける(2026-10-28 出口レビュー1巡目)。
  if (isLedgerDone(row)) return { text: "完了", tone: "done" };
  if (row.children.length > 0) {
    const order: LedgerProgress[] = ["stopped", "waiting", "working", "unknown", "done"];
    const worst = order.find((p) => row.children.some((c) => c.progress === p)) ?? "unknown";
    return { text: LEDGER_PROGRESS_LABEL[worst], tone: worst };
  }
  if (row.kind === "代理決定") return { text: "代理決定で処理済み", tone: "done" };
  if (row.kind === "投函" || row.kind === "説明のみ") return { text: "処理済み", tone: "done" };
  // 受信箱から補っただけの行は、振り先が無いのではなく「記録が無い」。まだ振っていないとは言い切らない。
  if (row.inferred) return { text: "振り先の記録なし", tone: "unknown" };
  return { text: "まだ振っていない", tone: "unknown" };
}

function childText(c: LedgerChild): string {
  const name = c.title.trim() || `${c.id.slice(0, 8)}…`;
  const state = c.missing ? "子スレ一覧に無い" : LEDGER_PROGRESS_LABEL[c.progress];
  return `${name}(${state})`;
}

/** 開いたときに出す1行(返信済み・振り先の記録だけ。無ければ空)。 */
function replyNoteOf(row: LedgerRow): string {
  if (row.repliedAt) return "・返信済み";
  if (row.targetSetAt) return "・振り先を記録済み";
  return "";
}

/** 子スレへの返し先からスレを開く(窓口Bの画面と同じ「右の欄で開く」)。 */
export type OpenAgent = (agentId: string) => void;

/**
 * 行の開発プロジェクトを押したときの動き。優先順位の画面を開く(どの開発の話かは優先順位の画面で追う)。
 * 開ける先を知らないとき(テスト・別の画面に埋め込んだとき)は押せない。
 */
const OpenPriorityContext = createContext<(() => void) | null>(null);

// 選択の印は定数で持つ(毎回の描画で新しい object を渡さない)。
const CHIP_ON_STATE = { selected: true };
const CHIP_OFF_STATE = { selected: false };

export function TaskLedgerView({
  theme,
  data,
  error,
  mode,
  setMode,
  onOpenAgent,
  onOpenPriority,
  onRefresh,
  compact = false,
}: {
  theme: Theme;
  data: TaskLedgerListOutput | null;
  error: string | null;
  mode: LedgerMode;
  setMode: (m: LedgerMode) => void;
  onOpenAgent?: OpenAgent;
  onOpenPriority?: () => void;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const s = useMemo(() => styles(theme), [theme]);
  // `useSafeAreaInsets()` は安全領域の外で呼ぶと例外を投げ、飾りの余白のせいで面板ごと
  // 「Plugin failed」に落ちる(2026-10-28 実機確認)。無いときは余白を付けないだけにする。
  const insets = useContext(SafeAreaInsetsContext);
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => (data ? filterLedgerRows(data.rows, mode) : []), [data, mode]);
  const doneCount = useMemo(
    () => (data ? data.rows.filter((r) => isLedgerDone(r)).length : 0),
    [data],
  );
  const hideDone = useCallback(() => setMode("hide-done"), [setMode]);
  const onlyDone = useCallback(() => setMode("only-done"), [setMode]);

  // スマホ幅では状態バー・安全領域のぶんだけ中身を下げる(右の欄に並べる時は触らない)。
  const rootStyle = useMemo(
    () =>
      compact
        ? [s.root, { paddingTop: insets?.top ?? 0, paddingBottom: insets?.bottom ?? 0 }]
        : [s.root],
    [compact, insets, s],
  );

  const chip = (label: string, on: boolean, press: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityState={on ? CHIP_ON_STATE : CHIP_OFF_STATE}
      style={on ? s.chipOn : s.chip}
      onPress={press}
    >
      <Text style={on ? s.chipOnText : s.chipText}>{label}</Text>
    </Pressable>
  );

  return (
    <OpenPriorityContext.Provider value={onOpenPriority ?? null}>
      <View style={rootStyle}>
        <View style={s.header}>
          <Text style={s.title}>タスク台帳</Text>
          <Text style={s.muted}>{countText(data, rows.length, doneCount, mode)}</Text>
        </View>
        <View style={s.chips}>
          {chip("完了は隠す", mode === "hide-done", hideDone)}
          {chip("完了だけ表示", mode === "only-done", onlyDone)}
        </View>
        {error ? <Text style={s.warn}>読み込めません: {error}</Text> : null}
        {data?.notes.map((n) => (
          <Text key={n} style={s.note}>
            {n}
          </Text>
        ))}
        <ScrollView style={s.scroll} contentContainerStyle={s.list}>
          {data && rows.length === 0 ? <Text style={s.muted}>{emptyText(data, mode)}</Text> : null}
          {rows.map((row) => (
            <LedgerRowItem
              key={row.id}
              row={row}
              open={openId === row.id}
              theme={theme}
              s={s}
              onToggle={setOpenId}
              onOpenChild={onOpenAgent}
            />
          ))}
          {data && rows.length > 0 ? (
            <Pressable accessibilityRole="button" style={s.refreshBtn} onPress={onRefresh}>
              <Text style={s.muted}>更新({rows.length}件 / 15秒ごとに自動更新)</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </OpenPriorityContext.Provider>
  );
}

/** 右上の件数。出す行の数(絞り込み後)を先に書き、隠している件数を括弧で添える。 */
function countText(
  data: TaskLedgerListOutput | null,
  visible: number,
  done: number,
  mode: LedgerMode,
): string {
  if (!data) return "読み込み中";
  if (mode === "hide-done")
    return done > 0 ? `${visible}件(完了${done}件は非表示)` : `${visible}件`;
  return `${visible}件(完了のみ)`;
}

function emptyText(data: TaskLedgerListOutput, mode: LedgerMode): string {
  if (data.rows.length === 0)
    return "窓口Bの依頼はまだありません。受付されると、ここに上から順に並びます。";
  if (mode === "hide-done")
    return "いま残っている依頼はありません(「完了だけ表示」で完了した依頼が見られます)。";
  return "完了した依頼はまだありません。";
}

/** 1行(1項目)。要約・受付時刻・振り先・進捗・開発プロジェクトを出し、タップで原文を開く。 */
function LedgerRowItem({
  row,
  open,
  theme,
  s,
  onToggle,
  onOpenChild,
}: {
  row: LedgerRow;
  open: boolean;
  theme: Theme;
  s: Styles;
  onToggle: (id: string | null) => void;
  onOpenChild?: OpenAgent;
}) {
  const state = rowStateText(row);
  const firstChild = row.children[0]?.id ?? null;
  const openPriority = useContext(OpenPriorityContext);
  const handleToggle = useCallback(() => onToggle(open ? null : row.id), [onToggle, open, row.id]);
  const handleOpenChild = useCallback(() => {
    if (firstChild) onOpenChild?.(firstChild);
  }, [firstChild, onOpenChild]);
  const handleCollapse = useCallback(() => onToggle(null), [onToggle]);
  const handleOpenPriority = useCallback(() => openPriority?.(), [openPriority]);

  return (
    <View style={s.card} testID={`ledger-row-${row.id}`}>
      <Pressable accessibilityRole="button" onPress={handleToggle}>
        <Text style={s.summary}>{row.summary || "(要約なし)"}</Text>
        <View style={s.metaRow}>
          <Text style={s.meta}>
            {timeOf(row)}
            {row.itemCount > 1 ? ` の${row.itemNo}件目` : ""}
          </Text>
          <Text style={metaStyle(s.meta, state.tone, theme)}>{state.text}</Text>
          {row.project ? (
            <Pressable accessibilityRole="button" onPress={handleOpenPriority}>
              <Text style={s.project}>優先順位: {row.project.name}</Text>
            </Pressable>
          ) : null}
          {row.inferred ? <Text style={s.inferred}>推測</Text> : null}
        </View>
        <Text style={s.meta}>
          振り先: {LEDGER_KIND_LABEL[row.kind]}
          {row.children.length > 0 ? ` / ${row.children.map((c) => childText(c)).join("・")}` : ""}
        </Text>
      </Pressable>
      {row.children.length > 0 && onOpenChild ? (
        <Pressable accessibilityRole="button" style={s.linkBtn} onPress={handleOpenChild}>
          <Text style={s.link}>子スレを開く</Text>
        </Pressable>
      ) : null}
      {open ? (
        <Pressable accessibilityRole="button" onPress={handleCollapse}>
          <Text style={s.muted}>
            ユーザーの依頼文{row.source && row.source !== row.summary ? "(この項目)" : ""}
          </Text>
          {row.source && row.source !== row.summary ? (
            <Text style={s.quote}>{row.source}</Text>
          ) : null}
          <Text style={s.quote}>{row.fullText || "(受信箱に依頼文がありません)"}</Text>
          <Text style={s.muted}>
            {timeOf(row)} 受付
            {replyNoteOf(row)}
          </Text>
        </Pressable>
      ) : (
        <Text style={s.muted}>タップで原文</Text>
      )}
    </View>
  );
}

/** 面板の外(全画面の画面)でも使えるように、読み込みと切り替えの状態はここにまとめる。 */
export function useTaskLedger() {
  const rpc = useRpc(taskLedgerListRpc);
  const [data, setData] = useState<TaskLedgerListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LedgerMode>("hide-done");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    rpc({})
      .then((res) => {
        if (!alive) return undefined;
        setData(res);
        setError(null);
        return undefined;
      })
      .catch((e: unknown) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [rpc, tick]);

  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setTick((v) => v + 1), []);
  return { data, error, mode, setMode, refresh };
}

/**
 * 面板コンポーネント(`addWorkspacePanel` に渡す)。窓口Bのスレに紐づく面板として開いても、
 * どのワークスペースでも同じ台帳を出す(台帳はユーザー全体で1つ)。
 * `useTaskLedger` はパネルごとに1つ持つが、これは Paseo のプラグイン client の `useRpc` に依存する型
 * なので DOM に描くとき(不具合で別の場所へ描くとき)にも同じ部品で済むようにしてある。
 */
export function TaskLedgerPanel({ theme, navigation, layout }: PluginWorkspacePanelProps) {
  const { data, error, mode, setMode, refresh } = useTaskLedger();
  const openAgent = useCallback<OpenAgent>(
    (agentId) => navigation?.openAgent({ agentId, placement: "right" }),
    [navigation],
  );
  const openPriority = useCallback<() => void>(() => openPriorityScreen(), []);
  return (
    <TaskLedgerView
      theme={theme}
      data={data}
      error={error}
      mode={mode}
      setMode={setMode}
      onOpenAgent={navigation ? openAgent : undefined}
      onOpenPriority={openPriority}
      onRefresh={refresh}
      compact={layout.compact}
    />
  );
}

/** 全画面の画面(`addScreen`)。面板を出せない幅・経路(古いホスト・コマンドから開いたとき)用。 */
export function TaskLedgerScreen({ theme, layout, navigation }: PluginScreenProps) {
  const { data, error, mode, setMode, refresh } = useTaskLedger();
  const openAgent = useCallback<OpenAgent>(
    (agentId) => navigation?.openAgent({ agentId, placement: "right" }),
    [navigation],
  );
  const openPriority = useCallback<() => void>(() => openPriorityScreen(), []);
  return (
    <TaskLedgerView
      theme={theme}
      data={data}
      error={error}
      mode={mode}
      setMode={setMode}
      onOpenAgent={navigation ? openAgent : undefined}
      onOpenPriority={openPriority}
      onRefresh={refresh}
      compact={layout.compact}
    />
  );
}

function styles(theme: Theme): Styles {
  const c = theme.colors;
  return {
    root: { flex: 1, backgroundColor: c.surface0 },
    header: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      justifyContent: "space-between" as const,
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 4,
    },
    title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
    chips: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 6,
      paddingHorizontal: 12,
      paddingBottom: 8,
    },
    chip: {
      backgroundColor: c.surface2,
      borderRadius: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    chipOn: {
      backgroundColor: c.accent,
      borderRadius: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    chipText: { color: c.foreground, fontSize: 12 },
    chipOnText: { color: c.accentForeground, fontSize: 12 },
    scroll: { flex: 1 },
    list: { paddingHorizontal: 12, paddingBottom: 24, gap: 8 },
    card: {
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      gap: 4,
    },
    summary: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    metaRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
      alignItems: "center" as const,
    },
    meta: { color: c.foregroundMuted, fontSize: 12 },
    project: {
      color: c.accent,
      fontSize: 11,
      borderColor: c.accent,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    inferred: {
      color: c.foregroundMuted,
      fontSize: 11,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    linkBtn: { alignSelf: "flex-start" as const, paddingVertical: 2 },
    link: { color: c.accent, fontSize: 12, textDecorationLine: "underline" as const },
    quote: {
      color: c.foreground,
      fontSize: 12,
      backgroundColor: c.surface2,
      borderRadius: 6,
      padding: 8,
      marginTop: 4,
    },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    note: { color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 12, paddingBottom: 4 },
    warn: { color: c.statusWarning, fontSize: 12, paddingHorizontal: 12, paddingBottom: 4 },
    refreshBtn: { alignSelf: "center" as const, padding: 8 },
  };
}

/** 状態の色を効かせた1行(配列を毎回作らないよう、元の見た目に重ねた object を返す)。 */
function metaStyle(base: object, tone: LedgerProgress | "done", theme: Theme) {
  const key = tone === "done" ? "foregroundMuted" : PROGRESS_COLOR[tone];
  return { ...base, color: theme.colors[key], fontWeight: "600" as const };
}
