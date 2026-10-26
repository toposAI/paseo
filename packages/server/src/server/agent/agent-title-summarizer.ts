import { z } from "zod";
import type { Logger } from "pino";
import {
  AGENT_TITLE_BEFORE_RETITLE_LABEL,
  AGENT_TITLE_REGENERATE_LABEL,
  AGENT_TITLE_SOURCE_AUTO,
  AGENT_TITLE_SOURCE_INITIAL,
  AGENT_TITLE_SOURCE_LABEL,
  AGENT_TITLE_SOURCE_USER,
  MAX_EXPLICIT_AGENT_TITLE_CHARS,
} from "@getpaseo/protocol/agent-title-limits";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentManagerEvent } from "./agent-manager.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";

/**
 * 題名の出どころを表すラベル。値の意味は protocol の `agent-title-limits.ts` が正本。
 * `initial`=作成時の題名(置き換え可)、`auto`=自動要約が書いた題名(置き換え可)、
 * `user`=作成後に人が付けた題名(触らない)。
 */
export const TITLE_SOURCE_LABEL = AGENT_TITLE_SOURCE_LABEL;
export const TITLE_SOURCE_AUTO = AGENT_TITLE_SOURCE_AUTO;
export const TITLE_SOURCE_INITIAL = AGENT_TITLE_SOURCE_INITIAL;
export const TITLE_SOURCE_USER = AGENT_TITLE_SOURCE_USER;
/** Set to "1" (e.g. `paseo agent update <id> --label paseo.title-regenerate=1`) to force a re-summary on the next finished turn. */
export const TITLE_REGENERATE_LABEL = AGENT_TITLE_REGENERATE_LABEL;

const MAX_SUMMARY_TITLE_CHARS = 30;
/** Finished-turn counts at which the title is (re)summarised; sparse on purpose so the sidebar stays calm. */
const SUMMARY_TURN_MARKS = new Set([1, 5, 15, 40]);
const GENERATION_TIMEOUT_MS = 120_000;

const TITLE_SCHEMA = z.object({ title: z.string().min(1).max(MAX_EXPLICIT_AGENT_TITLE_CHARS) });

export interface TitleSummaryInput {
  currentTitle: string | null;
  firstUserMessage: string | null;
  recentUserMessages: string[];
  lastAssistantMessage: string | null;
}

