/**
 * 「Toposバグ報告」タブ。家族版/試用版 Topos の「バグ・要望報告」を一覧で見るだけの画面。
 *
 * データは報告ファイル `<data_dir>/_feedback/reports/fb-*.json` をそのまま読む
 * (`services/feedback.py` が1件1JSONで書く正本。ここは書き換えない)。
 * 判断が必要な報告は確認箱の「判断待ち」側に出るので、この画面では決めない。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { feedbackScreenshotRpc } from "../shared/contract.js";
import { ImageLightbox } from "./ImageLightbox.js";
import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_PROGRESS_LABEL,
  countNewReports,
  feedbackReportsListRpc,
  isReportComplete,
} from "../shared/feedback.js";
import type { ToggleInfo } from "./HeaderIconBar.js";
import type { FeedbackReport, FeedbackReportsListOutput } from "../shared/feedback.js";

const REFRESH_MS = 30_000;

/** 見出し文。読み込み中/エラー/件数の3状態をここで畳む(JSX に入れ子の三項を書かない)。 */
function describe(error: string | null, loaded: boolean, total: number, newCount: number): string {
  if (error) return `取得できません: ${error}`;
  if (!loaded) return "読み込み中…";
  return `バグ・要望 ${total}件(未対応 ${newCount}件)`;
}

export function BugReportsView({
  theme,
  showArchived = false,
  onToggleInfo,
}: Pick<PluginHostProps, "theme"> & {
  /** 完了済みも出すか。切替ボタンは親(最上部のアイコン列)に置く。 */
  showArchived?: boolean;
  onToggleInfo?: (info: ToggleInfo | null) => void;
}) {
  const list = useRpc(feedbackReportsListRpc);
  const [data, setData] = useState<FeedbackReportsListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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
      title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      meta: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      warn: { color: c.statusWarning, fontSize: 12 },
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      chip: {
        color: c.accent,
        fontSize: 11,
        fontWeight: "700" as const,
        backgroundColor: c.surface2,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      chipUrgent: {
        color: c.accentForeground,
        fontSize: 11,
        fontWeight: "700" as const,
        backgroundColor: c.statusWarning,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      reply: {
        color: c.foreground,
        fontSize: 13,
        backgroundColor: c.surface2,
        borderRadius: 6,
        padding: 8,
      },
    }),
    [c],
  );

  const allReports = data?.reports ?? [];
  // 完了(対応済み・見送り)は返信の既読に関わらず隠す(2026-10-28 ユーザー指摘: バッジは消えるのに一覧に残る)
  // 判定はバッジ(`countOpenReports`)と同じ `isReportComplete` を使う(バッジの数と一覧の行数を揃える)
  const isHidden = (r: FeedbackReport) => isReportComplete(r);
  const archivedCount = allReports.filter(isHidden).length;
  // 完了(対応済み・見送り)は既定で隠す。トグルはセッション内のみ(永続化しない=「消えた」と誤解させない)
  const reports = showArchived ? allReports : allReports.filter((r) => !isHidden(r));
  const newCount = countNewReports(allReports);
  useEffect(() => {
    if (!onToggleInfo) return undefined;
    onToggleInfo(
      archivedCount > 0
        ? {
            label: showArchived ? "完了済み隠す" : "完了済み表示",
            a11y: showArchived ? "完了済みを隠す" : `完了済みも表示(${archivedCount}件)`,
          }
        : null,
    );
    return () => onToggleInfo(null);
  }, [onToggleInfo, archivedCount, showArchived]);

  return (
    <View style={s.root}>
      <Text style={s.meta}>{describe(error, data !== null, allReports.length, newCount)}</Text>
      {data?.sources
        .filter((x) => !x.ok)
        .map((x) => (
          <Text key={x.id} style={s.warn}>
            {x.label}: {x.detail}
          </Text>
        ))}
      {data && reports.length === 0 && !error ? (
        <Text style={s.meta}>
          {allReports.length === 0 ? "報告はありません" : "対応中の報告はありません"}
        </Text>
      ) : null}
      {reports.map((r) => (
        <ReportCard key={r.id} report={r} styles={s} open={openId === r.id} onToggle={setOpenId} />
      ))}
    </View>
  );
}

