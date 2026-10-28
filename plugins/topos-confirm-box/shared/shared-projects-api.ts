/**
 * 共有プロジェクト「フル機能」の RPC 契約・操作の許可リスト・Topos 応答の読み取り(2026-10-28)。
 *
 * 業務ロジック(宛先の意味・権限・上限・AIの呼び出し)は Topos 本体(`/api/family-projects`)だけが持つ。
 * ここは (1) 画面が使ってよい操作を固定の「メソッド+パス雛形」に束ねる許可リスト、(2) Topos の応答を
 * 型つきで読む小さな関数、(3) 失敗の理由を画面の日本語にする関数、だけを持つ。任意パスの中継は無い。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

// ── 操作の許可リスト ────────────────────────────────────────────────

export type ParamKind = "id" | "nid" | "aid" | "uid" | "v";
export type QueryKind = "bool" | "int";

export interface OpSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** `{id}` `{nid}` `{aid}` `{uid}` `{v}` を入力で埋める。それ以外の文字は固定。 */
  path: string;
  /** 受け付けるクエリ名と型。ここに無い名前は拒否。 */
  query?: Record<string, QueryKind>;
  /** 本文を受けるか。 */
  body?: "json" | "post";
  /** 応答がバイナリ(添付)。base64 のデータURLにして返す。 */
  binary?: boolean;
  /** AIを呼ぶなど遅い操作の待ち時間(ms)。プラグインRPC自体の上限は60秒なので、それ未満にする。 */
  timeoutMs?: number;
  /** 画面側の複合操作(サーバーが複数回呼んで1つにまとめる)。 */
  composite?: "thread";
}

const BASE = "/api/family-projects";

export const API_OPS = {
  list: { method: "GET", path: BASE, query: { archived: "bool" } },
  config: { method: "GET", path: `${BASE}/config` },
  candidates: { method: "GET", path: `${BASE}/candidates` },
  create: { method: "POST", path: BASE, body: "json" },
  order: { method: "PUT", path: `${BASE}/order`, body: "json" },
  archive: { method: "PUT", path: `${BASE}/{id}/archive` },
  unarchive: { method: "DELETE", path: `${BASE}/{id}/archive` },
  project: { method: "GET", path: `${BASE}/{id}` },
  rename: { method: "PUT", path: `${BASE}/{id}/name`, body: "json" },
  description: { method: "PUT", path: `${BASE}/{id}/description`, body: "json" },
  members: { method: "GET", path: `${BASE}/{id}/members` },
  invite: { method: "POST", path: `${BASE}/{id}/members`, body: "json" },
  removeMember: {
    method: "DELETE",
    path: `${BASE}/{id}/members/{uid}`,
    query: { delete_copies: "bool", withdraw_copies: "bool" },
  },
  overview: { method: "GET", path: `${BASE}/{id}/overview` },
  kickoff: { method: "POST", path: `${BASE}/{id}/kickoff`, timeoutMs: 55_000 },
  overviewFinish: { method: "POST", path: `${BASE}/{id}/overview/finish`, timeoutMs: 30_000 },
  thread: { method: "GET", path: `${BASE}/{id}/thread`, composite: "thread" },
  post: { method: "POST", path: `${BASE}/{id}/thread/messages`, body: "post", timeoutMs: 55_000 },
  read: { method: "POST", path: `${BASE}/{id}/thread/read`, body: "json" },
  attachment: {
    method: "GET",
    path: `${BASE}/{id}/attachments/{aid}`,
    binary: true,
    timeoutMs: 30_000,
  },
  catchup: { method: "POST", path: `${BASE}/{id}/catchup`, body: "json", timeoutMs: 55_000 },
  notes: { method: "GET", path: `${BASE}/{id}/notes` },
  note: { method: "GET", path: `${BASE}/{id}/notes/{nid}` },
  noteCreate: { method: "POST", path: `${BASE}/{id}/shared-notes`, body: "json" },
  noteUpdate: { method: "PUT", path: `${BASE}/{id}/shared-notes/{nid}`, body: "json" },
  noteDelete: { method: "DELETE", path: `${BASE}/{id}/shared-notes/{nid}` },
  notesDeleted: { method: "GET", path: `${BASE}/{id}/shared-notes/deleted` },
  noteHistory: { method: "GET", path: `${BASE}/{id}/shared-notes/{nid}/history` },
  noteVersion: { method: "GET", path: `${BASE}/{id}/shared-notes/{nid}/history/{v}` },
  noteRestore: { method: "POST", path: `${BASE}/{id}/shared-notes/{nid}/history/{v}/restore` },
} as const satisfies Record<string, OpSpec>;

