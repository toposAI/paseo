#!/usr/bin/env node
/* eslint-disable complexity, max-nested-callbacks, no-shadow -- 開発用の模擬サーバー(配布物に含めない)。ルート表を1か所に並べる方が読みやすい */
/**
 * 開発用の Topos 模擬サーバー(ループバック専用・node 標準だけ・外へは何も送らない)。
 * 共有プロジェクトの /api/family-projects を、Topos と同じ形で返す。データはメモリ上(再起動で初期化)。
 *
 *   node plugins/topos-confirm-box/dev/mock-topos.mjs [--port 18777]
 *
 * 鍵(Authorization: Bearer ...)で挙動が変わる:
 *   mock-full-key ... フル機能(projects_full 相当)
 *   mock-old-key  ... 旧鍵(本文だけ)。/config などは 404、宛先・添付つきの投稿は 403 scope_post_text_only
 * 想定ユーザー(Tailscale-User-Login ヘッダ): me@mock.local = 「あなた」
 *
 * 失敗の再現(プロジェクト別):
 *   「閲覧のみの家計」 ... あなたは viewer(書き込みは 403 viewer)
 *   本文に「[413]」を含めて投稿 ... 413、「[404]」... 404、「[500]」... 500、「[slow]」... 応答を70秒遅らせる
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || 18777;
const FULL_KEY = "mock-full-key";
const OLD_KEY = "mock-old-key";
const ME = "me";
const LLM = "llm";

const id32 = () => crypto.randomBytes(16).toString("hex");
const now = (minAgo = 0) => new Date(Date.now() - minAgo * 60_000).toISOString();

// 1x1 の PNG(画像添付の中身)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const USERS = { me: "あなた", hanako: "花子", taro: "太郎", jiro: "次郎" };

function makeProject(name, description, members, opts = {}) {
  return {
    id: id32(),
    name,
    description,
    created_by: opts.createdBy ?? ME,
    members: members.map((m) => ({ user_id: m, display_name: USERS[m], role: opts.viewer && m === ME ? "viewer" : "member" })),
    archived: false,
    overview_pending: opts.overviewPending ?? false,
    messages: [],
    lastRead: 0,
    notes: [],
    deletedNotes: [],
    attachments: new Map(),
  };
}

const state = { projects: [] };

function addMsg(p, m) {
  const seq = p.messages.length + 1;
  const msg = { seq, ts: now(60 - seq), kind: "user", to: [], attachments: [], ...m };
  p.messages.push(msg);
  return msg;
}

function addNote(p, title, body, author = ME) {
  const note = {
    id: id32(),
    title,
    body,
    author,
    created_at: now(300),
    updated_at: now(30),
    versions: [{ v: 1, ts: now(300), actor: author, op: "create", added: body.split("\n").length, removed: 0, restored_from: null, title, body }],
  };
  p.notes.push(note);
  return note;
}

function seed() {
  const a = makeProject("夏の家族旅行", "8月の北海道旅行の計画", [ME, "hanako", "taro"]);
  addMsg(a, { author: "hanako", text: "宿は函館と札幌で迷ってます" });
  addMsg(a, { author: "taro", text: "@花子 函館の朝市は行きたい", to: ["hanako"] });
  const img = id32();
  a.attachments.set(img, { name: "hakodate.png", mime: "image/png", data: PNG });
  const pdf = id32();
  a.attachments.set(pdf, { name: "plan.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.1 mock") });
  addMsg(a, {
    author: "hanako",
    text: "候補の写真と日程表です",
    attachments: [
      { id: img, name: "hakodate.png", kind: "image", mime: "image/png", size: PNG.length },
      { id: pdf, name: "plan.pdf", kind: "file", mime: "application/pdf", size: 13 },
    ],
  });
  addMsg(a, { author: ME, text: "AIさん、函館と札幌の違いを教えて", to: [LLM] });
  addMsg(a, {
    kind: "llm",
    author: LLM,
    text: "## 函館と札幌\n\n- **函館**: 港町・夜景・朝市\n- **札幌**: 都市観光・グルメ\n\n日程が短いなら函館中心がおすすめです。",
    to: [ME],
  });
  addMsg(a, { author: "taro", text: "@あなた 見積もりは明日出します", to: [ME] });
  a.lastRead = 4; // 未読3件(うち自分宛て1件)
  const note1 = addNote(a, "概要", "# 夏の家族旅行\n\n8月の北海道旅行。予算は一人10万円まで。");
  note1.updated_at = now(20);
  const note2 = addNote(a, "持ち物リスト", "- パスポート不要\n- 上着\n- 日焼け止め", "hanako");
  note2.body = "- パスポート不要\n- 上着\n- 日焼け止め\n- 酔い止め";
  note2.versions.push({ v: 2, ts: now(120), actor: "taro", op: "update", added: 1, removed: 0, restored_from: null, title: note2.title, body: note2.body });
  const gone = addNote(a, "古い案", "札幌だけ2泊", "taro");
  a.notes = a.notes.filter((n) => n !== gone);
  gone.archived_at = now(90);
  gone.versions.push({ v: 2, ts: now(90), actor: "taro", op: "delete", added: 0, removed: 1, restored_from: null, title: gone.title, body: gone.body });
  a.deletedNotes.push(gone);

  const b = makeProject("閲覧のみの家計", "あなたは閲覧のみのメンバー", [ME, "hanako"], { createdBy: "hanako", viewer: true });
  addMsg(b, { author: "hanako", text: "今月の支出をまとめました" });
  addNote(b, "概要", "家計の共有メモ", "hanako");
  b.lastRead = 1;

  const c = makeProject("新しい企画(聞き取り中)", "", [ME], { overviewPending: true });

  const d = makeProject("終わった旅行", "アーカイブ済みの例", [ME, "jiro"]);
  addMsg(d, { author: "jiro", text: "お疲れさまでした" });
  d.archived = true;

  state.projects = [a, b, c, d];
}
seed();

// ── ヘルパ ───────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

const find = (pid) => {
  const p = state.projects.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, "project_not_found");
  return p;
};
const isViewer = (p) => p.members.find((m) => m.user_id === ME)?.role === "viewer";
const isCreator = (p) => p.created_by === ME;
const needWriter = (p) => {
  if (isViewer(p)) throw new HttpError(403, "viewer_cannot_write");
};
const needCreator = (p) => {
  if (!isCreator(p)) throw new HttpError(403, "creator_only");
};
const noteOf = (p, nid) => {
  const n = [...p.notes, ...p.deletedNotes].find((x) => x.id === nid);
  if (!n) throw new HttpError(404, "note_not_found");
  return n;
};
const names = (p) => ({ ...USERS, ...Object.fromEntries(p.members.map((m) => [m.user_id, m.display_name])) });

function lastOf(p) {
  const m = p.messages.at(-1);
  if (!m) return null;
  return { author: m.author, author_name: m.kind === "llm" ? "AI" : USERS[m.author] ?? m.author, text: m.text, ts: m.ts, attachments_only: !m.text && m.attachments.length > 0 };
}
function summary(p) {
  const unread = p.messages.filter((m) => m.seq > p.lastRead && m.author !== ME).length;
  const mentions = p.messages.filter((m) => m.seq > p.lastRead && m.author !== ME && m.to.includes(ME)).length;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    member_count: p.members.length,
    unread_count: unread,
    mentions_me: mentions,
    latest_seq: p.messages.length,
    last_message: lastOf(p),
  };
}
function detail(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    created_by: p.created_by,
    members: p.members,
    overview_pending: p.overview_pending,
  };
}
const noteSummary = (n) => ({ id: n.id, title: n.title, author: n.author, author_name: USERS[n.author] ?? n.author, updated_at: n.updated_at, created_at: n.created_at, ...(n.archived_at ? { archived_at: n.archived_at } : {}) });

/** 行単位の増減(同じ行は数えない)。実 Topos の差分に近い数え方。 */
function lineDiff(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  return { added: b.filter((l) => !a.includes(l)).length, removed: a.filter((l) => !b.includes(l)).length };
}

