import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManagerEvent } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  TITLE_REGENERATE_LABEL,
  TITLE_SOURCE_AUTO,
  TITLE_SOURCE_INITIAL,
  TITLE_SOURCE_LABEL,
  TITLE_SOURCE_USER,
  buildTitleSummaryPrompt,
  createAgentTitleSummarizer,
  isAutoOwnedTitle,
  sanitizeSummaryTitle,
  shouldSummarizeAtTurn,
} from "./agent-title-summarizer.js";

const FIRST_PROMPT = "あなたは調査担当です。日本語で報告。\nF-80の判定失敗を直してください";

function setup(options: {
  title: string | null;
  labels?: Record<string, string>;
  generated?: string | Error;
}) {
  const record = { title: options.title, labels: { ...options.labels }, cwd: "/tmp/x" };
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: FIRST_PROMPT },
    { type: "assistant_message", text: "着手します" },
  ];
  const updates: Array<{ title?: string; labels?: Record<string, string> }> = [];
  const generateCalls: string[] = [];
  let listener: ((event: AgentManagerEvent) => void) | null = null;
  const summarizer = createAgentTitleSummarizer({
    subscribe: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    getTimeline: () => timeline,
    getStoredAgent: async () => ({ ...record, labels: { ...record.labels } }),
    updateAgentMetadata: async (_id, u) => {
      updates.push(u);
      if (u.title) record.title = u.title;
      if (u.labels) record.labels = { ...record.labels, ...u.labels };
    },
    generate: async ({ prompt }) => {
      generateCalls.push(prompt);
      if (options.generated instanceof Error) throw options.generated;
      return { title: options.generated ?? "F-80 判定失敗の修正" };
    },
    logger: createTestLogger(),
  });
  summarizer.start();
  const finishTurn = async () => {
    listener?.({
      type: "agent_stream",
      agentId: "a1",
      event: { type: "turn_completed", provider: "claude" } as never,
    });
    await summarizer.idle();
  };
  const retitle = (agentId: string) => summarizer.retitle(agentId);
  return { record, updates, generateCalls, finishTurn, retitle };
}

describe("title helpers", () => {
  test("sanitize rejects slugs and prompt copies, clamps length", () => {
    expect(sanitizeSummaryTitle("f80-two-stage")).toBeNull();
    expect(sanitizeSummaryTitle("あなたは調査担当です")).toBeNull();
    expect(sanitizeSummaryTitle("「F-80司令塔」")).toBe("F-80司令塔");
    expect(sanitizeSummaryTitle("あ".repeat(50).replace(/^あ/, "題"))?.length).toBe(30);
  });

  test("summary turns are sparse", () => {
    expect([1, 2, 5, 14, 15, 40].filter(shouldSummarizeAtTurn)).toEqual([1, 5, 15, 40]);
  });

  test("user-chosen titles are not auto-owned; prompt copies and labelled titles are", () => {
    expect(
      isAutoOwnedTitle({ title: "Topos司令塔", labels: {}, firstUserMessage: FIRST_PROMPT }),
    ).toBe(false);
    expect(
      isAutoOwnedTitle({
        title: "あなたは調査担当です。日本語で報告。",
        labels: {},
        firstUserMessage: FIRST_PROMPT,
      }),
    ).toBe(true);
    expect(
      isAutoOwnedTitle({
        title: "x",
        labels: { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_AUTO },
        firstUserMessage: null,
      }),
    ).toBe(true);
  });

  // 回帰: 修正前は `--title` で作られたスレ(例: f80-complete-integration)が
  // 「人が付けた題名」とみなされ、LLMの題名が一度も生成されなかった(サイドバーに識別名が出続けた)。
  test("creation-time titles are replaceable, titles renamed later are not", () => {
    for (const title of ["f80-complete-integration", "coordinator_backstage", "窓口B"]) {
      expect(
        isAutoOwnedTitle({
          title,
          labels: { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_INITIAL },
          firstUserMessage: FIRST_PROMPT,
        }),
      ).toBe(true);
    }
    expect(
      isAutoOwnedTitle({
        title: "窓口B",
        labels: { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_USER },
        firstUserMessage: FIRST_PROMPT,
      }),
    ).toBe(false);
  });

  test("prompt carries the current title and asks for stability", () => {
    const prompt = buildTitleSummaryPrompt({
      currentTitle: "Topos司令塔",
      firstUserMessage: "壁打ち",
      recentUserMessages: ["a"],
      lastAssistantMessage: "b",
    });
    expect(prompt).toContain("現在の題名: Topos司令塔");
    expect(prompt).toContain("一字一句そのまま返す");
  });
});

describe("createAgentTitleSummarizer", () => {
  test("replaces a provisional prompt-copy title on the first finished turn and marks it auto", async () => {
    const s = setup({ title: "あなたは調査担当です。日本語で報告。" });
    await s.finishTurn();
    expect(s.record.title).toBe("F-80 判定失敗の修正");
    expect(s.record.labels[TITLE_SOURCE_LABEL]).toBe(TITLE_SOURCE_AUTO);
  });

  test("never touches a user-chosen title", async () => {
    const s = setup({ title: "Topos司令塔", labels: { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_USER } });
    await s.finishTurn();
    expect(s.generateCalls).toHaveLength(0);
    expect(s.record.title).toBe("Topos司令塔");
  });

  // 回帰: サイドバーに英語の識別名(f80-…, coordinator_…)が出続けた本体の修正。
  test("replaces a creation-time title on the first finished turn", async () => {
    const s = setup({
      title: "f80-complete-integration",
      labels: { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_INITIAL },
    });
    await s.finishTurn();
    expect(s.record.title).toBe("F-80 判定失敗の修正");
    expect(s.record.labels[TITLE_SOURCE_LABEL]).toBe(TITLE_SOURCE_AUTO);
  });

  test("retitle forces a one-shot replacement even of a user-chosen title", async () => {
    const s = setup({ title: "coordinator_backstage", labels: {} });
    await s.retitle("a1");
    expect(s.record.title).toBe("F-80 判定失敗の修正");
    expect(s.record.labels[TITLE_SOURCE_LABEL]).toBe(TITLE_SOURCE_AUTO);
  });

  test("keeps the title when generation fails", async () => {
    const s = setup({
      title: "あなたは調査担当です。日本語で報告。",
      generated: new Error("boom"),
    });
    await s.finishTurn();
    expect(s.updates).toHaveLength(0);
    expect(s.record.title).toBe("あなたは調査担当です。日本語で報告。");
  });

  test("keeps the title when the model returns a slug", async () => {
    const s = setup({ title: "あなたは調査担当です。日本語で報告。", generated: "f80-fix" });
    await s.finishTurn();
    expect(s.updates).toHaveLength(0);
  });

  test("only re-summarises at the sparse marks", async () => {
    const s = setup({ title: "x", labels: { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_AUTO } });
    for (let i = 0; i < 4; i += 1) await s.finishTurn(); // turns 1-4 -> only turn 1
    expect(s.generateCalls).toHaveLength(1);
    await s.finishTurn(); // turn 5
    expect(s.generateCalls).toHaveLength(2);
  });

  test("regenerate label forces a re-summary of a user-chosen title on the next turn", async () => {
    const s = setup({ title: "Topos司令塔", labels: { [TITLE_REGENERATE_LABEL]: "1" } });
    await s.finishTurn();
    expect(s.generateCalls).toHaveLength(1);
    expect(s.record.labels[TITLE_REGENERATE_LABEL]).toBe("done");
    expect(s.record.labels[TITLE_SOURCE_LABEL]).toBe(TITLE_SOURCE_AUTO);
  });
});
