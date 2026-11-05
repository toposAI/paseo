/**
 * 確認箱「報告」タブの保存と読み出し。
 *
 * - 報告の登録: `scripts/report_inbox.py`(report_file_url.py が報告書の URL を作った時に自動で呼ぶ)が
 *   `reports.jsonl` へ追記する。ここは**読むだけ**(1行=1回の公開。同じ id は最後の行が最新)。
 * - 既読: `report_reads.jsonl` へ `{t:"read", id, sha, ts}` を追記する。**未読 = 最新の sha を既読にしていない**。
 *   同じ報告書が更新されると sha が変わるので、自動で未読に戻る。
 * - 本文: 元のファイル(許可範囲の .md)を読む。画像は許可範囲の画像だけ data URI で返す
 *   (iPhone など Mac Studio 以外からも、プラグインのサーバー経由で読める)。
 * - コメント: 箱のイベント列へ `t:"chat"`(source:"report", id="report:<id>")を書く。
 *   返信ワーカー(confirm_box_reply_worker.py)が報告元スレへ届け、閉じていれば復元する。
 *   返事は `t:"reply"` として同じ id に並ぶ(`readCardChat` がそのまま読む)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPORTS_FILE = "reports.jsonl";
export const REPORT_READS_FILE = "report_reads.jsonl";
export const REPORT_ID_PREFIX = "report:";
export const REPORT_COMMENT_MAX = 4000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const MAX_BYTES = 10 * 1024 * 1024;

export interface ReportRow {
  id: string;
  ts: number;
  title: string;
  path: string;
  rel: string;
  url: string;
  sha: string;
  agentId: string;
  agentName: string;
}

export interface ReportListRow extends ReportRow {
  unread: boolean;
}

function readJsonl(file: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      // 壊れた行は読み飛ばす
    }
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 同じ id は最後の行が最新。新しい順。 */
export function readReportRows(dir: string): ReportRow[] {
  const latest = new Map<string, ReportRow>();
  for (const r of readJsonl(path.join(dir, REPORTS_FILE))) {
    if (r.t !== "report" || !str(r.id)) continue;
    latest.set(str(r.id), {
      id: str(r.id),
      ts: typeof r.ts === "number" ? r.ts : 0,
      title: str(r.title) || "(題名なし)",
      path: str(r.path),
      rel: str(r.rel),
      url: str(r.url),
      sha: str(r.sha),
      agentId: str(r.agent_id).trim(),
      agentName: str(r.agent_name).trim(),
    });
  }
  return [...latest.values()].sort((a, b) => b.ts - a.ts);
}

/** id → 既読にした最新の sha。 */
function readShas(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of readJsonl(path.join(dir, REPORT_READS_FILE))) {
    if (r.t === "read" && str(r.id)) m.set(str(r.id), str(r.sha));
  }
  return m;
}

export function listReports(dir: string): ReportListRow[] {
  const reads = readShas(dir);
  return readReportRows(dir).map((r) =>
    Object.assign({}, r, { unread: reads.get(r.id) !== r.sha }),
  );
}

export function countUnreadReports(dir: string): number {
  return listReports(dir).filter((r) => r.unread).length;
}

