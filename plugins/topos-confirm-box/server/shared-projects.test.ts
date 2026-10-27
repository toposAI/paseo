import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
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
