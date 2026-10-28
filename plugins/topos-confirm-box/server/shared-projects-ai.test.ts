import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aiFailureText,
  mayStartKickoff,
  type ProjectDetail,
  parseAiPending,
  parsePostResult,
  rateLimitText,
  type SharedProjectApiInput,
} from "../shared/shared-projects-api.js";
import { callApi, type ApiOutcome, type Loaded } from "./shared-projects.js";
import {
  chooseSafeMode,
  CLAUDE_BUILTIN_TOOLS,
  composeAgentPrompt,
  findSuspiciousOutput,
  isClaudeProvider,
  createAiJobs,
  createPaseoGenerator,
  SAFETY_PREAMBLE,
  TEMP_AGENT_LABEL,
  type Generate,
} from "./shared-projects-ai.js";

const PID = "b".repeat(32);
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

const SECRET_TICKET = "ticket-secret-123";
const SECRET_PROMPT = "prompt-secret-456";
const SECRET_TEXT = "generated-secret-789";

interface Calls {
  inputs: SharedProjectApiInput[];
}

/** Topos の prepare/commit を模した call。commit の本文は記録する。 */
function fakeCall(
  calls: Calls,
  opts: {
    prepare?: () => ApiOutcome;
    commit?: (input: SharedProjectApiInput) => ApiOutcome;
  } = {},
) {
  return async (input: SharedProjectApiInput): Promise<ApiOutcome> => {
    calls.inputs.push(input);
    if (input.op === "aiPrepare") {
      return (
        opts.prepare?.() ?? {
          ok: true,
          status: "ok",
          data: {
            ticket: SECRET_TICKET,
            prompt: SECRET_PROMPT,
            system: "sys",
            kind: "reply",
            max_chars: 8000,
            needs_llm: true,
          },
        }
      );
    }
    return (
      opts.commit?.(input) ?? {
        ok: true,
        status: "ok",
        data: { reply: { seq: 2, text: "x" }, llm_error: null },
      }
    );
  };
}

const okGen: Generate = async () => ({ text: SECRET_TEXT, provider: "deepseek", model: "m1" });

function jobs(
  calls: Calls,
  generate: Generate,
  extra: Partial<Parameters<typeof createAiJobs>[0]> = {},
  logs: string[] = [],
) {
  let n = 0;
  return createAiJobs({
    call: fakeCall(calls),
    generate,
    newId: () => `job${String(++n).padStart(5, "0")}-xxxxxxxx`,
    log: (l) => logs.push(l),
    ...extra,
  });
}

test("ジョブ: start → poll(running) → done、commit に本文が渡る", async () => {
  const calls: Calls = { inputs: [] };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const j = jobs(calls, async (req) => {
    await gate;
    return okGen(req);
  });
  const started = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(j.poll(started.jobId).status, "running");
  release();
  await j.idle();
  const done = j.poll(started.jobId);
  assert.equal(done.status, "done");
  const commit = calls.inputs.find((i) => i.op === "aiCommit");
  assert.ok(commit && commit.op === "aiCommit");
  assert.deepEqual(commit.body, {
    ticket: SECRET_TICKET,
    text: SECRET_TEXT,
    provider: "deepseek",
    model: "m1",
    failed: false,
  });
});

test("ジョブ: 生成失敗は failed:true で commit し、画面向けには失敗を返す", async () => {
  const calls: Calls = { inputs: [] };
  const j = createAiJobs({
    call: fakeCall(calls, {
      commit: () => ({ ok: true, status: "ok", data: { reply: null, llm_error: "llm_failed" } }),
    }),
    generate: async () => {
      throw new Error("boom");
    },
  });
  const s = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.ok(s.ok);
  if (!s.ok) return;
  await j.idle();
  const commit = calls.inputs.find((i) => i.op === "aiCommit");
  assert.ok(commit && commit.op === "aiCommit");
  assert.equal((commit.body as { failed: boolean }).failed, true);
  assert.equal((commit.body as { text: string }).text, "");
  const r = j.poll(s.jobId);
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "llm_failed");
  assert.match(r.error ?? "", /AIの返信に失敗しました/);
});

