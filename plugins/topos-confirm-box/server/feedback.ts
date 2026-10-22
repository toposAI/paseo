/**
 * 家族版/試用版 Topos の報告ファイル(`_feedback/reports/fb-*.json`)を読む。**読むだけ**。
 *
 * ディレクトリは `TOPOS_FEEDBACK_DIRS`(`:` 区切り)で上書きできる。既定は家族版と試用版の
 * `data/_feedback`。バックアップ配下(`backup_*`)は既定に含めない(過去の複製を新着として出さない)。
 *
 * 報告本文は利用者が書いた文字列なので、長さを切ってから画面へ渡す(巨大な本文で一覧が壊れない)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FEEDBACK_KINDS,
  FEEDBACK_REPLY_MAX,
  FEEDBACK_REPORT_LIMIT,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_TITLE_MAX,
} from "../shared/feedback.js";
import type { FeedbackKind, FeedbackReport, FeedbackSourceStatus } from "../shared/feedback.js";

export const DEFAULT_FEEDBACK_DIRS = [
  "/Users/user/topos-family/data/_feedback",
  "/Users/user/topos-trial/data/_feedback",
];

/** 表示名の上書き表(確認箱ディレクトリと同じ場所)。無ければ空。 */
export const REPORTER_LABELS_FILE = path.join(
  os.homedir(),
  ".local",
  "state",
  "toposai",
  "confirm_box",
  "reporter_labels.json",
);
export const USERS_YAML = "/Users/user/topos-family/config/topos-users.yaml";

// 家族版 `feedback.py` の `_ID_RE` と同じ(6桁の16進)。緩めない=読む前に形で弾く。
const ID_RE = /^fb-\d{8}-\d{6}-[0-9a-f]{6}$/;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 設定ディレクトリ一覧。`~` 展開つき。空要素は落とす。 */
export function resolveFeedbackDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TOPOS_FEEDBACK_DIRS;
  const list = raw && raw.trim() ? raw.split(":") : DEFAULT_FEEDBACK_DIRS;
  return list
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d));
}

/** id → 表示名。上書き表を優先し、無ければ `topos-users.yaml` の `display_name`。 */
export function loadReporterLabels(
  labelsPath: string = REPORTER_LABELS_FILE,
  usersYaml: string = USERS_YAML,
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) out.set(k, v.trim());
      }
    }
  } catch {
    // 上書き表は任意。読めなくても下の display_name で解決する
  }
  // `- id: wife` の次に来る `display_name: …` を拾う(家族版の設定ファイルと同じ形)。
  try {
    let cur: string | null = null;
    for (const line of fs.readFileSync(usersYaml, "utf8").split("\n")) {
      const idm = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
      if (idm) {
        cur = idm[1];
        continue;
      }
      const nm = /^\s+display_name:\s*(.+?)\s*$/.exec(line);
      if (nm && cur && !out.has(cur)) out.set(cur, nm[1].replace(/^['"]|['"]$/g, ""));
      if (nm) cur = null;
    }
  } catch {
    // 設定が無い環境(試用版のみ等)では id をそのまま出す
  }
  return out;
}

function parseTs(createdAt: string): number {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 返信の本文。家族版 `feedback.set_reply` は `reply` を `{text, at, by}` の**オブジェクト**で書く
 * (文字列で書く版もありうるので両方受ける)。形が違えば null(本文に `[object Object]` を出さない)。
 */
function replyText(value: unknown): string | null {
  const text =
    typeof value === "object" && value !== null ? (value as { text?: unknown }).text : value;
  const s = str(text).trim();
  return s ? s.slice(0, FEEDBACK_REPLY_MAX) : null;
}

/** 1件の報告 JSON を契約の形へ寄せる。`id` が形式外なら null(壊れたファイルは出さない)。 */
export function normalizeReport(
  raw: unknown,
  origin: string,
  labels: ReadonlyMap<string, string>,
): FeedbackReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id).trim();
  if (!ID_RE.test(id)) return null;
  const kind: FeedbackKind = (FEEDBACK_KINDS as readonly string[]).includes(str(o.kind))
    ? (str(o.kind) as FeedbackKind)
    : "bug";
  const reporterId = str(o.reporter).trim();
  const createdAt = str(o.created_at);
  return {
    id,
    kind,
    title: str(o.title).slice(0, FEEDBACK_TITLE_MAX) || "(題名なし)",
    text: str(o.text).slice(0, FEEDBACK_TEXT_MAX),
    status: str(o.status) || "new",
    urgent: o.urgent === true,
    createdAt,
    ts: parseTs(createdAt),
    reporter: labels.get(reporterId) ?? reporterId,
    screen: str(o.screen),
    appVersion: str(o.app_version),
    reply: replyText(o.reply),
    replySeen: o.reply_seen === true,
    hasScreenshot: str(o.screenshot).trim().length > 0,
    origin,
  };
}

export interface ReadFeedbackResult {
  reports: FeedbackReport[];
  sources: FeedbackSourceStatus[];
}

/** ディレクトリ群を読んで新しい順に返す。**例外を投げない**(読めない出所は status に出す)。 */
export function readFeedbackReports(
  dirs: readonly string[] = resolveFeedbackDirs(),
  labels: ReadonlyMap<string, string> = loadReporterLabels(),
): ReadFeedbackResult {
  const reports: FeedbackReport[] = [];
  const sources: FeedbackSourceStatus[] = [];
  for (const dir of dirs) {
    const reportsDir = path.join(dir, "reports");
    // 家族版も試用版も `<app>/data/_feedback` なので、`data` を1段飛ばしてアプリ名を出す
    // (どちらも "data" になると、どの環境の報告か画面で見分けられない)。
    const parentDir = path.dirname(dir);
    const labelSource = path.basename(parentDir) === "data" ? path.dirname(parentDir) : parentDir;
    const label = path.basename(labelSource) || dir;
    let names: string[];
    try {
      names = fs
        .readdirSync(reportsDir)
        .filter((n) => n.startsWith("fb-") && n.endsWith(".json"))
        .sort()
        .toReversed();
    } catch (error) {
      sources.push({
        id: dir,
        label,
        ok: false,
        detail: `読めません: ${(error as Error).message}`,
        count: 0,
      });
      continue;
    }
    let count = 0;
    for (const name of names) {
      try {
        const rec = normalizeReport(
          JSON.parse(fs.readFileSync(path.join(reportsDir, name), "utf8")),
          label,
          labels,
        );
        if (rec) {
          reports.push(rec);
          count += 1;
        }
      } catch {
        // 壊れた1件は飛ばす(他の報告は出す)
      }
    }
    sources.push({ id: dir, label, ok: true, detail: reportsDir, count });
  }
  reports.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  return { reports: reports.slice(0, FEEDBACK_REPORT_LIMIT), sources };
}