export type ApiOp = keyof typeof API_OPS;

export function isApiOp(op: string): op is ApiOp {
  return Object.prototype.hasOwnProperty.call(API_OPS, op);
}

// ── RPC 契約 ────────────────────────────────────────────────────────

export const sharedProjectApiInputSchema = z.object({
  op: z.string(),
  id: z.string().optional(),
  nid: z.string().optional(),
  aid: z.string().optional(),
  uid: z.string().optional(),
  v: z.number().optional(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});
export type SharedProjectApiInput = z.infer<typeof sharedProjectApiInputSchema>;

export const sharedProjectApiRpc = defineRpc({
  name: "topos.projects.api",
  input: sharedProjectApiInputSchema,
  output: z.object({
    ok: z.boolean(),
    /** ok=true のときは "ok"。unconfigured=接続設定が無い / error=失敗(reason に種類)。 */
    status: z.enum(["ok", "unconfigured", "error"]),
    /** Topos の応答(JSON はそのまま。添付は {dataUrl, mime, size})。 */
    data: z.unknown().optional(),
    reason: z.string().optional(),
    httpStatus: z.number().optional(),
    /** Topos が返した理由コード(例 scope_post_text_only)。本文や鍵は含まない。 */
    detail: z.string().optional(),
    message: z.string().optional(),
  }),
});

export type FailureReason =
  | "unconfigured"
  | "config"
  | "unauthorized"
  | "scope"
  | "viewer"
  | "author_only"
  | "forbidden"
  | "not_found"
  | "disabled"
  | "too_large"
  | "unsupported"
  | "invalid"
  | "conflict"
  | "server"
  | "network"
  | "timeout"
  | "bad_request";

/** HTTP 状態と Topos の理由コードから失敗の種類を決める。 */
export function classifyFailure(httpStatus: number, detail: string): FailureReason {
  if (httpStatus === 401) return "unauthorized";
  if (httpStatus === 403) {
    if (detail.startsWith("scope")) return "scope";
    if (detail.includes("viewer")) return "viewer";
    if (detail.includes("author")) return "author_only";
    return "forbidden";
  }
  if (httpStatus === 404) return detail === "attachments_disabled" ? "disabled" : "not_found";
  if (httpStatus === 413) return "too_large";
  if (httpStatus === 415) return "unsupported";
  if (httpStatus === 409) return "conflict";
  if (httpStatus === 400 || httpStatus === 422) return "invalid";
  return httpStatus >= 500 ? "server" : "invalid";
}

/** 画面に出す失敗の文言。detail が日本語の説明文(添付の検証など)なら、そのまま添える。 */
export function failureText(reason: string, detail = ""): string {
  const jp = /[぀-ヿ一-鿿]/.test(detail) && detail.length <= 200 ? detail : "";
  if (jp && DETAIL_FIRST.has(reason)) return jp;
  return FAILURE_TEXT[reason] ?? "失敗しました";
}

/** Topos が日本語の説明文を返したときは、それを優先する理由。 */
const DETAIL_FIRST = new Set(["too_large", "unsupported", "conflict", "invalid"]);

const FAILURE_TEXT: Record<string, string> = {
  unconfigured: "共有プロジェクトの接続設定がありません",
  config: "接続設定に問題があります",
  unauthorized: "Topos に鍵を拒否されました(鍵の期限切れか失効)",
  scope: "この鍵では使えません。フル機能用の鍵(projects_full)に切り替えてください",
  viewer: "このプロジェクトでは閲覧のみのため、書き込みできません",
  author_only: "書いた人かプロジェクトの作成者だけが変更できます",
  forbidden: "権限がないため実行できません",
  not_found: "見つかりません(退出・削除・アーカイブされたか、この鍵では使えない機能です)",
  disabled: "Topos 側でこの機能がオフになっています",
  too_large: "大きすぎるため受け付けられません(添付の大きさ・枚数の上限を確認してください)",
  unsupported: "対応していない形式です",
  conflict: "上限に達しているなど、いまは実行できません",
  invalid: "入力が受け付けられませんでした",
  server: "Topos がエラーを返しました。少し待ってもう一度お試しください",
  timeout: "Topos の応答に時間がかかっています。画面を更新して確認してください",
  network: "Topos に繋がりません",
  bad_request: "この操作は送れません(入力が正しくありません)",
};

// ── Topos 応答の読み取り(形が違うものは捨てる・落とさない) ─────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const ID32 = /^[0-9a-f]{32}$/;

export function isId32(v: unknown): v is string {
  return typeof v === "string" && ID32.test(v);
}

export const LLM_ID = "llm";

export interface Member {
  userId: string;
  name: string;
  role: "member" | "viewer";
  isCreator: boolean;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  members: Member[];
  overviewPending: boolean;
}

export function parseDetail(raw: unknown): ProjectDetail | null {
  if (!isObj(raw) || !isId32(raw.id)) return null;
  const createdBy = str(raw.created_by);
  const members: Member[] = [];
  for (const m of Array.isArray(raw.members) ? raw.members : []) {
    if (!isObj(m) || typeof m.user_id !== "string" || !m.user_id) continue;
    members.push({
      userId: m.user_id,
      name: str(m.display_name) || m.user_id,
      role: m.role === "viewer" ? "viewer" : "member",
      isCreator: m.user_id === createdBy,
    });
  }
  return {
    id: raw.id,
    name: str(raw.name) || "(名前なし)",
    description: str(raw.description),
    createdBy,
    members,
    overviewPending: raw.overview_pending === true,
  };
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  memberCount: number;
}

/** 一覧(`list`)の生の行。並べ替えとアーカイブ済み一覧で使う。 */
export function parseProjectRows(raw: unknown): ProjectRow[] {
  const rows = isObj(raw) && Array.isArray(raw.projects) ? raw.projects : raw;
  const out: ProjectRow[] = [];
  for (const p of Array.isArray(rows) ? rows : []) {
    if (!isObj(p) || !isId32(p.id)) continue;
    out.push({
      id: p.id,
      name: str(p.name) || "(名前なし)",
      description: str(p.description),
      memberCount: num(p.member_count),
    });
  }
  return out;
}

export function parseMembers(raw: unknown): Member[] {
  // /members は配列、project 詳細は members キー。作成者の印は詳細側でしか付かない
  return parseDetail({ id: "0".repeat(32), members: raw })?.members ?? [];
}

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  mime: string;
  size: number;
  withdrawn: boolean;
}