function appendLines(dir: string, file: string, objs: readonly unknown[]): void {
  if (objs.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), objs.map((o) => `${JSON.stringify(o)}\n`).join(""), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** 既読にする(いまの sha を記録)。登録の無い id は false。 */
export function markReportRead(dir: string, id: string, now: number = Date.now()): boolean {
  const row = readReportRows(dir).find((r) => r.id === id);
  if (!row) return false;
  appendLines(dir, REPORT_READS_FILE, [{ t: "read", id, sha: row.sha, ts: now }]);
  return true;
}

export function markAllReportsRead(dir: string, now: number = Date.now()): number {
  const unread = listReports(dir).filter((r) => r.unread);
  appendLines(
    dir,
    REPORT_READS_FILE,
    unread.map((r) => ({ t: "read", id: r.id, sha: r.sha, ts: now })),
  );
  return unread.length;
}

// ---------------------------------------------------------------- 読める範囲(scripts/report_file_url.py と同じ)

function home(env: NodeJS.ProcessEnv): string {
  const h = env.REPORT_FILE_URL_HOME || os.homedir();
  try {
    return fs.realpathSync(h);
  } catch {
    return h;
  }
}

function isFinalDirFile(real: string, h: string): boolean {
  for (const base of [path.join(h, ".paseo/worktrees"), path.join(h, "repos")]) {
    if (real.startsWith(base + path.sep) && real.includes(`${path.sep}final${path.sep}`)) {
      const rel = real.slice(base.length + 1);
      return !rel.split(path.sep).some((p) => p.startsWith("."));
    }
  }
  return false;
}

/** 許可範囲の実在ファイルなら実パス。報告書(.md)は reviews/ のみ、画像は reviews/ と final/。 */
export function allowedReportFile(p: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!p || p.includes("\0")) return null;
  const h = home(env);
  const abs = p.startsWith("~/") ? path.join(h, p.slice(2)) : p;
  if (!path.isAbsolute(abs)) return null;
  const ext = path.extname(abs).toLowerCase();
  if (ext !== ".md" && !IMAGE_EXTS.has(ext)) return null;
  let real: string;
  let size: number;
  try {
    if (!fs.statSync(abs).isFile()) return null;
    real = fs.realpathSync(abs);
    size = fs.statSync(real).size;
  } catch {
    return null;
  }
  if (real !== path.resolve(abs) || size > MAX_BYTES) return null;
  const reviews = path.join(h, ".local/state/toposai/reviews");
  const inReviews = real.startsWith(reviews + path.sep);
  if (!(inReviews || (IMAGE_EXTS.has(ext) && isFinalDirFile(real, h)))) return null;
  return real;
}

export interface ReportBody {
  ok: boolean;
  message: string;
  markdown: string;
}

export function readReportBody(row: ReportRow, env: NodeJS.ProcessEnv = process.env): ReportBody {
  const real = allowedReportFile(row.path, env);
  if (!real || !real.toLowerCase().endsWith(".md")) {
    return {
      ok: false,
      message: "元のファイルが見つかりません(消えたか、読める範囲の外です)",
      markdown: "",
    };
  }
  try {
    return { ok: true, message: "", markdown: fs.readFileSync(real, "utf-8") };
  } catch (error) {
    return { ok: false, message: `読めません: ${(error as Error).message}`, markdown: "" };
  }
}

export function readReportImage(
  p: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; dataUri: string } {
  const real = allowedReportFile(p, env);
  const ext = real ? path.extname(real).toLowerCase() : "";
  if (!real || !IMAGE_EXTS.has(ext)) return { ok: false, dataUri: "" };
  try {
    const b64 = fs.readFileSync(real).toString("base64");
    return { ok: true, dataUri: `data:${IMAGE_MIME[ext]};base64,${b64}` };
  } catch {
    return { ok: false, dataUri: "" };
  }
}

// ---------------------------------------------------------------- コメント

export const REPORT_ACK_TEXT =
  "受け取りました。報告元のスレへ届けます(返事が出たらここに表示されます)";

/**
 * 報告書へのコメントを箱のイベント列へ書く。報告元が不明な報告は送れない。
 * 改行は残す(複数行のコメントを読めるように)。質問と受領は同じ write で書く
 * (`sayToCard` と同じ理由: 別々だとワーカーが受領を二重に書く)。
 */
export function commentOnReport(
  dir: string,
  reportId: string,
  text: string,
  now: number = Date.now(),
): { ok: boolean; message: string } {
  const row = readReportRows(dir).find((r) => r.id === reportId);
  if (!row) return { ok: false, message: "この報告は見つかりません" };
  if (!row.agentId) return { ok: false, message: "報告元が分からないため、コメントを送れません" };
  const clean = text.trim().slice(0, REPORT_COMMENT_MAX);
  if (!clean) return { ok: false, message: "空です" };
  const id = `${REPORT_ID_PREFIX}${reportId}`;
  const cid = `cbui-${id}-${now}`;
  const d = new Date(now);
  const events = `events-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`;
  appendLines(dir, events, [
    {
      t: "chat",
      id,
      key: null,
      ts: now,
      question: clean,
      client_message_id: cid,
      source: "report",
    },
    { t: "reply", id, key: null, ts: now, re: cid, by: "ack", text: REPORT_ACK_TEXT },
  ]);
  return { ok: true, message: "送りました" };
}