function ReportCard({
  report,
  styles,
  open,
  onToggle,
}: {
  report: FeedbackReport;
  styles: Record<string, object>;
  open: boolean;
  onToggle: (id: string | null) => void;
}) {
  const press = useCallback(() => onToggle(open ? null : report.id), [onToggle, open, report.id]);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={report.urgent ? styles.chipUrgent : styles.chip}>
          {report.urgent ? "緊急" : FEEDBACK_KIND_LABEL[report.kind]}
        </Text>
        <Text style={styles.meta}>{formatDate(report.ts)}</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={press}>
        <Text style={styles.title}>{report.title}</Text>
        <Text style={styles.meta}>
          {report.reporter || "報告者不明"} · {STATUS_LABEL[report.status] ?? report.status}
          {report.origin ? ` · ${report.origin}` : ""}
          {report.hasScreenshot ? " · 画像あり" : ""}
        </Text>
        {open ? null : (
          <Text style={styles.text} numberOfLines={2}>
            {report.text}
          </Text>
        )}
      </Pressable>
      {report.progress ? (
        <Text style={report.progress.stage === "stale" ? styles.warn : styles.meta}>
          進捗: {FEEDBACK_PROGRESS_LABEL[report.progress.stage]} — {report.progress.detail}
          {report.progress.threadId ? "(子スレで対応中)" : ""}
        </Text>
      ) : null}
      {open ? <Text style={styles.text}>{report.text}</Text> : null}
      {open ? <ReportExtras report={report} styles={styles} /> : null}
    </View>
  );
}

/** 開いたカードだけに出す補足(返信・画面名・画像)。 */
function ReportExtras({
  report,
  styles,
}: {
  report: FeedbackReport;
  styles: Record<string, object>;
}) {
  return (
    <>
      {report.reply ? <Text style={styles.reply}>返信: {report.reply}</Text> : null}
      {report.reply && !report.replySeen ? (
        <Text style={styles.meta}>※ 報告者はまだ返信を見ていません</Text>
      ) : null}
      {report.screen ? <Text style={styles.meta}>画面: {report.screen}</Text> : null}
      {report.screenshot ? (
        <ReportScreenshot name={report.screenshot} metaStyle={styles.meta} />
      ) : null}
    </>
  );
}

const SHOT_FRAME = { width: "100%", height: 260 } as const;
const SHOT_BOX = { ...SHOT_FRAME, alignItems: "center", justifyContent: "center" } as const;

/** 開いたカードだけ画像を取りに行く(閉じたカードには描かない=取得しない)。 */
function ReportScreenshot({ name, metaStyle }: { name: string; metaStyle: object }) {
  const fetchShot = useRpc(feedbackScreenshotRpc);
  const [state, setState] = useState<"loading" | "failed" | string>("loading");
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let alive = true;
    setState("loading");
    fetchShot({ name })
      .then((r) => alive && setState(r.ok ? r.dataUri : "failed"))
      .catch(() => alive && setState("failed"));
    return () => {
      alive = false;
    };
  }, [fetchShot, name]);
  const sources = useMemo(() => [{ uri: state }], [state]);
  const openZoom = useCallback(() => setZoom(true), []);
  const closeZoom = useCallback(() => setZoom(false), []);
  const noop = useCallback(() => undefined, []);
  if (state === "loading" || state === "failed") {
    return (
      <View style={SHOT_BOX}>
        <Text style={metaStyle}>
          {state === "loading" ? "画像を読み込み中…" : "(画像を読めません)"}
        </Text>
      </View>
    );
  }
  return (
    <>
      <Pressable accessibilityRole="imagebutton" onPress={openZoom} style={SHOT_FRAME}>
        <Image source={sources[0]} style={SHOT_FRAME} resizeMode="contain" />
      </Pressable>
      <ImageLightbox
        sources={sources}
        index={zoom ? 0 : null}
        onChange={noop}
        onClose={closeZoom}
      />
    </>
  );
}

/**
 * 家族版 `feedback.py` の `STATUS_LABELS` と同じ文言(SSOT は家族版。ずらさない)。
 * 未知の値はそのまま出す(勝手に言い換えない)。
 */
const STATUS_LABEL: Record<string, string> = {
  new: "新着",
  will_do: "対応する",
  hold: "保留",
  rejected: "却下",
  done: "対応済み",
};

function formatDate(ts: number): string {
  if (!ts) return "日時なし";
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