const sleep =(ms) => new Promise((r) => setTimeout(r, ms));
const mimeOk = (m) => /^(image\/|application\/pdf|text\/plain)/.test(m);

// ── ルーティング ─────────────────────────────────────────────────────

async function route(req, body, fullKey) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // api family-projects ...
  if (parts[0] !== "api" || parts[1] !== "family-projects") throw new HttpError(404, "not_found");
  const rest = parts.slice(2);
  const m = req.method;
  const limitedPaths = new Set(["", "thread", "thread/messages", "thread/read"]);

  // 旧鍵: 一覧・スレ・投稿・既読だけ。他は 404(Topos の範囲つきトークンと同じ)
  if (!fullKey) {
    const isId = rest[0] && /^[0-9a-f]{32}$/.test(rest[0]);
    const tail = isId ? rest.slice(1).join("/") : rest.join("/");
    const ok = (isId ? limitedPaths.has(tail) && tail !== "" : tail === "") ;
    if (!ok) throw new HttpError(404, "not_found");
  }

  if (rest.length === 0) {
    if (m === "GET") return state.projects.filter((p) => p.archived === (url.searchParams.get("archived") === "true")).map(summary);
    if (m === "POST") {
      if (!body?.name || String(body.name).length > 80) throw new HttpError(422, "名前は1〜80文字で入力してください");
      const ids = [ME, ...(Array.isArray(body.invitees) ? body.invitees.filter((u) => USERS[u] && u !== ME) : [])];
      const p = makeProject(String(body.name), String(body.description ?? "").slice(0, 200), ids, { overviewPending: true });
      state.projects.unshift(p);
      return { id: p.id, name: p.name };
    }
  }
  if (rest[0] === "config" && m === "GET") {
    return { create_v2: true, mention_notify: true, attach: true, attach_limits: { max_bytes: 5 * 1024 * 1024, max_count: 4 } };
  }
  if (rest[0] === "candidates" && m === "GET") {
    return Object.entries(USERS).filter(([u]) => u !== ME).map(([user_id, display_name]) => ({ user_id, display_name }));
  }
  if (rest[0] === "order" && m === "PUT") {
    const order = Array.isArray(body?.ids) ? body.ids : [];
    state.projects.sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
    return { ok: true };
  }

  const p = find(rest[0]);
  const sub = rest.slice(1);
  const key = sub.join("/");

  if (sub.length === 0 && m === "GET") return detail(p);
  if (key === "archive") {
    if (m === "PUT") p.archived = true;
    else if (m === "DELETE") p.archived = false;
    else throw new HttpError(405, "method_not_allowed");
    return { ok: true };
  }
  if (key === "name" && m === "PUT") {
    needWriter(p);
    const name = String(body?.name ?? "").trim();
    if (!name || name.length > 80) throw new HttpError(422, "名前は1〜80文字で入力してください");
    p.name = name;
    return detail(p);
  }
  if (key === "description" && m === "PUT") {
    needWriter(p);
    p.description = String(body?.description ?? "").slice(0, 200);
    return detail(p);
  }
  if (key === "members" && m === "GET") return p.members;
  if (key === "members" && m === "POST") {
    needCreator(p);
    const u = String(body?.user_id ?? "");
    if (!USERS[u]) throw new HttpError(404, "user_not_found");
    if (!p.members.some((x) => x.user_id === u)) p.members.push({ user_id: u, display_name: USERS[u], role: "member" });
    return p.members;
  }
  if (sub[0] === "members" && sub.length === 2 && m === "DELETE") {
    const uid = sub[1];
    if (uid !== ME) needCreator(p);
    if (uid === p.created_by) throw new HttpError(409, "作成者は脱退できません。プロジェクトをアーカイブしてください");
    p.members = p.members.filter((x) => x.user_id !== uid);
    if (uid === ME) state.projects = state.projects.filter((x) => x !== p);
    return { ok: true };
  }
  if (key === "overview" && m === "GET") {
    const n = p.notes.find((x) => x.title === "概要");
    return n ? { note_id: n.id } : { note_id: null };
  }
  if (key === "kickoff" && m === "POST") {
    if (p.messages.length === 0) addMsg(p, { kind: "llm", author: LLM, text: "はじめまして。このプロジェクトは何を目指しますか?(目的・期限・関わる人を教えてください)", to: [ME] });
    return { ok: true };
  }
  if (key === "overview/finish" && m === "POST") {
    needCreator(p);
    p.overview_pending = false;
    addNote(p, "概要", "# 概要\n\nここまでの聞き取りから作成した概要です。");
    addMsg(p, { kind: "system", author: "system", text: "概要ノートを作成しました" });
    return { ok: true };
  }
  if (key === "thread" && m === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
    const msgs = p.messages.filter((x) => x.seq > after).slice(0, limit);
    return {
      messages: msgs,
      names: names(p),
      me: ME,
      latest_seq: p.messages.length,
      last_read_seq: p.lastRead,
      unread_count: p.messages.filter((x) => x.seq > p.lastRead && x.author !== ME).length,
    };
  }
  if (key === "thread/read" && m === "POST") {
    p.lastRead = Math.max(p.lastRead, Number(body?.seq) || 0);
    return { ok: true };
  }
  if (key === "thread/messages" && m === "POST") return await post(p, body, fullKey);
  if (sub[0] === "attachments" && sub.length === 2 && m === "GET") {
    const a = p.attachments.get(sub[1]);
    if (!a) throw new HttpError(404, "attachment_not_found");
    return { __binary: a };
  }
  if (key === "catchup" && m === "POST") {
    await sleep(600);
    const since = Number(body?.since_seq) || 0;
    const n = p.messages.filter((x) => x.seq > since).length;
    const q = String(body?.question ?? "").trim();
    return { text: q ? `(模擬回答)「${q}」について: ${n}件の新しい投稿があり、見積もりの話が出ています。` : `(模擬要約)前回から${n}件の投稿があります。函館の宿と見積もりの話が中心です。` };
  }
  return notes(p, sub, key, m, body);
}

