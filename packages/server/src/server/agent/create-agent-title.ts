import {
  AGENT_TITLE_REGENERATE_LABEL,
  AGENT_TITLE_SOURCE_INITIAL,
  AGENT_TITLE_SOURCE_LABEL,
  AGENT_TITLE_SOURCE_USER,
  MAX_EXPLICIT_AGENT_TITLE_CHARS,
} from "@getpaseo/protocol/agent-title-limits";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

/**
 * 作成時の題名に付けるラベル。呼び出し側が title-source を明示していればそれを尊重する
 * (`--title-locked` は `user` を渡してくるので、そのまま通す)。
 */
export function withInitialTitleSource(
  labels: Record<string, string> | undefined,
): Record<string, string> {
  if (labels?.[AGENT_TITLE_SOURCE_LABEL]) return { ...labels };
  return { ...labels, [AGENT_TITLE_SOURCE_LABEL]: AGENT_TITLE_SOURCE_INITIAL };
}

/** 作成**後**の名前変更に付けるラベル。呼び出し側が title-source を指定していればそちらを優先。 */
export function withUserTitleSource(
  labels: Record<string, string> | undefined,
): Record<string, string> {
  if (labels?.[AGENT_TITLE_SOURCE_LABEL]) return { ...labels };
  return { ...labels, [AGENT_TITLE_SOURCE_LABEL]: AGENT_TITLE_SOURCE_USER };
}

/**
 * 改名コマンド用。題名を変えたなら `user` を付けるが、同じ呼び出しで
 * `paseo.title-regenerate=1` を頼まれたときは付けない(その場で付け直させる意思表示なので、
 * `user` を付けると自分で自分をブロックしてしまう)。
 */
export function withRenameTitleSource(
  labels: Record<string, string> | undefined,
): Record<string, string> {
  if (labels?.[AGENT_TITLE_SOURCE_LABEL]) return { ...labels };
  if (labels?.[AGENT_TITLE_REGENERATE_LABEL] === "1") return { ...labels };
  return { ...labels, [AGENT_TITLE_SOURCE_LABEL]: AGENT_TITLE_SOURCE_USER };
}

const MAX_INITIAL_AGENT_TITLE_CHARS = Math.min(60, MAX_EXPLICIT_AGENT_TITLE_CHARS);

function deriveInitialAgentTitle(prompt: string): string | null {
  const firstContentLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstContentLine) {
    return null;
  }
  const normalized = firstContentLine.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const clamped = normalized.slice(0, MAX_INITIAL_AGENT_TITLE_CHARS).trim();
  return clamped.length > 0 ? clamped : null;
}

export function resolveCreateAgentTitles(options: {
  configTitle?: string | null;
  initialPrompt?: string | null;
}): { explicitTitle: string | null; provisionalTitle: string | null } {
  const explicitTitle =
    typeof options.configTitle === "string" && options.configTitle.trim().length > 0
      ? options.configTitle.trim()
      : null;
  const trimmedPrompt = options.initialPrompt?.trim();
  const provisionalTitle =
    explicitTitle ?? (trimmedPrompt ? deriveInitialAgentTitle(trimmedPrompt) : null);

  return {
    explicitTitle,
    provisionalTitle,
  };
}

export function resolveFirstAgentPromptTitle(firstAgentContext?: FirstAgentContext): string | null {
  return (
    resolveCreateAgentTitles({
      initialPrompt: firstAgentContext?.prompt,
    }).provisionalTitle ?? null
  );
}
