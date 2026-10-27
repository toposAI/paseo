/**
 * 共有プロジェクトの取得・投稿(デーモン内サブプロセスで動く)。Topos の `/api/family-projects` を
 * **範囲つきトークン(projects 操作)**で叩く。画面から Topos へ直接は繋がない(鍵はここだけが持つ)。
 *
 * 接続設定(秘密でない部分)は `~/topos-trial/config/paseo_projects.json`(`TOPOS_PROJECTS_CONFIG` で変更):
 *   { "login": "<トークンの持ち主のログイン>", "origin": "<Topos の公開オリジン>",
 *     "baseUrl": "http://127.0.0.1:8777", "tokenFile": "<鍵ファイルの絶対パス・0600>" }
 * 鍵そのものは tokenFile にだけ置く(設定ファイルにも環境変数にも書かない)。
 * 設定や鍵が無いときは `unconfigured` を返し、何も取りに行かない(既定で無害)。
 *
 * 鍵・本文はログに出さない。エラーメッセージには HTTP 状態と理由の種類だけを載せる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SharedMessage, SharedProject } from "../shared/shared-projects.js";
import { POST_TEXT_MAX } from "../shared/shared-projects.js";

export interface ProjectsConfig {
  login: string;
  origin: string;
  baseUrl: string;
  tokenFile: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Loaded =
  | { ok: true; config: ProjectsConfig; token: string }
  | { ok: false; status: "unconfigured" | "error"; message: string };

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TOPOS_PROJECTS_CONFIG ??
    path.join(os.homedir(), "topos-trial", "config", "paseo_projects.json")
  );
}

/** 設定と鍵を読む。無い=unconfigured、壊れている/緩い権限=error(鍵の値は決して載せない)。 */
export function loadConfig(configPath = resolveConfigPath()): Loaded {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return { ok: false, status: "unconfigured", message: "接続設定ファイルがありません" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, status: "error", message: "接続設定ファイルを読めません(JSONが不正)" };
  }
  const str = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string).trim() : "");
  const login = str("login");
  const origin = str("origin");
  const tokenFile = str("tokenFile");
  const baseUrl = str("baseUrl") || "http://127.0.0.1:8777";
  if (!login || !origin || !tokenFile) {
    return {
      ok: false,
      status: "unconfigured",
      message: "接続設定に login/origin/tokenFile が足りません",
    };
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(baseUrl)) {
    // identity ミドルウェアはループバックの接続元だけを信用する。外へ鍵を送らないためにも限定する
    return { ok: false, status: "error", message: "baseUrl はループバックのみ指定できます" };
  }
  let token: string;
  try {
    const st = fs.statSync(tokenFile);
    if ((st.mode & 0o077) !== 0) {
      return {
        ok: false,
        status: "error",
        message: "鍵ファイルの権限が緩いため使いません(0600にしてください)",
      };
    }
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return { ok: false, status: "unconfigured", message: "鍵ファイルがありません" };
    return {
      ok: false,
      status: "error",
      message: "鍵ファイルを読めません(権限を確認してください)",
    };
  }
  if (!token) return { ok: false, status: "unconfigured", message: "鍵ファイルが空です" };
  return {
    ok: true,
    config: { login, origin, baseUrl: baseUrl.replace(/\/$/, ""), tokenFile },
    token,
  };
}

export type CallResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: "unconfigured" | "error"; message: string; timedOut?: boolean };

const TIMEOUT_MS = 10_000;