async function post(p, body, fullKey) {
  needWriter(p);
  const text = String(body?.text ?? "");
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  const hasTo = Array.isArray(body?.to) && body.to.length > 0;
  if (!fullKey && (hasTo || attachments.length > 0)) throw new HttpError(403, "scope_post_text_only");
  if (!text.trim() && attachments.length === 0) throw new HttpError(422, "本文か添付が必要です");
  if (text.length > 8000) throw new HttpError(413, "本文が長すぎます(8000文字まで)");
  if (text.includes("[413]")) throw new HttpError(413, "添付が大きすぎます(1件 5MB まで)");
  if (text.includes("[404]")) throw new HttpError(404, "project_not_found");
  if (text.includes("[500]")) throw new HttpError(500, "internal");
  if (text.includes("[slow]")) await sleep(70_000);
  const saved = [];
  for (const a of attachments) {
    if (!mimeOk(String(a.mime_type))) throw new HttpError(415, "この種類のファイルは添付できません");
    const data = Buffer.from(String(a.data_base64 ?? ""), "base64");
    if (data.length > 5 * 1024 * 1024) throw new HttpError(413, "添付が大きすぎます(1件 5MB まで)");
    const aid = id32();
    p.attachments.set(aid, { name: String(a.filename), mime: String(a.mime_type), data });
    saved.push({ id: aid, name: String(a.filename), kind: String(a.mime_type).startsWith("image/") ? "image" : "file", mime: String(a.mime_type), size: data.length });
  }
  const aiAsked = body?.to === undefined || body.to === null || (Array.isArray(body.to) && body.to.includes(LLM));
  const to = Array.isArray(body?.to) ? body.to : [LLM];
  const message = addMsg(p, { author: ME, text, to, attachments: saved });
  const result = { message, reply: null, llm_error: null, overview_saved: false, finish_confirm: false };
  if (!aiAsked) return result;
  await sleep(1200);
  if (text.includes("[llm_error]")) return { ...result, llm_error: "llm_failed" };
  const reply = addMsg(p, { kind: "llm", author: LLM, text: `(模擬AI)受け取りました。\n\n1. 「${text.slice(0, 30)}」\n2. 続きを **Markdown** で返します`, to: [ME] });
  result.reply = reply;
  if (p.overview_pending && text.includes("[finish]")) result.finish_confirm = true;
  return result;
}

