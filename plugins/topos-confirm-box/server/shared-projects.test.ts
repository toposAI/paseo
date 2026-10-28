import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecipients,
  canWrite,
  checkAttachAdd,
  classifyFailure,
  failureText,
  formatBytes,
  moveId,
  opLabel,
  parseAttachmentData,
  parseConfig,
  parseDetail,
  parseNoteList,
  parsePostResult,
  parseProjectRows,
  parseVersions,
  recipientSummary,
  splitMentions,
  type SharedProjectApiInput,
} from "../shared/shared-projects-api.js";
import {
  callApi,
  callTopos,
  fetchThread,
  listProjects,
  loadConfig,
  markRead,
  postMessage,
  toMessages,
  toProjects,
  type Loaded,
} from "./shared-projects.js";
import {
  canPost,
  emptyProjectsLabel,
  shortTime,
  totalUnread,
  unreadLabel,
} from "../shared/shared-projects.js";

const PID = "a".repeat(32);
const OK: Loaded = {
  ok: true,
  token: "dummy-token",
  config: {
    login: "me@example.invalid",
    origin: "https://topos.example",
    baseUrl: "http://127.0.0.1:8777",
    tokenFile: "/x",
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sp-"));
}

test("設定が無ければ unconfigured(取りに行かない)", async () => {
  const missing = path.join(tmp(), "none.json");
  let called = false;
  const r = await listProjects({
    load: () => loadConfig(missing),
    fetchImpl: async () => {
      called = true;
      return json([]);
    },
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, "unconfigured");
  assert.equal(called, false);
});

test("鍵ファイルの権限が緩いと使わない(値は出さない)", () => {
  const d = tmp();
  const tok = path.join(d, "t");
  fs.writeFileSync(tok, "secret-value", { mode: 0o644 });
  fs.chmodSync(tok, 0o644);
  const cfg = path.join(d, "c.json");
  fs.writeFileSync(cfg, JSON.stringify({ login: "a", origin: "https://x", tokenFile: tok }));
  const r = loadConfig(cfg);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("secret-value"));
  fs.chmodSync(tok, 0o600);
  const ok = loadConfig(cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.config.baseUrl, "http://127.0.0.1:8777");
});

test("baseUrl はループバックだけ", () => {
  const d = tmp();
  const tok = path.join(d, "t");
  fs.writeFileSync(tok, "v", { mode: 0o600 });
  const cfg = path.join(d, "c.json");
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      login: "a",
      origin: "https://x",
      tokenFile: tok,
      baseUrl: "https://evil.example",
    }),
  );
  const r = loadConfig(cfg);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, "error");
});

test("ヘッダ: identity・Bearer・Origin を付けて叩く", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  await callTopos("GET", "/api/family-projects", undefined, {
    load: () => OK,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return json([]);
    },
  });
  assert.ok(seen);
  const s = seen as { url: string; init: RequestInit };
  assert.equal(s.url, "http://127.0.0.1:8777/api/family-projects");
  const h = s.init.headers as Record<string, string>;
  assert.equal(h["Tailscale-User-Login"], "me@example.invalid");
  assert.equal(h.Authorization, "Bearer dummy-token");
  assert.equal(h.Origin, "https://topos.example");
});