export interface ChatMessage {
  seq: number;
  /** 発言者のID(AI は "llm")。 */
  authorId: string;
  author: string;
  mine: boolean;
  ai: boolean;
  system: boolean;
  text: string;
  ts: string;
  /** 宛先のID(AI は "llm")。 */
  to: string[];
  toNames: string[];
  replyTo: number | null;
  attachments: Attachment[];
}

export interface ThreadView {
  messages: ChatMessage[];
  latestSeq: number;
  lastReadSeq: number;
  unread: number;
  me: string;
}

export function parseThread(raw: unknown): ThreadView | null {
  if (!isObj(raw) || !Array.isArray(raw.messages)) return null;
  const names = isObj(raw.names) ? raw.names : {};
  const me = str(raw.me);
  const nameOf = (id: string) => (typeof names[id] === "string" ? (names[id] as string) : id);
  const messages: ChatMessage[] = [];
  for (const m of raw.messages) {
    if (!isObj(m) || typeof m.seq !== "number") continue;
    const authorId = str(m.author);
    const ai = m.kind === "llm";
    const to = (Array.isArray(m.to) ? m.to : []).filter((x): x is string => typeof x === "string");
    messages.push({
      seq: m.seq,
      authorId,
      author: ai ? "AI" : nameOf(authorId),
      mine: !ai && me !== "" && authorId === me,
      ai,
      system: m.kind === "system",
      text: str(m.text),
      ts: str(m.ts),
      to,
      toNames: to.map((t) => (t === LLM_ID ? "AI" : nameOf(t))),
      replyTo: typeof m.reply_to === "number" ? m.reply_to : null,
      attachments: parseAttachments(m.attachments),
    });
  }
  return {
    messages,
    latestSeq: num(raw.latest_seq),
    lastReadSeq: num(raw.last_read_seq),
    unread: num(raw.unread_count),
    me,
  };
}