test("ジョブ: 生成が上限を超えたら failed:true で commit する", async () => {
  const calls: Calls = { inputs: [] };
  const j = createAiJobs({
    call: fakeCall(calls),
    generate: () => new Promise(() => undefined),
    genTimeoutMs: 20,
  });
  const s = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.ok(s.ok);
  await j.idle();
  const commit = calls.inputs.find((i) => i.op === "aiCommit");
  assert.ok(commit && commit.op === "aiCommit");
  assert.equal((commit.body as { failed: boolean }).failed, true);
});

test("ジョブ: 429 は retryAfter を返し、生成を始めない", async () => {
  const calls: Calls = { inputs: [] };
  let generated = 0;
  const j = createAiJobs({
    call: fakeCall(calls, {
      prepare: () => ({
        ok: false,
        status: "error",
        reason: "rate_limited",
        message: "x",
        detail: "rate_limited",
        retryAfter: 1800,
      }),
    }),
    generate: async (req) => {
      generated += 1;
      return okGen(req);
    },
  });
  const s = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.equal(s.ok, false);
  if (s.ok) return;
  assert.equal(s.reason, "rate_limited");
  assert.equal(s.retryAfter, 1800);
  assert.match(s.message, /30分後に再開できます/);
  assert.equal(generated, 0);
  assert.equal(calls.inputs.filter((i) => i.op === "aiCommit").length, 0);
});

test("ジョブ: すでに返信済み(409)は already_done", async () => {
  const j = createAiJobs({
    call: fakeCall(
      { inputs: [] },
      {
        prepare: () => ({
          ok: false,
          status: "error",
          reason: "conflict",
          message: "m",
          detail: "already_replied",
        }),
      },
    ),
    generate: okGen,
  });
  const s = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.equal(s.ok, false);
  if (!s.ok) assert.equal(s.reason, "already_done");
});

test("ジョブ: 同じプロジェクト・種類・seq の重複起動は同じジョブを返す", async () => {
  const calls: Calls = { inputs: [] };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const j = jobs(calls, async (req) => {
    await gate;
    return okGen(req);
  });
  const a = await j.start({ id: PID, kind: "reply", seq: 1 });
  const b = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.equal(a.jobId, b.jobId);
  assert.equal(calls.inputs.filter((i) => i.op === "aiPrepare").length, 1);
  release();
  await j.idle();
});

test("ジョブ: 同時実行は3件まで。4件目は busy", async () => {
  const calls: Calls = { inputs: [] };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const j = jobs(calls, async (req) => {
    await gate;
    return okGen(req);
  });
  const outs = [];
  for (const seq of [1, 2, 3, 4]) outs.push(await j.start({ id: PID, kind: "reply", seq }));
  assert.deepEqual(
    outs.map((o) => o.ok),
    [true, true, true, false],
  );
  const last = outs[3];
  if (last && !last.ok) assert.equal(last.reason, "busy");
  release();
  await j.idle();
  // 終われば再び受け付ける
  const again = await j.start({ id: PID, kind: "reply", seq: 5 });
  assert.equal(again.ok, true);
  await j.idle();
});

test("ジョブ: 終了10分後に捨てる(poll は unknown_job)", async () => {
  let t = 1_000;
  const j = createAiJobs({
    call: fakeCall({ inputs: [] }),
    generate: okGen,
    now: () => t,
  });
  const s = await j.start({ id: PID, kind: "reply", seq: 1 });
  assert.ok(s.ok);
  if (!s.ok) return;
  await j.idle();
  assert.equal(j.poll(s.jobId).status, "done");
  t += 10 * 60_000 + 1;
  const gone = j.poll(s.jobId);
  assert.equal(gone.status, "failed");
  assert.equal(gone.reason, "unknown_job");
});