test("HTTP エラーは種類つきの文言(鍵・本文は載せない)", async () => {
  for (const [status, word] of [
    [401, "401"],
    [403, "403"],
    [404, "404"],
    [500, "500"],
  ] as const) {
    const r = await listProjects({
      load: () => OK,
      fetchImpl: async () => json({ detail: "x" }, status),
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.message.includes(word));
    assert.ok(!JSON.stringify(r).includes("dummy-token"));
  }
});

test("接続失敗は error(例外にしない)", async () => {
  const r = await listProjects({
    load: () => OK,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(!r.ok && r.status, "error");
});

test("一覧の整形: 不正な行は捨て、最新1行と未読を出す", () => {
  const out = toProjects([
    {
      id: PID,
      name: "旅行",
      description: "d",
      member_count: 3,
      unread_count: 2,
      mentions_me: 1,
      latest_seq: 9,
      last_message: {
        author: "bob",
        author_name: "ボブ",
        text: "やあ",
        ts: "2026-10-27T01:00:00Z",
      },
    },
    { id: "bad", name: "x" },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(
    [out[0].name, out[0].unread, out[0].mentions, out[0].last?.author, out[0].last?.text],
    ["旅行", 2, 1, "ボブ", "やあ"],
  );
  assert.deepEqual(toProjects("nope"), []);
});

test("スレッドの整形: 表示名・自分・AI・添付数", () => {
  const r = toMessages({
    me: "alice",
    names: { alice: "アリス", bob: "ボブ" },
    latest_seq: 3,
    unread_count: 1,
    messages: [
      { seq: 1, author: "alice", kind: "user", text: "a", ts: "t", to: ["bob"] },
      { seq: 2, author: "bob", kind: "user", text: "b", ts: "t", to: [], attachments: [{}, {}] },
      { seq: 3, author: "llm", kind: "llm", text: "c", ts: "t" },
      { author: "x" },
    ],
  });
  assert.equal(r.messages.length, 3);
  assert.deepEqual(
    r.messages.map((m) => [m.author, m.mine, m.ai, m.attachments]),
    [
      ["アリス", true, false, 0],
      ["ボブ", false, false, 2],
      ["AI", false, true, 0],
    ],
  );
  assert.deepEqual(r.messages[0].to, ["ボブ"]);
  assert.equal(r.latestSeq, 3);
  assert.equal(r.shownMaxSeq, 3);
  assert.equal(r.unread, 1);
});

test("スレッドは件数→最新側の2回で取る", async () => {
  const urls: string[] = [];
  const r = await fetchThread(PID, {
    load: () => OK,
    fetchImpl: async (url) => {
      urls.push(url);
      return json({ messages: [], latest_seq: 250 });
    },
  });
  assert.equal(r.ok, true);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes("after=2000000000&limit=1"));
  assert.ok(urls[1].includes("after=150&limit=100"));
});

test("投稿: 宛先なし・空/長すぎは送らない・不正IDは送らない", async () => {
  let body: unknown = null;
  const deps = {
    load: () => OK,
    fetchImpl: async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return json({ message: {} }, 201);
    },
  };
  assert.equal((await postMessage(PID, "  こんにちは  ", deps)).ok, true);
  assert.deepEqual(body, { text: "こんにちは", to: [] });
  body = null;
  assert.equal((await postMessage(PID, "   ", deps)).ok, false);
  assert.equal((await postMessage(PID, "x".repeat(8001), deps)).ok, false);
  assert.equal((await postMessage("../x", "a", deps)).ok, false);
  assert.equal(body, null);
});

test("既読: seq を送る・不正IDは送らない", async () => {
  let body: unknown = null;
  const deps = {
    load: () => OK,
    fetchImpl: async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return json({ last_read_seq: 5 });
    },
  };
  assert.equal((await markRead(PID, 5, deps)).ok, true);
  assert.deepEqual(body, { seq: 5 });
  assert.equal((await markRead("zz", 5, deps)).ok, false);
});

test("純粋関数: 未読表示・合計・空文言・投稿可否・時刻", () => {
  assert.equal(unreadLabel(0), "");
  assert.equal(unreadLabel(5), "5");
  assert.equal(unreadLabel(120), "99+");
  assert.equal(totalUnread([{ unread: 2 }, { unread: -1 }, { unread: 3 }]), 5);
  assert.notEqual(emptyProjectsLabel("unconfigured"), emptyProjectsLabel("ok"));
  assert.notEqual(emptyProjectsLabel("error"), emptyProjectsLabel("ok"));
  assert.equal(canPost("  "), false);
  assert.equal(canPost("a"), true);
  assert.equal(shortTime("not-a-date"), "not-a-date");
  assert.match(shortTime("2026-10-27T01:02:00Z"), /^\d+\/\d+ \d\d:\d\d$/);
});

test("形が想定と違う応答は『0件』にせずエラーにする", async () => {
  const deps = (data: unknown) => ({ load: () => OK, fetchImpl: async () => json(data) });
  const l = await listProjects(deps({ detail: "x" }));
  assert.equal(l.ok, false);
  const t = await fetchThread(PID, deps({ latest_seq: 1 }));
  assert.equal(t.ok, false);
});

test("404の文言: 一覧は鍵の案内・個別プロジェクトは見つからない", async () => {
  const deps = { load: () => OK, fetchImpl: async () => json({}, 404) };
  const l = await listProjects(deps);
  const t = await fetchThread(PID, deps);
  assert.ok(!l.ok && !t.ok);
  assert.notEqual(l.message, t.message);
  assert.match(String(t.message), /見つかりません/);
});

test("投稿が時間切れなら『送れたか不明』と返す", async () => {
  const deps = {
    load: () => OK,
    fetchImpl: async () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    },
  };
  const r = await postMessage(PID, "a", deps);
  assert.equal(r.ok, false);
  assert.match(String(r.message), /送れたか不明/);
});

// ── 許可リスト方式の汎用呼び出し(callApi) ───────────────────────────

interface Seen {
  url: string;
  method: string;
  body: string | undefined;
}

function recorder(res: () => Response) {
  const seen: Seen[] = [];
  const deps = {
    load: () => OK,
    fetchImpl: async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), body: init.body as string | undefined });
      return res();
    },
  };
  return { seen, deps };
}