function parseAttachments(raw: unknown): Attachment[] {
  const out: Attachment[] = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!isObj(a) || !isId32(a.id)) continue;
    const withdrawn = a.withdrawn === true;
    out.push({
      id: a.id,
      name: withdrawn ? "(取り下げ済み)" : str(a.name) || "ファイル",
      kind: a.kind === "image" ? "image" : "file",
      mime: str(a.mime),
      size: num(a.size),
      withdrawn,
    });
  }
  return out;
}

export interface PostResult {
  message: ChatMessage | null;
  reply: ChatMessage | null;
  llmError: string | null;
  overviewSaved: boolean;
  finishConfirm: boolean;
}

/** 投稿の応答 {message, reply, llm_error, overview_saved, finish_confirm}。 */
export function parsePostResult(raw: unknown, me: string, names: Record<string, string>) {
  if (!isObj(raw)) return null;
  const one = (m: unknown): ChatMessage | null =>
    isObj(m) ? (parseThread({ messages: [m], me, names })?.messages[0] ?? null) : null;
  const r: PostResult = {
    message: one(raw.message),
    reply: one(raw.reply),
    llmError: typeof raw.llm_error === "string" ? raw.llm_error : null,
    overviewSaved: raw.overview_saved === true,
    finishConfirm: raw.finish_confirm === true,
  };
  return r;
}

export interface ProjectConfig {
  createV2: boolean;
  mentionNotify: boolean;
  attach: boolean;
  maxBytes: number;
  maxCount: number;
}

export function parseConfig(raw: unknown): ProjectConfig | null {
  if (!isObj(raw)) return null;
  const lim = isObj(raw.attach_limits) ? raw.attach_limits : {};
  return {
    createV2: raw.create_v2 === true,
    mentionNotify: raw.mention_notify === true,
    attach: raw.attach === true,
    maxBytes: num(lim.max_bytes),
    maxCount: num(lim.max_count),
  };
}

export interface Candidate {
  userId: string;
  name: string;
}

export function parseCandidates(raw: unknown): Candidate[] {
  const out: Candidate[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!isObj(c) || typeof c.user_id !== "string" || !c.user_id) continue;
    out.push({ userId: c.user_id, name: str(c.display_name) || c.user_id });
  }
  return out;
}

export interface NoteSummary {
  id: string;
  title: string;
  author: string;
  updatedAt: string;
  /** Topos が概要ノートとして印を付けたもの(題名「概要」)。 */
  overview: boolean;
}

export interface Note extends NoteSummary {
  body: string;
}

const OVERVIEW_TITLE = "概要";

function toSummary(n: Record<string, unknown>): NoteSummary | null {
  if (!isId32(n.id)) return null;
  return {
    id: n.id,
    title: str(n.title) || "(題名なし)",
    author: str(n.author_name) || str(n.author),
    updatedAt: str(n.updated_at) || str(n.created_at) || str(n.archived_at),
    overview: str(n.title) === OVERVIEW_TITLE,
  };
}

export function parseNoteList(raw: unknown): NoteSummary[] {
  const rows = isObj(raw) && Array.isArray(raw.notes) ? raw.notes : raw;
  const out: NoteSummary[] = [];
  for (const n of Array.isArray(rows) ? rows : []) {
    const s = isObj(n) ? toSummary(n) : null;
    if (s) out.push(s);
  }
  return out;
}

export function parseNote(raw: unknown): Note | null {
  if (!isObj(raw)) return null;
  const s = toSummary(raw);
  return s ? { ...s, body: str(raw.body) } : null;
}

export interface NoteVersion {
  v: number;
  ts: string;
  /** 操作した人のID。 */
  actor: string;
  op: string;
  added: number;
  removed: number;
  restoredFrom: number | null;
}

export function parseVersions(raw: unknown): NoteVersion[] {
  const rows = isObj(raw) && Array.isArray(raw.versions) ? raw.versions : [];
  const out: NoteVersion[] = [];
  for (const r of rows) {
    if (!isObj(r) || typeof r.v !== "number") continue;
    out.push({
      v: r.v,
      ts: str(r.ts),
      actor: str(r.actor),
      op: str(r.op),
      added: num(r.added),
      removed: num(r.removed),
      restoredFrom: typeof r.restored_from === "number" ? r.restored_from : null,
    });
  }
  return out;
}