test("ジョブ: ログに ticket・プロンプト・生成本文・鍵を出さない", async () => {
  const logs: string[] = [];
  const calls: Calls = { inputs: [] };
  const j = jobs(calls, okGen, {}, logs);
  await j.start({ id: PID, kind: "reply", seq: 1 });
  await j.idle();
  const failing = jobs(
    calls,
    async () => {
      throw new Error(`${SECRET_PROMPT} ${SECRET_TEXT}`);
    },
    {},
    logs,
  );
  await failing.start({ id: PID, kind: "reply", seq: 2 });
  await failing.idle();
  assert.ok(logs.length > 0);
  const all = logs.join("\n");
  for (const secret of [SECRET_TICKET, SECRET_PROMPT, SECRET_TEXT, "dummy-token"]) {
    assert.equal(all.includes(secret), false, `ログに ${secret} が出ている`);
  }
});

test("ジョブ: 不正なIDと seq なしの reply は始めない", async () => {
  const calls: Calls = { inputs: [] };
  const j = jobs(calls, okGen);
  const a = await j.start({ id: "../x", kind: "reply", seq: 1 });
  const b = await j.start({ id: PID, kind: "reply" });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(calls.inputs.length, 0);
});

test("callApi: aiPrepare / aiCommit は画面側からは呼べない(内部専用)", async () => {
  let fetched = 0;
  const deps = {
    load: () => OK,
    fetchImpl: async () => {
      fetched += 1;
      return json({});
    },
  };
  const a = await callApi(
    {
      op: "aiCommit",
      id: PID,
      body: { ticket: "t", text: "偽の返信", provider: null, model: null, failed: false },
    },
    deps,
  );
  const b = await callApi({ op: "aiPrepare", id: PID, body: { kind: "catchup" } }, deps);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(fetched, 0);
});

test("callApi(内部): prepare/commit は固定パスに送り、本文を検査する", async () => {
  const seen: { url: string; method: string }[] = [];
  const deps = {
    load: () => OK,
    fetchImpl: async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method) });
      return json({ ok: true });
    },
  };
  const ok = await callApi({ op: "aiPrepare", id: PID, body: { kind: "reply", seq: 3 } }, deps, {
    internal: true,
  });
  assert.equal(ok.ok, true);
  assert.match(seen[0]?.url ?? "", new RegExp(`/api/family-projects/${PID}/ai/prepare$`));
  assert.equal(seen[0]?.method, "POST");
  // 余計なキー・長すぎる本文は送らない
  const extra = await callApi(
    { op: "aiPrepare", id: PID, body: { kind: "reply", seq: 3, path: "/etc/passwd" } },
    deps,
    { internal: true },
  );
  const long = await callApi(
    {
      op: "aiCommit",
      id: PID,
      body: { ticket: "t", text: "あ".repeat(20_001), provider: null, model: null, failed: false },
    },
    deps,
    { internal: true },
  );
  assert.equal(extra.ok, false);
  assert.equal(long.ok, false);
  assert.equal(seen.length, 1);
});

test("callApi(内部): 429 は rate_limited と retryAfter を返す", async () => {
  const deps = {
    load: () => OK,
    fetchImpl: async () => json({ reason: "rate_limited", retry_after: 600 }, 429),
  };
  const r = await callApi({ op: "aiPrepare", id: PID, body: { kind: "reply", seq: 1 } }, deps, {
    internal: true,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "rate_limited");
    assert.equal(r.retryAfter, 600);
  }
});

test("純粋関数: ai_pending の読み取り・文言", () => {
  assert.deepEqual(parseAiPending({ ai_pending: { kind: "reply", seq: 4 } }), {
    kind: "reply",
    seq: 4,
  });
  assert.deepEqual(parseAiPending({ ai_pending: { kind: "kickoff" } }), { kind: "kickoff" });
  assert.equal(parseAiPending({ ai_pending: null }), null);
  assert.equal(parseAiPending({ ai_pending: { kind: "rm -rf" } }), null);
  assert.equal(parseAiPending({}), null);
  assert.equal(parseAiPending("x"), null);
  assert.match(rateLimitText(1800), /30分後に再開できます/);
  assert.match(rateLimitText(1), /1分後/);
  assert.match(rateLimitText(undefined), /しばらく/);
  assert.equal(aiFailureText("reply", "already_done", ""), "");
  assert.match(aiFailureText("reply", "llm_failed", ""), /投稿は届いています/);
  assert.match(aiFailureText("reply", "rate_limited", "", 3600), /60分後/);
  assert.match(aiFailureText("catchup", "server", ""), /要約に失敗/);
  const parsed = parsePostResult(
    {
      message: {
        seq: 1,
        text: "a",
        author: "me",
        ts: "2026-10-28T00:00:00Z",
        kind: "user",
        to: [],
        attachments: [],
      },
      ai_pending: { kind: "reply", seq: 1 },
    },
    "me",
    {},
  );
  assert.deepEqual(parsed?.aiPending, { kind: "reply", seq: 1 });
});

