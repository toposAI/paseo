/**
 * 共有プロジェクトの取得・投稿(デーモン内サブプロセスで動く)。Topos の `/api/family-projects` を
 * 家族共有プロジェクト用のトークンで叩く(閲覧のみ・旧鍵などの権限は Topos が判定し、ここでは理由を画面へ返す)。
 * 画面から Topos へ直接は繋がない(鍵はここだけが持つ)。
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
import {
  API_OPS,
  classifyFailure,
  failureText,
  isApiOp,
  isId32,
  type ApiOp,
  type FailureReason,
  type OpSpec,
  type SharedProjectApiInput,
} from "../shared/shared-projects-api.js";
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
  | {
      ok: false;
      status: "unconfigured" | "error";
      message: string;
      timedOut?: boolean;
      /** 失敗の種類(shared の FailureReason)と、HTTP 状態・Toposの理由コード。 */
      reason?: FailureReason;
      httpStatus?: number;
      detail?: string;
    };

const TIMEOUT_MS = 10_000;

export interface CallDeps {
  load?: () => Loaded;
  fetchImpl?: Fetch;
  /** 既定10秒。AIを呼ぶ操作は長くする。 */
  timeoutMs?: number;
  /** 応答をバイナリとして読み、{dataUrl, mime, size} にする(添付)。 */
  binary?: boolean;
  /** 本文をすでに JSON 文字列にしてあるとき(二重の stringify を避ける)。`body` は有無の判定にだけ使う。 */
  rawBody?: string;
}

/** バイナリ応答を返してよいMIME。それ以外は octet-stream に落とす(画面で開かない)。 */
const SAFE_BINARY_MIME =
  /^(image\/(png|jpe?g|gif|webp|heic|heif|avif)|application\/pdf|text\/plain)$/;

/** Topos の FastAPI エラー本文 {detail: "コード"} から理由コードだけを取り出す(それ以外は捨てる)。 */
async function readDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as unknown;
    if (isObj(j) && typeof j.detail === "string") return j.detail.slice(0, 200);
  } catch {
    // 本文が無い・JSONでない
  }
  return "";
}

/** 添付ダウンロードの上限(バイト)。Topos の添付上限(attach_limits)より十分大きい安全弁で、メモリを守る。 */
export const ATTACH_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** 添付などバイナリの応答を、画面がそのまま使える base64 のデータURLにする(MIME は許可リストのみ)。 */
async function binaryData(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const mime = SAFE_BINARY_MIME.test(ct) ? ct : "application/octet-stream";
  return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, mime, size: buf.length };
}

/** HTTP エラーを理由の種類つきの失敗にする。権限の理由は具体的な文言、それ以外は従来の文言。 */
async function httpFailure(res: Response, pathAndQuery: string) {
  const detail = await readDetail(res);
  const reason = classifyFailure(res.status, detail);
  const specific = reason === "scope" || reason === "viewer" || reason === "author_only";
  return {
    ok: false,
    status: "error",
    message: specific ? failureText(reason, detail) : describeHttp(res.status, pathAndQuery),
    reason,
    httpStatus: res.status,
    detail,
  } as const;
}

const tooLarge = () =>
  ({
    ok: false,
    status: "error",
    message: "添付が大きすぎて開けません",
    reason: "too_large",
  }) as const;

/** バイナリ応答を読む。読む前に宣言サイズで断り(巨大な応答をメモリに載せない)、読んだ後も確かめる。 */
async function readBinary(res: Response) {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > ATTACH_DOWNLOAD_MAX_BYTES) {
    void res.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  const data = await binaryData(res);
  return data.size > ATTACH_DOWNLOAD_MAX_BYTES ? tooLarge() : ({ ok: true, data } as const);
}