function notes(p, sub, key, m, body) {
  if (key === "notes" && m === "GET") return { notes: p.notes.map(noteSummary) };
  if (sub[0] === "notes" && sub.length === 2 && m === "GET") return { ...noteSummary(noteOf(p, sub[1])), body: noteOf(p, sub[1]).body };
  if (key === "shared-notes" && m === "POST") {
    needWriter(p);
    const title = String(body?.title ?? "").trim();
    if (!title || title.length > 200) throw new HttpError(422, "題名は1〜200文字で入力してください");
    const n = addNote(p, title, String(body?.body ?? ""));
    return { ...noteSummary(n), body: n.body };
  }
  if (key === "shared-notes/deleted" && m === "GET") return { notes: p.deletedNotes.map(noteSummary) };
  if (sub[0] === "shared-notes" && sub.length === 2 && m === "PUT") {
    needWriter(p);
    const n = noteOf(p, sub[1]);
    const before = n.body;
    n.title = String(body?.title ?? n.title);
    n.body = String(body?.body ?? n.body);
    n.updated_at = now();
    n.versions.push({ v: n.versions.length + 1, ts: now(), actor: ME, op: "update", ...lineDiff(before, n.body), restored_from: null, title: n.title, body: n.body });
    return { ...noteSummary(n), body: n.body };
  }
  if (sub[0] === "shared-notes" && sub.length === 2 && m === "DELETE") {
    needWriter(p);
    const n = noteOf(p, sub[1]);
    p.notes = p.notes.filter((x) => x !== n);
    n.archived_at = now();
    n.versions.push({ v: n.versions.length + 1, ts: now(), actor: ME, op: "delete", added: 0, removed: 1, restored_from: null, title: n.title, body: n.body });
    p.deletedNotes.push(n);
    return { ok: true };
  }
  if (sub[0] === "shared-notes" && sub[2] === "history" && sub.length === 3 && m === "GET") {
    const n = noteOf(p, sub[1]);
    return { versions: n.versions.map(({ title: _t, body: _b, ...v }) => v) };
  }
  if (sub[0] === "shared-notes" && sub[2] === "history" && sub.length === 4 && m === "GET") {
    const v = noteOf(p, sub[1]).versions.find((x) => x.v === Number(sub[3]));
    if (!v) throw new HttpError(404, "version_not_found");
    return { title: v.title, body: v.body };
  }
  if (sub[0] === "shared-notes" && sub[2] === "history" && sub[4] === "restore" && m === "POST") {
    needWriter(p);
    const n = noteOf(p, sub[1]);
    const v = n.versions.find((x) => x.v === Number(sub[3]));
    if (!v) throw new HttpError(404, "version_not_found");
    n.title = v.title;
    n.body = v.body;
    n.updated_at = now();
    delete n.archived_at;
    p.deletedNotes = p.deletedNotes.filter((x) => x !== n);
    if (!p.notes.includes(n)) p.notes.push(n);
    n.versions.push({ v: n.versions.length + 1, ts: now(), actor: ME, op: "restore", ...lineDiff(n.body, v.body), restored_from: v.v, title: n.title, body: n.body });
    return { ...noteSummary(n), body: n.body };
  }
  throw new HttpError(404, "not_found");
}

// ── HTTP ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      // 鍵と本文は決して表示しない。メソッドとパスだけ(ID は短縮)
      const short = (req.url ?? "").replace(/[0-9a-f]{32}/g, (s) => s.slice(0, 6));
      try {
        const auth = req.headers.authorization ?? "";
        const key = auth.replace(/^Bearer\s+/i, "");
        if (key !== FULL_KEY && key !== OLD_KEY) throw new HttpError(401, "invalid_token");
        if (req.headers["tailscale-user-login"] !== "me@mock.local") throw new HttpError(401, "identity");
        let body;
        if (chunks.length > 0) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw new HttpError(400, "bad_json");
          }
        }
        const out = await route(req, body, key === FULL_KEY);
        if (out && out.__binary) {
          res.writeHead(200, { "content-type": out.__binary.mime });
          res.end(out.__binary.data);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        }
        console.log(`${req.method} ${short} -> 200`);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        const detail = e instanceof HttpError ? e.detail : "internal";
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail }));
        console.log(`${req.method} ${short} -> ${status} ${detail}`);
      }
    })();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-topos: http://127.0.0.1:${PORT}  (full key: ${FULL_KEY} / old key: ${OLD_KEY})`);
});