test("callApi: 許可リスト外の操作・不正なID・不正な条件・不正な本文は送らない", async () => {
  const { seen, deps } = recorder(() => json({}));
  const bad: SharedProjectApiInput[] = [
    { op: "constructor" },
    { op: "../../admin" },
    { op: "project", id: "zz" },
    { op: "project", id: `${PID}/../x` },
    { op: "removeMember", id: PID, uid: "a/b" },
    { op: "list", query: { evil: "1" } },
    { op: "list", query: { archived: "maybe" } },
    { op: "project", id: PID, body: { x: 1 } },
    { op: "rename", id: PID, body: "text" },
    { op: "rename", id: PID, body: [1] },
    { op: "noteVersion", id: PID, nid: PID, v: 0 },
    { op: "noteVersion", id: PID, nid: PID, v: 1.5 },
  ];
  for (const input of bad) {
    const r = await callApi(input, deps);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.reason, "bad_request");
  }
  assert.equal(seen.length, 0);
});

test("callApi: メソッドとパスは固定の雛形から組み立てる(PUT/DELETE/クエリ)", async () => {
  const { seen, deps } = recorder(() => json({ ok: true }));
  await callApi({ op: "rename", id: PID, body: { name: "新" } }, deps);
  await callApi({ op: "unarchive", id: PID }, deps);
  await callApi(
    { op: "removeMember", id: PID, uid: "hanako", query: { withdraw_copies: "false" } },
    deps,
  );
  await callApi({ op: "list", query: { archived: "true" } }, deps);
  await callApi({ op: "noteRestore", id: PID, nid: PID, v: 3 }, deps);
  const got = seen.map((s) => `${s.method} ${s.url.replace("http://127.0.0.1:8777", "")}`);
  assert.deepEqual(got, [
    `PUT /api/family-projects/${PID}/name`,
    `DELETE /api/family-projects/${PID}/archive`,
    `DELETE /api/family-projects/${PID}/members/hanako?withdraw_copies=false`,
    "GET /api/family-projects?archived=true",
    `POST /api/family-projects/${PID}/shared-notes/${PID}/history/3/restore`,
  ]);
  assert.equal(seen[0].body, JSON.stringify({ name: "新" }));
});

test("callApi: 失敗の種類(旧鍵・閲覧のみ・413・404・時間切れ)を画面が出せる形で返す", async () => {
  const cases: [number, string, string][] = [
    [403, "scope_post_text_only", "scope"],
    [403, "viewer_cannot_write", "viewer"],
    [403, "author_only", "author_only"],
    [413, "大きすぎます", "too_large"],
    [404, "not_found", "not_found"],
    [401, "x", "unauthorized"],
    [500, "internal", "server"],
  ];
  for (const [status, detail, reason] of cases) {
    const { deps } = recorder(() => json({ detail }, status));
    const r = await callApi({ op: "post", id: PID, body: { text: "a", to: ["llm"] } }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(r.httpStatus, status);
    assert.equal(r.detail, detail);
  }
  const timeout = {
    load: () => OK,
    fetchImpl: async () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    },
  };
  const t = await callApi({ op: "post", id: PID, body: { text: "a" } }, timeout);
  assert.equal(!t.ok && t.reason, "timeout");
  assert.match(String(!t.ok && t.message), /時間がかかっています/);
});

test("callApi: 添付はバイナリを許可MIMEだけデータURLにする", async () => {
  const png = () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  const r1 = await callApi({ op: "attachment", id: PID, aid: PID }, recorder(png).deps);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.ok && r1.data, {
    dataUrl: "data:image/png;base64,AQID",
    mime: "image/png",
    size: 3,
  });
  const html = () => new Response("<script>", { headers: { "content-type": "text/html" } });
  const r2 = await callApi({ op: "attachment", id: PID, aid: PID }, recorder(html).deps);
  assert.equal(r2.ok ? (r2.data as { mime: string }).mime : "", "application/octet-stream");
});

test("callApi: thread は件数→最新側の2回で取り、応答はそのまま返す", async () => {
  const urls: string[] = [];
  const deps = {
    load: () => OK,
    fetchImpl: async (url: string) => {
      urls.push(url);
      return json({ messages: [], latest_seq: 5, me: "me" });
    },
  };
  const r = await callApi({ op: "thread", id: PID }, deps);
  assert.equal(r.ok, true);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /after=0&limit=100/);
});

test("callApi: 設定が無ければ unconfigured(取りに行かない)", async () => {
  const r = await callApi(
    { op: "list" },
    {
      load: () => ({ ok: false, status: "unconfigured", message: "x" }),
      fetchImpl: async () => {
        throw new Error("called");
      },
    },
  );
  assert.equal(r.status, "unconfigured");
});

