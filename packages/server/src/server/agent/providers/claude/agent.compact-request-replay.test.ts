import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

/**
 * After a compaction the transcript also records the request body Claude Code sent (the
 * `api-request-blob` records). It carries the harness-injected context — the agent listing,
 * the skill listing, the environment, the system prompt — and must never come back as an
 * assistant row: doing so printed the whole prompt dump into the conversation.
 */

const SESSION_ID = "compact-request-replay-session";

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function transcriptLines(): string[] {
  return [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "このスレ、今日どうする?" },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        id: "msg_1",
        content: [textBlock("今日はこの二つを進めます。")],
      },
    }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: {} }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation",
      },
      isCompactSummary: true,
    }),
    // The request body: tool-shaped blocks plus the replayed system prompt.
    JSON.stringify({
      type: "api-request-blob",
      message: {
        role: "user",
        content: [
          textBlock("Here are the available agent types for the Agent tool:"),
          textBlock(
            "When you launch multiple agents for independent work, send them in a single message.",
          ),
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          textBlock(
            "You are powered by the model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5.",
          ),
          textBlock("Today's date is 2026-10-30."),
        ],
      },
    }),
    JSON.stringify({
      type: "api-request-shape",
      message: { role: "system", content: [textBlock("SessionStart:compact hook success: ok")] },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "続けて" },
    }),
  ];
}

describe("ClaudeAgentSession compact request replay", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-compact-request-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const transcript = path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, `${transcriptLines().join("\n")}\n`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function replayHistory(): Promise<{
    session: { close(): Promise<void> };
    items: AgentStreamEvent[];
  }> {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      queryFactory: vi.fn(() => {
        throw new Error("history replay must not start a query");
      }),
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    const items: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      items.push(event);
    }
    return { session, items };
  }

  test("never turns a request body into an assistant row", async () => {
    const { session, items } = await replayHistory();
    await session.close();

    const text = JSON.stringify(items);
    expect(text).not.toContain("Here are the available agent types");
    expect(text).not.toContain("powered by the model named");
    expect(text).not.toContain("SessionStart:compact");
    expect(text).toContain("今日はこの二つを進めます。");
    expect(text).toContain("続けて");
  });

  test("takes the model from the replayed system prompt", async () => {
    const { session } = await replayHistory();
    const info = await session.getRuntimeInfo();
    await session.close();

    expect(info.model).toBe("claude-sonnet-5-5");
  });
});