test("chooseSafeMode: plan > read-only > default。bypass・acceptEdits は選ばない", () => {
  assert.equal(
    chooseSafeMode([{ id: "bypassPermissions" }, { id: "plan" }, { id: "default" }]),
    "plan",
  );
  assert.equal(chooseSafeMode([{ id: "acceptEdits" }, { id: "default" }]), "default");
  assert.equal(chooseSafeMode([{ id: "read-only" }, { id: "default" }]), "read-only");
  assert.equal(chooseSafeMode([{ id: "bypassPermissions" }, { id: "acceptEdits" }]), null);
  assert.equal(chooseSafeMode([]), null);
  assert.equal(chooseSafeMode(null), null);
});

test("composeAgentPrompt: 規律 → system → 空行 → prompt の順", () => {
  const p = composeAgentPrompt("SYS", "PROMPT");
  assert.equal(p, `${SAFETY_PREAMBLE}\n\nSYS\n\nPROMPT`);
});

// ── 既定の生成器: ctx.paseo のモックで安全設定を確かめる ─────────────────────────

interface CreateArg {
  config: {
    provider: string;
    thinkingOptionId?: string;
    modeId?: string;
    mcpServers?: Record<string, unknown>;
    options?: unknown;
  };
  cwd: string;
  title?: string;
  labels?: Record<string, string>;
  background?: boolean;
  prompt?: string;
}

function mockPaseo(
  opts: {
    status?: string;
    lastMessage?: string | null;
    modes?: { id: string }[];
    waitHangs?: boolean;
    timelineItems?: { type: string }[];
    timelineFails?: boolean;
    claudeModels?: { id: string; isSelectable: boolean }[];
  } = {},
) {
  const rec = {
    created: [] as CreateArg[],
    archived: 0,
    workspaceArchived: [] as string[],
    cwdExistedAtCreate: false,
    waitTimeouts: [] as number[],
  };
  const paseo = {
    providers: {
      listModels: async (provider: string) => {
        if (provider === "claude") return { models: opts.claudeModels ?? [], error: null };
        return {
          models: [
            {
              id: "deepseek-v4-flash",
              label: "DeepSeek V4 Flash",
              isSelectable: true,
              thinkingOptions: [{ id: "low" }, { id: "high" }],
            },
          ],
          error: null,
        };
      },
      listModes: async () => ({
        modes: opts.modes ?? [{ id: "bypassPermissions" }, { id: "default" }, { id: "plan" }],
        error: null,
      }),
    },
    agents: {
      create: async (arg: CreateArg) => {
        rec.created.push(arg);
        rec.cwdExistedAtCreate = fs.existsSync(arg.cwd) && fs.readdirSync(arg.cwd).length === 0;
        return {
          workspaceId: "ws-temp",
          timeline: {
            refetch: async () => {
              if (opts.timelineFails) throw new Error("boom");
              return {
                error: null,
                hasOlder: false,
                entries: (opts.timelineItems ?? [{ type: "assistant_message" }]).map((item) => ({
                  item,
                })),
              };
            },
          },
          waitForFinish: async (ms: number) => {
            rec.waitTimeouts.push(ms);
            if (opts.waitHangs) {
              await new Promise((r) => setTimeout(r, ms + 10));
              return { status: "timeout", lastMessage: null, final: null, error: null };
            }
            return {
              status: opts.status ?? "idle",
              lastMessage: opts.lastMessage === undefined ? "  生成結果  " : opts.lastMessage,
              final: null,
              error: null,
            };
          },
          archive: async () => {
            rec.archived += 1;
          },
        };
      },
    },
    workspaces: {
      archive: async (id: string) => {
        rec.workspaceArchived.push(id);
      },
    },
  };
  return { rec, paseo };
}