// ── shared の純粋関数 ─────────────────────────────────────────────────

test("宛先: 省略=AI宛、AIなし全員=[]、指名=['llm', ...]", () => {
  assert.equal(buildRecipients({ ai: true, people: [] }), null);
  assert.deepEqual(buildRecipients({ ai: false, people: [] }), []);
  assert.deepEqual(buildRecipients({ ai: true, people: ["hanako"] }), ["llm", "hanako"]);
  assert.deepEqual(buildRecipients({ ai: false, people: ["taro"] }), ["taro"]);
  const members = [{ userId: "hanako", name: "花子", role: "member" as const, isCreator: false }];
  assert.equal(recipientSummary({ ai: true, people: ["hanako"] }, members), "AI・花子");
  assert.match(recipientSummary({ ai: false, people: [] }, members), /全員/);
});

test("@メンション分割: 長い名前を先に拾い、IDはindexに依存しない", () => {
  const parts = splitMentions("@あい さん と @あ さん", ["あ", "あい", ""]);
  const hits = parts.filter((p) => p.mention).map((p) => p.text);
  assert.deepEqual(hits, ["@あい", "@あ"]);
  assert.equal(new Set(parts.map((p) => p.id)).size, parts.length);
});

test("添付の検査・並べ替え・書込権・容量表示", () => {
  const lim = { maxBytes: 1024, maxCount: 2 };
  assert.equal(checkAttachAdd([], 100, lim), null);
  assert.match(String(checkAttachAdd([{ size: 1 }, { size: 1 }], 1, lim)), /2件/);
  assert.match(String(checkAttachAdd([], 2048, lim)), /1KB/);
  assert.deepEqual(moveId(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveId(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveId(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  const ms = [
    { userId: "me", name: "あなた", role: "viewer" as const, isCreator: false },
    { userId: "x", name: "x", role: "member" as const, isCreator: true },
  ];
  assert.equal(canWrite(ms, "me"), false);
  assert.equal(canWrite(ms, "x"), true);
  assert.equal(canWrite(ms, "nobody"), false);
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0MB");
  assert.equal(formatBytes(2048), "2KB");
});

test("Topos 応答の読み取り: 形が違うものは捨てて落ちない", () => {
  assert.equal(parseDetail(null), null);
  const d = parseDetail({
    id: PID,
    name: "n",
    created_by: "me",
    members: [{ user_id: "me", display_name: "あなた", role: "viewer" }, 5],
    overview_pending: true,
  });
  assert.equal(d?.members.length, 1);
  assert.equal(d?.members[0].isCreator, true);
  assert.equal(d?.overviewPending, true);
  assert.deepEqual(
    parseProjectRows({ projects: [{ id: PID, name: "a", member_count: 2 }, { id: "bad" }] }).map(
      (r) => r.memberCount,
    ),
    [2],
  );
  const cfg = parseConfig({ attach: true, attach_limits: { max_bytes: 10, max_count: 2 } });
  assert.deepEqual([cfg?.attach, cfg?.maxBytes, cfg?.maxCount], [true, 10, 2]);
  const pr = parsePostResult(
    {
      message: { seq: 1, author: "me", text: "a" },
      reply: { seq: 2, kind: "llm", author: "llm", text: "b" },
      llm_error: "llm_failed",
      finish_confirm: true,
    },
    "me",
    {},
  );
  assert.equal(pr?.message?.mine, true);
  assert.equal(pr?.reply?.ai, true);
  assert.equal(pr?.llmError, "llm_failed");
  assert.equal(pr?.finishConfirm, true);
  assert.equal(parseNoteList({ notes: [{ id: PID, title: "概要" }, { id: "x" }] }).length, 1);
  assert.equal(parseNoteList([{ id: PID, title: "概要" }])[0].overview, true);
  assert.equal(
    parseVersions({ versions: [{ v: 2, op: "restore", restored_from: 1 }, { op: "x" }] }).length,
    1,
  );
  assert.equal(opLabel("append"), "AIが追記");
  assert.equal(parseAttachmentData({ dataUrl: "javascript:1" }), null);
});

test("失敗の文言: 権限の理由は具体的に、日本語の説明があれば添える", () => {
  assert.match(failureText("scope"), /この鍵では使えません/);
  assert.match(failureText("viewer"), /閲覧のみ/);
  assert.equal(failureText("too_large", "添付が大きすぎます"), "添付が大きすぎます");
  assert.match(failureText("too_large", "too big"), /大きすぎる/);
  assert.equal(failureText("???"), "失敗しました");
  assert.equal(classifyFailure(403, "scope_post_text_only"), "scope");
  assert.equal(classifyFailure(404, "attachments_disabled"), "disabled");
});
