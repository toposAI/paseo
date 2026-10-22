const SYSTEM_REMINDER_BLOCK_PATTERN =
  /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder\s*>/gi;
const TOTAL_TOKENS_BLOCK_PATTERN = /<total_tokens\b[^>]*>[\s\S]*?<\/total_tokens\s*>/i;
const TOTAL_TOKENS_TAG_PATTERN = /<\/?total_tokens\b[^>]*>/gi;
const QUOTE_PREFIX_PATTERN = /^[\s>]*/;
const BULLET_LINE_PATTERN = /^-\s/;
const ENVIRONMENT_UPDATE_PATTERN = /#\s*Environment update\b/;
const TOOL_RECORD_PREFIX = "Called the ";

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
 * Any line of the user's own keeps the message visible; the caller folds rather than drops,
 * so a message that only quotes such a block can still be expanded.
 */
export function isHarnessContextOnlyMessage(text: string): boolean {
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
  // only a reminder, environment update, or token banner makes the turn a harness artifact.
  return sawReminder || sawEnvironmentUpdate || sawTotalTokens;
}
