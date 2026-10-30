const SYSTEM_REMINDER_BLOCK_PATTERN =
  /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder\s*>/gi;
const TOTAL_TOKENS_BLOCK_PATTERN = /<total_tokens\b[^>]*>[\s\S]*?<\/total_tokens\s*>/i;
const TOTAL_TOKENS_TAG_PATTERN = /<\/?total_tokens\b[^>]*>/gi;
const QUOTE_PREFIX_PATTERN = /^[\s>]*/;
const BULLET_LINE_PATTERN = /^-\s/;
const ENVIRONMENT_UPDATE_PATTERN = /#\s*Environment update\b/;
// Claude Code renders some attachments as a system message, but the app that talks to it
// through its SDK reports them as a user event on resume. The agent listing is the long one:
// one `<name>: <description>` line per subagent, shown as a raw message after a restart
// (2026-10-30). Its bullet lines continue the paragraph until the blank line after the listing.
const AGENT_LISTING_HEADER = "Available agent types for the Agent tool:";
// The fixed sentence the harness puts after the listing, in the same block but its own paragraph.
const AGENT_LISTING_TRAILER = "When you launch multiple agents for independent work";
// Claude Code writes this note, whole, as its own paragraph after a summary. The pattern spans
// the entire line: a reader who adds words of their own in the same paragraph keeps their turn.
const COMPACT_NOTE_PATTERN =
  /^Note: .+ was read before the last conversation was summarized(?:, but the contents are too large to include)?\. Use Read tool if you need to access it\.?$/;
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

interface HarnessTurnScan {
  sawReminder: boolean;
  sawEnvironmentUpdate: boolean;
  sawTotalTokens: boolean;
  sawAgentListing: boolean;
  sawCompactNote: boolean;
}

function sawHarnessArtifact(scan: HarnessTurnScan): boolean {
  return (
    scan.sawReminder ||
    scan.sawEnvironmentUpdate ||
    scan.sawTotalTokens ||
    scan.sawAgentListing ||
    scan.sawCompactNote
  );
}

/**
 * Reads the harness artifact that starts at `index`, returning where the next one begins.
 * A line the harness did not write ends the scan (`null`): those are the user's own words.
 */
function consumeHarnessParagraph(
  lines: readonly string[],
  index: number,
  scan: HarnessTurnScan,
): number | null {
  const lineText = readLineText(lines[index]!);
  // The note about a file the summary left out is its own paragraph, without reminder tags.
  if (COMPACT_NOTE_PATTERN.test(lineText.trim())) {
    scan.sawCompactNote = true;
    return index + 1;
  }
  if (ENVIRONMENT_UPDATE_PATTERN.test(lineText)) {
    scan.sawEnvironmentUpdate = true;
    // The update's working directories follow as bullets and belong to the reminder.
    let next = index;
    while (next + 1 < lines.length && BULLET_LINE_PATTERN.test(readLineText(lines[next + 1]!))) {
      next += 1;
    }
    return next + 1;
  }
  if (TOTAL_TOKENS_BLOCK_PATTERN.test(lineText)) {
    scan.sawTotalTokens = true;
    return lineText.replace(TOTAL_TOKENS_BLOCK_PATTERN, "").trim().length > 0 ? null : index + 1;
  }
  if (TOTAL_TOKENS_TAG_PATTERN.test(lineText)) {
    // A bare tag line (`<total_tokens>N tokens left</total_tokens>` may wrap) is the banner.
    scan.sawTotalTokens = true;
    const rest = lineText.replace(TOTAL_TOKENS_TAG_PATTERN, "").trim();
    TOTAL_TOKENS_TAG_PATTERN.lastIndex = 0;
    return rest.length > 0 ? null : index + 1;
  }
  TOTAL_TOKENS_TAG_PATTERN.lastIndex = 0;
  if (lineText.startsWith(TOOL_RECORD_PREFIX) || lineText === AGENT_LISTING_HEADER) {
    const isListing = lineText === AGENT_LISTING_HEADER;
    scan.sawAgentListing ||= isListing;
    // A tool record or a listing runs to the end of its paragraph, which spans the blank
    // lines left by the dropped reminder blocks.
    let next = index;
    while (next + 1 < lines.length && readLineText(lines[next + 1]!).trim().length > 0) {
      next += 1;
    }
    while (next + 1 < lines.length && isBlankLine(lines[next + 1]!)) next += 1;
    // The listing's closing sentence is its own paragraph inside the same block.
    if (
      isListing &&
      next + 1 < lines.length &&
      readLineText(lines[next + 1]!)
        .trim()
        .startsWith(AGENT_LISTING_TRAILER)
    ) {
      next += 1;
    }
    return next + 1;
  }
  return lineText.trim().length > 0 ? null : index + 1;
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
  const lines = withoutReminders.split("\n");
  const scan: HarnessTurnScan = {
    sawReminder: withoutReminders !== text,
    sawEnvironmentUpdate: false,
    sawTotalTokens: false,
    sawAgentListing: false,
    sawCompactNote: false,
  };

  let index = 0;
  while (index < lines.length) {
    const next = consumeHarnessParagraph(lines, index, scan);
    // A tool record on its own is ordinary tool output the user may have pasted to ask about;
    // only another harness artifact in the same turn makes it one too.
    if (next === null) return false;
    index = next;
  }
  return sawHarnessArtifact(scan);
}