const REQ = { kind: "reply" as const, system: "SYS", prompt: "PROMPT", timeoutMs: 5_000 };

test("生成器: 制限モード・空の一時cwd・background・題名/ラベル・archive を渡す", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-ai-test-"));
  const { rec, paseo } = mockPaseo();
  const gen = createPaseoGenerator(() => paseo as never, { tmpRoot: root });
  const out = await gen(REQ);
  assert.deepEqual(out, { text: "生成結果", provider: "deepseek", model: "deepseek-v4-flash" });
  assert.equal(rec.created.length, 1);
  const c = rec.created[0] as CreateArg;
  assert.equal(c.config.modeId, "plan"); // bypassPermissions は選ばない
  assert.equal(c.config.provider, "deepseek/deepseek-v4-flash");
  assert.equal(c.config.thinkingOptionId, "low");
  assert.equal(c.background, true);
  assert.ok(c.title?.startsWith("[Topos共有AI・自動]"));
  assert.deepEqual(c.labels, { ...TEMP_AGENT_LABEL });
  assert.ok(c.cwd.startsWith(root), "cwd は一時領域の中");
  assert.equal(rec.cwdExistedAtCreate, true, "作成時の cwd は空のディレクトリ");
  assert.equal(c.prompt, `${SAFETY_PREAMBLE}\n\nSYS\n\nPROMPT`);
  assert.equal(rec.archived, 1);
  assert.deepEqual(rec.workspaceArchived, ["ws-temp"]);
  assert.equal(fs.existsSync(c.cwd), false, "一時ディレクトリは消す");
  assert.equal(JSON.stringify(c).includes("bypassPermissions"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("生成器: 承認待ち(permission)は失敗。それでも archive する", async () => {
  const { rec, paseo } = mockPaseo({ status: "permission" });
  const gen = createPaseoGenerator(() => paseo as never);
  await assert.rejects(gen(REQ));
  assert.equal(rec.archived, 1);
  assert.deepEqual(rec.workspaceArchived, ["ws-temp"]);
});

test("生成器: 空の返答・エラー終了は失敗。archive する", async () => {
  for (const o of [{ lastMessage: "   " }, { lastMessage: null }, { status: "error" }]) {
    const { rec, paseo } = mockPaseo(o);
    const gen = createPaseoGenerator(() => paseo as never);
    await assert.rejects(gen(REQ));
    assert.equal(rec.archived, 1);
  }
});

test("生成器: 安全なモードが無ければ生成しない(エージェントを作らない)", async () => {
  const { rec, paseo } = mockPaseo({ modes: [{ id: "bypassPermissions" }, { id: "acceptEdits" }] });
  const gen = createPaseoGenerator(() => paseo as never);
  await assert.rejects(gen(REQ), /no_safe_mode/);
  assert.equal(rec.created.length, 0);
});

test("生成器: 時間切れでも archive する", async () => {
  const { rec, paseo } = mockPaseo({ waitHangs: true });
  const gen = createPaseoGenerator(() => paseo as never);
  // waitForFinish は渡された残り時間だけ待つので、短い期限で失敗させる
  await assert.rejects(gen({ ...REQ, timeoutMs: 30 }));
  assert.equal(rec.archived, 1);
});

test("生成器: 外部MCPは渡さない(mcpServers は空)。非Claudeには options を渡さない", async () => {
  const { rec, paseo } = mockPaseo();
  const gen = createPaseoGenerator(() => paseo as never);
  await gen(REQ);
  const c = rec.created[0] as CreateArg;
  assert.deepEqual(c.config.mcpServers, {});
  assert.equal(c.config.options, undefined);
});

test("生成器: Claude の haiku が選べるなら優先し、組み込みツールを全部 disallowedTools に渡す", async () => {
  const { rec, paseo } = mockPaseo({
    claudeModels: [
      { id: "claude-sonnet-5-5", isSelectable: true },
      { id: "claude-haiku-5-5", isSelectable: true },
    ],
  });
  const gen = createPaseoGenerator(() => paseo as never);
  const out = await gen(REQ);
  assert.equal(out.provider, "claude");
  const c = rec.created[0] as CreateArg;
  assert.equal(c.config.provider, "claude/claude-haiku-5-5");
  assert.equal(c.config.thinkingOptionId, undefined);
  assert.deepEqual(c.config.mcpServers, {});
  const opts = c.config.options as { disallowedTools: string[] };
  assert.deepEqual(Object.keys(c.config.options as object), ["disallowedTools"]);
  for (const t of [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
    "WebSearch",
    "Task",
  ])
    assert.ok(opts.disallowedTools.includes(t), t);
  assert.deepEqual(opts.disallowedTools, [...CLAUDE_BUILTIN_TOOLS]);
});

test("isClaudeProvider", () => {
  assert.equal(isClaudeProvider("claude"), true);
  assert.equal(isClaudeProvider("claude/claude-haiku-5-5"), true);
  assert.equal(isClaudeProvider("deepseek"), false);
  assert.equal(isClaudeProvider("claudex"), false);
});

test("生成器: ツール呼び出しが1件でもあれば失敗(tool_used)。確認できなくても失敗。archive する", async () => {
  for (const o of [
    { timelineItems: [{ type: "assistant_message" }, { type: "tool_call" }] },
    { timelineFails: true },
  ]) {
    const { rec, paseo } = mockPaseo(o);
    const gen = createPaseoGenerator(() => paseo as never);
    await assert.rejects(gen(REQ));
    assert.equal(rec.archived, 1);
  }
});

test("findSuspiciousOutput: 鍵・秘密鍵・絶対パス3つ以上", () => {
  assert.equal(findSuspiciousOutput("こんにちは。よい提案ですね"), null);
  assert.equal(findSuspiciousOutput("鍵は tps_abcdEFGH1234 です"), "key_like");
  assert.equal(findSuspiciousOutput("tpu_0123456789abcdef"), "key_like");
  assert.equal(findSuspiciousOutput("-----BEGIN OPENSSH PRIVATE KEY-----"), "private_key");
  assert.equal(findSuspiciousOutput("-----BEGIN RSA PRIVATE KEY-----"), "private_key");
  assert.equal(findSuspiciousOutput("/Users/a/x と /Users/b/y"), null);
  assert.equal(findSuspiciousOutput("/Users/a/x と /Users/b/y と ~/.ssh/id"), "paths");
  assert.equal(findSuspiciousOutput("tps_ だけ"), null);
});

test("ジョブ: 鍵らしき語を含む生成文は failed:true・空本文で commit する", async () => {
  const calls: Calls = { inputs: [] };
  const generate: Generate = async () => ({ text: "tps_abcdEFGH1234", provider: "p", model: "m" });
  const aiJobs = createAiJobs({ call: fakeCall(calls), generate });
  await aiJobs.start({ id: PID, kind: "reply", seq: 1 });
  await aiJobs.idle();
  const commit = calls.inputs.find((i) => i.op === "aiCommit") as { body: Record<string, unknown> };
  assert.equal(commit.body.failed, true);
  assert.equal(commit.body.text, "");
});

test("kickoff開始: 自分のIDが分かれば作成者だけ、分からない(古いサーバー)ときは呼んでみる、詳細が無ければ呼ばない", () => {
  const d = {
    id: PID,
    name: "n",
    description: "",
    createdBy: "owner",
    members: [],
    overviewPending: true,
  } as ProjectDetail;
  assert.equal(mayStartKickoff(d, "owner"), true);
  assert.equal(mayStartKickoff(d, "other"), false);
  assert.equal(mayStartKickoff(d, ""), true);
  assert.equal(mayStartKickoff(null, ""), false);
});