/** Topos へ1回呼ぶ。失敗は例外にせず理由の種類つきで返す(画面を止めない)。 */
export async function callTopos<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathAndQuery: string,
  body: unknown,
  deps: CallDeps = {},
): Promise<CallResult<T>> {
  const loaded = (deps.load ?? loadConfig)();
  if (!loaded.ok)
    return { ...loaded, reason: loaded.status === "error" ? "config" : "unconfigured" };
  const { config, token } = loaded;
  const doFetch: Fetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = {
    "Tailscale-User-Login": config.login,
    Authorization: `Bearer ${token}`,
    Origin: config.origin,
    Accept: deps.binary ? "*/*" : "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await doFetch(`${config.baseUrl}${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : (deps.rawBody ?? JSON.stringify(body)),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (!res.ok) return await httpFailure(res, pathAndQuery);
    if (deps.binary) return (await readBinary(res)) as CallResult<T>;
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError";
    return {
      ok: false,
      status: "error",
      message: timedOut ? "Topos の応答がありません(時間切れ)" : "Topos に繋がりません",
      timedOut,
      reason: timedOut ? "timeout" : "network",
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
  if (status === 413) return "大きすぎて受け付けられませんでした(413)";
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

export async function listProjects(deps?: CallDeps) {
  const r = await callTopos<unknown>("GET", "/api/family-projects", undefined, deps);
  if (!r.ok) return r;
  if (!Array.isArray(r.data))
    return { ok: false, status: "error", message: "Topos の応答の形が想定と違います" } as const;
  return { ok: true, projects: toProjects(r.data) } as const;
}

/** 画面に出す最新の投稿数。Topos のスレッド取得は古い側から返すので、最新側は2回に分けて取る。 */
const THREAD_TAIL = 100;

export async function fetchThread(id: string, deps?: CallDeps) {
  const r = await fetchThreadRaw(id, deps);
  if (!r.ok) return r;
  return { ok: true, ...toMessages(r.data) } as const;
}

/** スレッドの最新側 THREAD_TAIL 件を Topos の形のまま取る(複合操作 thread)。 */
export async function fetchThreadRaw(
  id: string,
  deps?: CallDeps,
): Promise<CallResult<Record<string, unknown>>> {
  if (!ID_RE.test(id))
    return {
      ok: false,
      status: "error",
      message: "不正なプロジェクトIDです",
      reason: "bad_request",
    };
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
    return { ok: false, status: "error", message: "Topos の応答の形が想定と違います" };
  return { ok: true, data: r.data };
}

/**
 * 旧い単純な投稿(本文だけを全員宛に送る。AIには聞かない)。画面は使わず、旧RPC(sharedProjectPostRpc)
 * からだけ呼ばれる。宛先・添付つきの投稿は callApi の `post` 操作。
 */
export async function postMessage(id: string, body: string, deps?: CallDeps) {
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

export async function markRead(id: string, seq: number, deps?: CallDeps) {
  if (!ID_RE.test(id)) return { ok: false, message: "不正なプロジェクトIDです" };
  const r = await callTopos<unknown>(
    "POST",
    `/api/family-projects/${id}/thread/read`,
    { seq },
    deps,
  );
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

// ── 許可リスト方式の汎用呼び出し(topos.projects.api) ─────────────────────────

/** ユーザーID(Topos の identity の _UID と同じ形)。 */
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const QUERY_INT_RE = /^\d{1,9}$/;
/** 本文の大きさの上限(JSON文字数)。添付つきの投稿だけ大きく許す。 */
const BODY_MAX_CHARS = { json: 600_000, post: 48_000_000 } as const;

export type ApiOutcome =
  | { ok: true; status: "ok"; data: unknown }
  | {
      ok: false;
      status: "unconfigured" | "error";
      reason: FailureReason;
      message: string;
      httpStatus?: number;
      detail?: string;
    };

const badRequest = (message: string): ApiOutcome => ({
  ok: false,
  status: "error",
  reason: "bad_request",
  message,
});

/** `{id}` などを検証しながら埋める。1つでも不正なら null(何も送らない)。 */
function fillPath(spec: OpSpec, input: SharedProjectApiInput): string | null {
  let bad = false;
  const out = spec.path.replace(/\{(id|nid|aid|uid|v)\}/g, (_m, key: string) => {
    if (key === "v") {
      const v = input.v;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 999_999) bad = true;
      return String(v);
    }
    const value = input[key as "id" | "nid" | "aid" | "uid"];
    const ok = key === "uid" ? UID_RE.test(value ?? "") : isId32(value);
    if (!ok) bad = true;
    return encodeURIComponent(value ?? "");
  });
  return bad ? null : out;
}

function buildQuery(spec: OpSpec, query: Record<string, string> | undefined): string | null {
  const entries = Object.entries(query ?? {});
  if (entries.length === 0) return "";
  const allowed = spec.query ?? {};
  const parts: string[] = [];
  for (const [k, v] of entries) {
    const kind = Object.prototype.hasOwnProperty.call(allowed, k) ? allowed[k] : undefined;
    if (kind === "bool" && (v === "true" || v === "false")) parts.push(`${k}=${v}`);
    else if (kind === "int" && QUERY_INT_RE.test(v)) parts.push(`${k}=${v}`);
    else return null;
  }
  return `?${parts.join("&")}`;
}

/** 本文を検査する。通れば JSON 文字列(送信にそのまま使う。stringify は1回だけ)も返す。 */
function checkBody(
  spec: OpSpec,
  body: unknown,
): { problem: string; json?: undefined } | { problem: null; json?: string } {
  if (!spec.body) return { problem: body === undefined ? null : "この操作は本文を受け付けません" };
  if (!isObj(body) || Array.isArray(body)) return { problem: "本文の形が正しくありません" };
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch {
    return { problem: "本文の形が正しくありません" };
  }
  if (json.length > BODY_MAX_CHARS[spec.body]) return { problem: "本文が大きすぎます" };
  return { problem: null, json };
}

/**
 * 許可リスト(API_OPS)にある操作だけを、固定のメソッド/パス雛形で Topos へ中継する。
 * 任意パスは受けない。応答は Topos の形のまま返す(整形は画面側の shared の関数)。
 */
export async function callApi(
  input: SharedProjectApiInput,
  deps: CallDeps = {},
): Promise<ApiOutcome> {
  if (!isApiOp(input.op)) return badRequest("不明な操作です");
  const op: ApiOp = input.op;
  const spec: OpSpec = API_OPS[op];
  const route = fillPath(spec, input);
  if (route === null) return badRequest("IDの形が正しくありません");
  const query = buildQuery(spec, input.query);
  if (query === null) return badRequest("指定できない条件です");
  const checked = checkBody(spec, input.body);
  if (checked.problem) return badRequest(checked.problem);

  const callDeps: CallDeps = {
    ...deps,
    timeoutMs: spec.timeoutMs ?? deps.timeoutMs,
    binary: spec.binary === true,
    ...(checked.json !== undefined ? { rawBody: checked.json } : {}),
  };
  const r =
    spec.composite === "thread"
      ? await fetchThreadRaw(input.id ?? "", callDeps)
      : await callTopos<unknown>(spec.method, `${route}${query}`, input.body, callDeps);
  if (r.ok) return { ok: true, status: "ok", data: r.data };
  const reason: FailureReason = r.reason ?? "network";
  return {
    ok: false,
    status: r.status,
    reason,
    // 時間切れは操作ごとの文言(投稿は届いている可能性がある)。それ以外は Topos 由来の理由を優先
    message: reason === "timeout" ? failureText("timeout") : r.message,
    ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
  };
}
