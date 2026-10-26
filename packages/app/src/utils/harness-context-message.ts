const SYSTEM_REMINDER_BLOCK_PATTERN =
  /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder\s*>/gi;
const TOTAL_TOKENS_BLOCK_PATTERN = /<total_tokens\b[^>]*>[\s\S]*?<\/total_tokens\s*>/i;
const TOTAL_TOKENS_TAG_PATTERN = /<\/?total_tokens\b[^>]*>/gi;
const QUOTE_PREFIX_PATTERN = /^[\s>]*/;
const BULLET_LINE_PATTERN = /^-\s/;
const ENVIRONMENT_UPDATE_PATTERN = /#\s*Environment update\b/;
const TOOL_RECORD_PREFIX = "Called the ";
// Claude Code hands hook output back as the turn's text, one `<Event>[:<matcher>] hook ...:`
// header per hook (`SessionStart:compact hook success: ...`, `SessionStart hook additional
// context: ...`). After a compaction or resume this makes the whole turn hook output.
const HOOK_OUTPUT_HEADER_PATTERN =
  /^(?:SessionStart|SessionEnd|UserPromptSubmit|PostToolUse|PreToolUse|Notification|Stop|SubagentStart|SubagentStop|PreCompact)(?::\S+)? hook (?:success|additional context|blocking error|non-blocking error|error|cancelled|stopped continuation)\b/;
// The compaction hook quotes earlier user turns verbatim, blank lines included, and always
// comes last, so everything from its marker on belongs to the hook output.
const COMPACT_CONTEXT_MARKER = "[compact_context]";

// The summary Claude Code writes as the first turn of a compacted or resumed session. Its body
// is free-form with blank lines, so it is recognized by its fixed opening sentence alone.
const COMPACT_SUMMARY_OPENING = "This session is being continued from a previous conversation";

function isHookOutputTurn(text: string): boolean {
  const lines = text.split("\n").map((line) => readLineText(line).trim());
  const markerIndex = lines.findIndex((line) => line.startsWith(COMPACT_CONTEXT_MARKER));
  const head = markerIndex === -1 ? lines : lines.slice(0, markerIndex);
  let sawHeader = markerIndex !== -1 && !head.some((line) => line.length > 0);
  let paragraphStart = true;
  for (const line of head) {
    if (line.length === 0) {
      paragraphStart = true;
      continue;
    }
    if (paragraphStart) {
      // A paragraph that does not open with a hook header is the user's own words.
      if (!HOOK_OUTPUT_HEADER_PATTERN.test(line)) return false;
      sawHeader = true;
    }
    paragraphStart = false;
  }
  return sawHeader;
}

function readLineText(line: string): string {
  // System reminders reach the transcript as blockquote lines, which may escape `_` as `\_`.
  return line.replace(QUOTE_PREFIX_PATTERN, "").replace(/\\_/g, "_");
}

function isBlankLine(line: string): boolean {
  return readLineText(line).trim().length === 0;
}

/**
 * True when a user message carries nothing but text the harness injected into the user's
 * turn — system reminders, the environment update, and records of tool calls the model made.
 * Any line of the user's own keeps the message visible (a hook-output turn is judged per
 * paragraph: each must open with a hook header, the compaction block excepted); the caller folds rather than drops,
 * so a message that only quotes such a block can still be expanded.
 */
export function isHarnessContextOnlyMessage(text: string): boolean {
  // Hook output carries free-form lines (healthchecks, quoted earlier requests), so it is
  // recognized by its headers: every paragraph must open with one, or the user's words stay.
  if (isHookOutputTurn(text)) return true;
  if (readLineText(text.trimStart()).startsWith(COMPACT_SUMMARY_OPENING)) return true;
  const withoutReminders = text.replace(SYSTEM_REMINDER_BLOCK_PATTERN, "");
  const sawReminder = withoutReminders !== text;
  const lines = withoutReminders.split("\n");
  let sawEnvironmentUpdate = false;
  let sawTotalTokens = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = readLineText(lines[index]!);
    if (ENVIRONMENT_UPDATE_PATTERN.test(lineText)) {
      sawEnvironmentUpdate = true;
      // The update's working directories follow as bullets and belong to the reminder.
      while (
        index + 1 < lines.length &&
        BULLET_LINE_PATTERN.test(readLineText(lines[index + 1]!))
      ) {
        index += 1;
      }
      continue;
    }
    if (TOTAL_TOKENS_BLOCK_PATTERN.test(lineText)) {
      sawTotalTokens = true;
      if (lineText.replace(TOTAL_TOKENS_BLOCK_PATTERN, "").trim().length > 0) return false;
      continue;
    }
    if (TOTAL_TOKENS_TAG_PATTERN.test(lineText)) {
      // A bare tag line (`<total_tokens>N tokens left</total_tokens>` may wrap) is the banner.
      sawTotalTokens = true;
      TOTAL_TOKENS_TAG_PATTERN.lastIndex = 0;
      if (lineText.replace(TOTAL_TOKENS_TAG_PATTERN, "").trim().length > 0) return false;
      continue;
    }
    TOTAL_TOKENS_TAG_PATTERN.lastIndex = 0;
    if (lineText.startsWith(TOOL_RECORD_PREFIX)) {
      // A tool record runs to the end of its paragraph, which spans the blank lines left
      // by the dropped reminder blocks.
      while (index + 1 < lines.length && readLineText(lines[index + 1]!).trim().length > 0) {
        index += 1;
      }
      while (index + 1 < lines.length && isBlankLine(lines[index + 1]!)) index += 1;
      continue;
    }
    if (lineText.trim().length > 0) return false;
  }

  // A tool record on its own is ordinary tool output the user may have pasted to ask about;
  // only a reminder, environment update, token banner, or hook-output turn makes it a harness artifact.
  return sawReminder || sawEnvironmentUpdate || sawTotalTokens;
}
