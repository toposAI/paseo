import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { parseAgentMessage } from "../agent/agent-messages/index.js";

import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";

// Real daemon + real WebSocket clients: agent-to-agent messages (CLI/MCP clients, or any message
// naming a source agent) wait for the turn boundary; app input and explicit interrupt still interrupt.

const HELD_TURN_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * Provider session that records every prompt it receives. With `holdTurns`, a started
 * turn stays running until `finishTurn()` so a caller's bounded wait can run out first.
 */
class HeldTurnAgentSession implements AgentSession {
  readonly capabilities = HELD_TURN_CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;
  private turnStartGate: Promise<void> | null = null;
  private nextStartError: Error | null = null;

  constructor(
    readonly provider: AgentProvider,
    private readonly holdTurns: boolean,
  ) {}

  /** Hold the next turn's acknowledgment, as a provider awaiting its turn-start request does. */
  holdTurnStart(): () => void {
    let release!: () => void;
    this.turnStartGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  rejectNextTurnStart(error: Error): void {
    this.nextStartError = error;
  }

  tryHandleOutOfBand(prompt: AgentPromptInput) {
    const text = typeof prompt === "string" ? (parseAgentMessage(prompt)?.text ?? prompt) : null;
    return text === "/side-command" ? { run: async () => {} } : null;
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    await this.turnStartGate;
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = null;
      throw error;
    }
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.pushEvent({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: {
        type: "user_message",
        text: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
        messageId: randomUUID(),
      },
    });
    setTimeout(() => {
      if (this.activeTurnId !== turnId) return;
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      if (!this.holdTurns && this.activeTurnId === turnId) {
        this.finishTurn();
      }
    }, 0);
    return { turnId };
  }

  finishTurn(finalText?: string): void {
    const turnId = this.activeTurnId;
    if (!turnId) {
      throw new Error("No held turn to finish");
    }
    this.activeTurnId = null;
    if (finalText)
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: finalText },
      });
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
  }

  failTurn(error: string): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("No held turn to fail");
    this.activeTurnId = null;
    this.pushEvent({ type: "turn_failed", provider: this.provider, error, turnId });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  interruptCalls = 0;

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    const turnId = this.activeTurnId;
    if (!turnId) {
      return;
    }
    this.activeTurnId = null;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      reason: "interrupted",
      turnId,
    });
  }

  async close(): Promise<void> {}
}

class HeldTurnAgentClient implements AgentClient {
  readonly capabilities = HELD_TURN_CAPABILITIES;
  readonly sessions: HeldTurnAgentSession[] = [];

  constructor(
    readonly provider: AgentProvider,
    private readonly holdTurns: boolean,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new HeldTurnAgentSession(this.provider, this.holdTurns);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const clientImpl = new HeldTurnAgentClient("codex", true);
  const daemon = await createTestPaseoDaemon({ agentClients: { codex: clientImpl } });
  const cwd = mkdtempSync(path.join(tmpdir(), "amq-e2e-"));
  const connect = async (clientType: "cli" | "browser") => {
    const c = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientType,
      clientId: `amq-${clientType}-${randomUUID()}`,
    });
    await c.connect();
    cleanups.push(() => c.close());
    return c;
  };
  cleanups.push(async () => {
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const cli = await connect("cli");
  const browser = await connect("browser");
  const agent = await cli.createAgent({ provider: "codex", cwd });
  await cli.sendMessage(agent.id, "first task", { activeTurnBehavior: "interrupt" });
  const session = clientImpl.sessions[0]!;
  await waitFor(() => session.prompts.length === 1);
  return { cli, browser, agent, session };
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 400));

test("CLI message naming a source agent does not interrupt; delivered at the turn boundary", async () => {
  const { cli, agent, session } = await setup();
  await cli.sendMessage(agent.id, "from backstage", { sourceAgentId: "sender-1" });
  await settle();
  expect(session.interruptCalls).toBe(0);
  expect(session.prompts).toHaveLength(1);
  session.finishTurn("done");
  await waitFor(() => session.prompts.length === 2);
  expect(session.prompts[1]).toContain("from backstage");
  expect(session.interruptCalls).toBe(0);
});

test("CLI message without source agent id (no PASEO_AGENT_ID) is also queued", async () => {
  const { cli, agent, session } = await setup();
  await cli.sendMessage(agent.id, "from terminal");
  await settle();
  expect(session.interruptCalls).toBe(0);
  expect(session.prompts).toHaveLength(1);
});

test("several queued messages arrive in order, one per turn", async () => {
  const { cli, agent, session } = await setup();
  await cli.sendMessage(agent.id, "m1", { sourceAgentId: "s" });
  await cli.sendMessage(agent.id, "m2", { sourceAgentId: "s" });
  session.finishTurn();
  await waitFor(() => session.prompts.length === 2);
  expect(session.prompts[1]).toContain("m1");
  await settle();
  expect(session.prompts).toHaveLength(2);
  session.finishTurn();
  await waitFor(() => session.prompts.length === 3);
  expect(session.prompts[2]).toContain("m2");
  expect(session.interruptCalls).toBe(0);
});

test("app (user) message still interrupts the running turn", async () => {
  const { browser, agent, session } = await setup();
  await browser.sendMessage(agent.id, "user says stop and do this");
  await waitFor(() => session.prompts.length === 2);
  expect(session.interruptCalls).toBeGreaterThan(0);
});

test("CLI message with explicit interrupt still interrupts", async () => {
  const { cli, agent, session } = await setup();
  await cli.sendMessage(agent.id, "urgent", { activeTurnBehavior: "interrupt" });
  await waitFor(() => session.prompts.length === 2);
  expect(session.interruptCalls).toBeGreaterThan(0);
});

test("explicit cancel (Stop) still interrupts", async () => {
  const { browser, agent, session } = await setup();
  await browser.cancelAgent(agent.id);
  await waitFor(() => session.interruptCalls > 0);
});
