import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { asInternals } from "../../../test-utils/class-mocks.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

const sdkQueryFactory = vi.fn();

function createQueryMock() {
  return {
    next: vi.fn(() => new Promise<never>(() => {})),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function createSession() {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
}

beforeEach(() => {
  sdkQueryFactory.mockReset();
});

afterEach(() => {
  sdkQueryFactory.mockReset();
});

// A config change that lands before the session has a query — the thinking option the UI
// applies while a thread is being moved onto this provider, a mode swap, a fast-mode toggle —
// sets `queryRestartNeeded` while `this.query` is still null. ensureQuery()'s restart branch
// fires only when BOTH are set, so that state used to fall through to the "build a query"
// path with the flag still raised. The send then created a query, startQueryPump() had the
// pump's ensureQuery() retire it synchronously, and the `this.input.push(...)` that followed
// threw "Cannot read properties of null (reading 'push')" — which surfaced in the UI as
// `[System Error] Cannot read properties of null (reading 'push')`.
test("startTurn survives a restart flag set before the session ever had a query", async () => {
  sdkQueryFactory.mockImplementation(() => createQueryMock());
  const session = await createSession();
  const internal = asInternals<{ queryRestartNeeded: boolean }>(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  internal.queryRestartNeeded = true;

  await session.startTurn("hello");

  const failures = events.filter(
    (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
      event.type === "turn_failed",
  );
  expect(failures.map((event) => event.error)).not.toContain(
    "Cannot read properties of null (reading 'push')",
  );
  expect(failures).toHaveLength(0);
  expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);

  await session.close();
});

// The other half of the same state: if the flag survives the query the send just created, the
// pump's restart branch retires that query and builds a replacement. The user message was
// pushed into the retired one, so this checks the message reaches the query that stays live.
test("the user message reaches the query that stays live", async () => {
  const prompts: Array<AsyncIterable<unknown>> = [];
  sdkQueryFactory.mockImplementation((input: { prompt: AsyncIterable<unknown> }) => {
    prompts.push(input.prompt);
    return createQueryMock();
  });
  const session = await createSession();
  const internal = asInternals<{ queryRestartNeeded: boolean }>(session);

  internal.queryRestartNeeded = true;

  await session.startTurn("hello");

  await new Promise((resolve) => setTimeout(resolve, 50));
  // No restart is owed once the query exists, so the send builds exactly one.
  expect(prompts).toHaveLength(1);
  const live = prompts[prompts.length - 1];
  const iterator = live[Symbol.asyncIterator]();
  const first = await Promise.race([
    iterator.next(),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);

  expect(JSON.stringify(first)).toContain("hello");

  await session.close();
});