const OP_LABELS: Record<string, string> = {
  create: "作成",
  update: "編集",
  delete: "削除",
  restore: "復元",
  append: "AIが追記",
};

export function opLabel(op: string): string {
  return OP_LABELS[op] ?? (op || "更新");
}

export interface NoteVersionBody {
  title: string;
  body: string;
}

export function parseVersionBody(raw: unknown): NoteVersionBody | null {
  return isObj(raw) ? { title: str(raw.title), body: str(raw.body) } : null;
}

/** 添付取得(attachment 操作)の data。 */
export function parseAttachmentData(raw: unknown): { dataUrl: string; mime: string } | null {
  if (!isObj(raw) || typeof raw.dataUrl !== "string" || !raw.dataUrl.startsWith("data:"))
    return null;
  return { dataUrl: raw.dataUrl, mime: str(raw.mime) };
}

// ── 宛先(Topos の to の意味は Topos 側。ここは画面の選択を配列にするだけ) ────────

export interface RecipientChoice {
  /** AI に聞くか。 */
  ai: boolean;
  /** 名指しするメンバーのID。 */
  people: string[];
}

/**
 * 宛先の配列にする。Topos: 省略=AI宛、[]=全員宛(AIなし)、["llm", 個人ID…]=指名。
 * 既定の選択 {ai:true, people:[]} は省略(null)にして Topos の既定に任せる。
 */
export function buildRecipients(c: RecipientChoice): string[] | null {
  if (c.ai && c.people.length === 0) return null;
  return [...(c.ai ? [LLM_ID] : []), ...c.people];
}

export function recipientSummary(c: RecipientChoice, members: readonly Member[]): string {
  const names = c.people.map((id) => members.find((m) => m.userId === id)?.name ?? id);
  const all = [...(c.ai ? ["AI"] : []), ...names];
  return all.length === 0 ? "全員(AIには聞きません)" : all.join("・");
}

/** 書き込みできるか(閲覧のみは false)。メンバー外・不明は false。 */
export function canWrite(members: readonly Member[], me: string): boolean {
  const m = members.find((x) => x.userId === me);
  return m !== undefined && m.role !== "viewer";
}

export function isCreator(detail: ProjectDetail | null, me: string): boolean {
  return detail !== null && me !== "" && detail.createdBy === me;
}

/** 並べ替え: ids の index を delta だけ動かした新しい並び(端は動かさない)。 */
export function moveId(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ── 添付(ブラウザで選んだファイルの検査) ─────────────────────────────

export interface PickedFile {
  filename: string;
  mime_type: string;
  data_base64: string;
  /** 元の大きさ(byte)。送信には含めない。 */
  size: number;
}

/** 添付を足してよいか。上限は Topos の config(attach_limits)。理由があれば文言を返す。 */
export function checkAttachAdd(
  current: readonly { size: number }[],
  addSize: number,
  limits: { maxBytes: number; maxCount: number },
): string | null {
  if (limits.maxCount > 0 && current.length >= limits.maxCount)
    return `1回に付けられるのは${limits.maxCount}件までです`;
  if (limits.maxBytes > 0 && addSize > limits.maxBytes)
    return `1件あたり${formatBytes(limits.maxBytes)}までです`;
  return null;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** 本文の「@名前」を拾って強調するための分割。名前の長い順に照合(「あ」より「あい」を先に)。 */
export interface MentionPart {
  id: string;
  text: string;
  mention: boolean;
}

export function splitMentions(text: string, names: readonly string[]): MentionPart[] {
  const uniq = [...new Set(names.filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  const parts: MentionPart[] = [];
  let buf = "";
  const flush = () => {
    if (buf) parts.push({ id: `m${parts.length}`, text: buf, mention: false });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const hit = text[i] === "@" ? uniq.find((n) => text.startsWith(n, i + 1)) : undefined;
    if (hit) {
      flush();
      parts.push({ id: `m${parts.length}`, text: `@${hit}`, mention: true });
      i += hit.length + 1;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return parts;
}