/** Topos へ1回呼ぶ。失敗は例外にせず理由の種類つきで返す(画面を止めない)。 */
export async function callTopos<T>(
  method: "GET" | "POST",
  pathAndQuery: string,
  body: unknown,
  deps: { load?: () => Loaded; fetchImpl?: Fetch } = {},
): Promise<CallResult<T>> {
  const loaded = (deps.load ?? loadConfig)();
  if (!loaded.ok) return loaded;
  const { config, token } = loaded;
  const doFetch: Fetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = {
    "Tailscale-User-Login": config.login,
    Authorization: `Bearer ${token}`,
    Origin: config.origin,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await doFetch(`${config.baseUrl}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok)
      return { ok: false, status: "error", message: describeHttp(res.status, pathAndQuery) };
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      status: "error",
      message:
        name === "TimeoutError" ? "Topos の応答がありません(時間切れ)" : "Topos に繋がりません",
      timedOut: name === "TimeoutError",
    };
  }
}

function describeHttp(status: number, pathAndQuery = ""): string {
  if (status === 401) return "Topos に鍵を拒否されました(401)";
  if (status === 403) return "Topos に拒否されました(403)";
  if (status === 404) {
    // 一覧(/api/family-projects 直下)の404は鍵・旗の問題。個別プロジェクトの404は退出やアーカイブ等の可能性
    return /^\/api\/family-projects(\?|$)/.test(pathAndQuery)
      ? "Topos 側で共有プロジェクトの鍵が有効になっていません(404)"
      : "このプロジェクトは見つかりません(退出した可能性があります)";
  }
  return `Topos がエラーを返しました(${status})`;
}

// ── 応答の整形(形が違う行は捨てる。落とさない) ──

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const text = (v: unknown) => (typeof v === "string" ? v : "");

export function toProjects(raw: unknown): SharedProject[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedProject[] = [];
  for (const p of raw) {
    if (!isObj(p) || typeof p.id !== "string" || !/^[0-9a-f]{32}$/.test(p.id)) continue;
    const lm = isObj(p.last_message) ? p.last_message : null;
    out.push({
      id: p.id,
      name: text(p.name) || "(名前なし)",
      description: text(p.description),
      memberCount: num(p.member_count),
      unread: num(p.unread_count),
      mentions: num(p.mentions_me),
      latestSeq: num(p.latest_seq),
      last: lm
        ? {
            author: text(lm.author_name) || text(lm.author),
            text: lm.attachments_only ? "(添付)" : text(lm.text),
            ts: text(lm.ts),
          }
        : null,
    });
  }
  return out;
}

export function toMessages(raw: unknown): {
  messages: SharedMessage[];
  latestSeq: number;
  shownMaxSeq: number;
  unread: number;
} {
  if (!isObj(raw)) return { messages: [], latestSeq: 0, shownMaxSeq: 0, unread: 0 };
  const names = isObj(raw.names) ? raw.names : {};
  const me = text(raw.me);
  const nameOf = (id: string) => (typeof names[id] === "string" ? (names[id] as string) : id);
  const messages: SharedMessage[] = [];
  for (const m of Array.isArray(raw.messages) ? raw.messages : []) {
    if (!isObj(m) || typeof m.seq !== "number") continue;
    const author = text(m.author);
    const ai = m.kind === "llm";
    messages.push({
      seq: m.seq,
      author: ai ? "AI" : nameOf(author),
      mine: !ai && me !== "" && author === me,
      ai,
      text: text(m.text),
      ts: text(m.ts),
      to: (Array.isArray(m.to) ? m.to : [])
        .filter((x): x is string => typeof x === "string")
        .map(nameOf),
      attachments: Array.isArray(m.attachments) ? m.attachments.length : 0,
    });
  }
  const shownMax = messages.reduce((a, m) => Math.max(a, m.seq), 0);
  return {
    messages,
    latestSeq: num(raw.latest_seq),
    shownMaxSeq: shownMax,
    unread: num(raw.unread_count),
  };
}

const ID_RE = /^[0-9a-f]{32}$/;

export async function listProjects(deps?: Parameters<typeof callTopos>[3]) {
  const r = await callTopos<unknown>("GET", "/api/family-projects", undefined, deps);
  if (!r.ok) return r;
  if (!Array.isArray(r.data))
    return { ok: false, status: "error", message: "Topos の応答の形が想定と違います" } as const;
  return { ok: true, projects: toProjects(r.data) } as const;
}

/** 画面に出す最新の投稿数。Topos のスレッド取得は古い側から返すので、最新側は2回に分けて取る。 */
const THREAD_TAIL = 100;

export async function fetchThread(id: string, deps?: Parameters<typeof callTopos>[3]) {
  if (!ID_RE.test(id))
    return { ok: false, status: "error", message: "不正なプロジェクトIDです" } as const;
  const base = `/api/family-projects/${id}/thread`;
  // 1回目: 件数だけ知る(after を十分大きくして投稿は0件で返らせる)
  const head = await callTopos<unknown>("GET", `${base}?after=2000000000&limit=1`, undefined, deps);
  if (!head.ok) return head;
  const latest = isObj(head.data) ? num(head.data.latest_seq) : 0;
  const after = Math.max(0, latest - THREAD_TAIL);
  const r = await callTopos<unknown>(
    "GET",
    `${base}?after=${after}&limit=${THREAD_TAIL}`,
    undefined,
    deps,
  );
  if (!r.ok) return r;
  if (!isObj(r.data) || !Array.isArray(r.data.messages))
    return { ok: false, status: "error", message: "Topos の応答の形が想定と違います" } as const;
  return { ok: true, ...toMessages(r.data) } as const;
}

/** 投稿。宛先は付けない(全員宛・AI には聞かない)。 */
export async function postMessage(
  id: string,
  body: string,
  deps?: Parameters<typeof callTopos>[3],
) {
  const t = body.trim();
  if (!ID_RE.test(id)) return { ok: false, message: "不正なプロジェクトIDです" };
  if (!t || t.length > POST_TEXT_MAX) return { ok: false, message: "本文が空か長すぎます" };
  const r = await callTopos<unknown>(
    "POST",
    `/api/family-projects/${id}/thread/messages`,
    { text: t, to: [] },
    deps,
  );
  if (r.ok) return { ok: true };
  if (!r.ok && r.timedOut)
    return { ok: false, message: "送れたか不明です。画面を更新して確認してください" };
  return { ok: false, message: r.message };
}

export async function markRead(id: string, seq: number, deps?: Parameters<typeof callTopos>[3]) {
  if (!ID_RE.test(id)) return { ok: false, message: "不正なプロジェクトIDです" };
  const r = await callTopos<unknown>(
    "POST",
    `/api/family-projects/${id}/thread/read`,
    { seq },
    deps,
  );
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}