export function shouldSummarizeAtTurn(completedTurns: number): boolean {
  return SUMMARY_TURN_MARKS.has(completedTurns);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * True when the title may be overwritten without clobbering a name a person chose.
 *
 * 作成時に付いた題名(`initial`。`paseo run --title` や最初のプロンプト由来)は**置き換えてよい**。
 * サイドバーは LLM が生成した題名を出す、というユーザー決定(2026-10-26)による。
 * 人が作成後に付けた題名(`user`)だけは触らない。
 */
export function isAutoOwnedTitle(input: {
  title: string | null;
  labels: Record<string, string>;
  firstUserMessage: string | null;
}): boolean {
  const source = input.labels[TITLE_SOURCE_LABEL];
  if (source === TITLE_SOURCE_AUTO || source === TITLE_SOURCE_INITIAL) return true;
  if (source === TITLE_SOURCE_USER) return false;
  if (!input.title) return true;
  // A title that is just the provisional first-prompt copy was never chosen by anyone.
  const provisional = input.firstUserMessage
    ? resolveCreateAgentTitles({ initialPrompt: input.firstUserMessage }).provisionalTitle
    : null;
  return provisional !== null && provisional === input.title;
}

export function buildTitleSummaryPrompt(input: TitleSummaryInput): string {
  return [
    "あなたはチャットスレッドの題名を付ける係です。サイドバーの一覧で「このスレが何をしているか」が一目で分かる日本語の題名を1つ作ってください。",
    "",
    "規則:",
    `- 日本語で${MAX_SUMMARY_TITLE_CHARS}文字以内の短い句。英字のスラッグ、作業ID、ファイル名は使わない。固有名詞(F-80、Toposなど)は可。`,
    "- 冒頭の依頼文・役割説明(「あなたは〜担当」「日本語で報告」「依頼元は〜」など)は題名にしない。スレが実際に取り組んでいる内容を書く。",
    "- スレが司令塔として他のスレを束ねている場合は、短く安定した役割名にする(例: 「Topos司令塔」「F-80司令塔」「総司令塔」)。",
    "- 現在の題名が今の内容をまだ正しく表しているなら、一字一句そのまま返す(頻繁に変えない)。役割や作業が明らかに変わったときだけ変える。",
    "- ただし現在の題名が英字の識別名(例: f80-complete-integration, coordinator_backstage, worktree-…)なら、同じ内容を表す日本語の題名に必ず置き換える(そのまま返してはいけない)。",
    '- JSON だけを返す: {"title": "..."}',
    "",
    `現在の題名: ${input.currentTitle ?? "(なし)"}`,
    `最初のユーザー発言: ${input.firstUserMessage ? clip(input.firstUserMessage, 800) : "(なし)"}`,
    "直近のユーザー発言:",
    ...(input.recentUserMessages.length > 0
      ? input.recentUserMessages.map((text) => `- ${clip(text, 300)}`)
      : ["- (なし)"]),
    `直近のアシスタント発言: ${
      input.lastAssistantMessage ? clip(input.lastAssistantMessage, 500) : "(なし)"
    }`,
  ].join("\n");
}

/** Normalises model output; null means "unusable, keep the existing title". */
export function sanitizeSummaryTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/)[0] ?? "";
  const cleaned = firstLine
    .replace(/^[\s"'「『【[]+/, "")
    .replace(/[\s"'」』】\]]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (/^[A-Za-z0-9_.\-/]+$/.test(cleaned)) return null; // bare slug
  if (cleaned.startsWith("あなたは")) return null; // prompt copy
  return cleaned.length > MAX_SUMMARY_TITLE_CHARS
    ? cleaned.slice(0, MAX_SUMMARY_TITLE_CHARS).trim()
    : cleaned;
}

export function extractTitleSummaryInput(
  timeline: readonly AgentTimelineItem[],
  currentTitle: string | null,
): TitleSummaryInput {
  const userMessages: string[] = [];
  let lastAssistantMessage: string | null = null;
  for (const item of timeline) {
    if (item.type === "user_message" && item.text.trim()) userMessages.push(item.text);
    else if (item.type === "assistant_message" && item.text.trim()) {
      lastAssistantMessage = item.text;
    }
  }
  return {
    currentTitle,
    firstUserMessage: userMessages[0] ?? null,
    recentUserMessages: userMessages.slice(-3),
    lastAssistantMessage,
  };
}

export interface AgentTitleSummarizerDeps {
  subscribe(callback: (event: AgentManagerEvent) => void): () => void;
  getTimeline(agentId: string): AgentTimelineItem[];
  getStoredAgent(agentId: string): Promise<{
    title?: string | null;
    labels?: Record<string, string>;
    cwd: string;
    internal?: boolean;
  } | null>;
  updateAgentMetadata(
    agentId: string,
    updates: { title?: string; labels?: Record<string, string> },
  ): Promise<void>;
  generate(request: {
    cwd: string;
    prompt: string;
    schema: typeof TITLE_SCHEMA;
    schemaName: string;
    agentTitle: string;
  }): Promise<{ title: string }>;
  logger: Logger;
}

/**
 * Keeps agent titles meaningful: summarises what a thread is doing after chosen
 * finished turns. Never throws into the agent pipeline; any failure leaves the
 * existing title untouched.
 */
export function createAgentTitleSummarizer(deps: AgentTitleSummarizerDeps): {
  start(): () => void;
  /** Resolves when the queued work is done (tests). */
  idle(): Promise<void>;
  /**
   * 1本だけ今すぐ付け直す(既存スレの一括付け直し用)。
   * `preserveUser` を渡すと、生成の前後で題名の出どころが `user` なら何もしない
   * (一括処理が動いている間に人が改名した題名を消さない)。
   * 題名を書き換えたら true。材料が無い・生成に失敗したら false(題名はそのまま)。
   */
  retitle(agentId: string, options?: { preserveUser?: boolean }): Promise<boolean>;
} {
  const completedTurns = new Map<string, number>();
  let tail: Promise<void> = Promise.resolve();

  /** 一括処理の途中などで人が題名を固定したら、もう手を出さない。 */
  const isLockedByUser = (labels: Record<string, string>, options: { preserveUser?: boolean }) =>
    options.preserveUser === true && labels[TITLE_SOURCE_LABEL] === TITLE_SOURCE_USER;

  /** 保存レコードの title は未設定なら undefined なので、題名判定の入力形へ揃える。 */
  function toTitleState(record: { title?: string | null; labels?: Record<string, string> }) {
    return { title: record.title ?? null, labels: record.labels };
  }

  function canWriteTitle(
    current: { title: string | null; labels: Record<string, string> | undefined },
    firstUserMessage: string | null,
    forced: boolean,
    options: { preserveUser?: boolean },
  ): boolean {
    const labels = current.labels ?? {};
    if (isLockedByUser(labels, options)) return false;
    if (forced) return true;
    return isAutoOwnedTitle({ title: current.title, labels, firstUserMessage });
  }

  async function runGeneration(cwd: string, input: TitleSummaryInput): Promise<{ title: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        deps.generate({
          cwd,
          prompt: buildTitleSummaryPrompt(input),
          schema: TITLE_SCHEMA,
          schemaName: "AgentTitle",
          agentTitle: "Title generator",
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("title generation timed out")),
            GENERATION_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function summarize(
    agentId: string,
    forced: boolean,
    options: { preserveUser?: boolean } = {},
  ): Promise<boolean> {
    const stored = await deps.getStoredAgent(agentId);
    if (!stored || stored.internal) return false;
    const input = extractTitleSummaryInput(deps.getTimeline(agentId), stored.title ?? null);
    if (!input.firstUserMessage) return false;
    if (!canWriteTitle(toTitleState(stored), input.firstUserMessage, forced, options)) return false;

    const title = sanitizeSummaryTitle((await runGeneration(stored.cwd, input)).title);
    if (!title) return false;

    // Re-check ownership: someone may have renamed the thread while the model was thinking.
    const fresh = await deps.getStoredAgent(agentId);
    if (!fresh) return false;
    const { title: previousTitle } = fresh;
    if (!canWriteTitle(toTitleState(fresh), input.firstUserMessage, forced, options)) return false;

    const labelUpdates: Record<string, string> = { [TITLE_SOURCE_LABEL]: TITLE_SOURCE_AUTO };
    if (fresh.labels?.[TITLE_REGENERATE_LABEL] === "1")
      labelUpdates[TITLE_REGENERATE_LABEL] = "done";
    // 付け直しは元の題名を残さないので、戻せるように退避しておく。
    if (forced && previousTitle && previousTitle !== title) {
      labelUpdates[AGENT_TITLE_BEFORE_RETITLE_LABEL] = previousTitle;
    }
    await deps.updateAgentMetadata(agentId, {
      ...(title !== previousTitle ? { title } : {}),
      labels: labelUpdates,
    });
    return true;
  }

  return {
    start() {
      return deps.subscribe((event) => {
        if (event.type !== "agent_stream" || event.event.type !== "turn_completed") return;
        const agentId = event.agentId;
        const count = (completedTurns.get(agentId) ?? 0) + 1;
        completedTurns.set(agentId, count);
        // The regenerate label lives in storage, so resolve it inside the queue.
        tail = tail
          .then(async () => {
            const stored = await deps.getStoredAgent(agentId);
            const forced = stored?.labels?.[TITLE_REGENERATE_LABEL] === "1";
            if (forced || shouldSummarizeAtTurn(count)) await summarize(agentId, forced);
            return undefined;
          })
          .catch((error) => {
            deps.logger.warn({ err: error, agentId }, "agent title summary failed; keeping title");
          });
      });
    },
    idle: () => tail,
    async retitle(agentId, options) {
      // 一括付け直しは並行度を上げない(1本ずつ・直列)。失敗は呼び出し側が数える。
      const run = tail.then(() => summarize(agentId, true, options));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
