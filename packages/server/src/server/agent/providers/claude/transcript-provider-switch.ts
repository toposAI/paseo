import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

import { claudeTranscriptPathSync } from "./project-dir.js";

// TOPOS custom: mid-thread provider switch (Anthropic <-> DeepSeek-family).
//
// A Claude Code transcript written against Anthropic's own endpoint carries
// `deferred_tools_delta` attachments (the announcement of tools that are loaded
// lazily through ToolSearch). On resume Claude Code renders them into the
// request as `tool_definition` content blocks. Anthropic's API accepts those;
// the DeepSeek-family Anthropic-compatible endpoints do not and answer
//   422 ... messages[1].content: unknown variant `tool_definition`,
//   expected `tool_reference`
// so every turn after Claude -> DeepSeek-family fails (measured 2026-10-14).
// The attachment is only an advertisement of tool names; the DeepSeek-family
// session has its own tool list, so dropping it loses no conversation content.
// Thinking blocks were not a problem in the measured case (completed turns, 5 hops): DeepSeek-family
// thinking blocks carry a gateway-generated signature that Anthropic accepted
// on resume in the same measurement.

const MARKER = '"deferred_tools_delta"';

export function isNonAnthropicEndpoint(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host !== "anthropic.com" && !host.endsWith(".anthropic.com");
  } catch {
    return true;
  }
}

interface TranscriptEntry {
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  attachment?: { type?: string };
}

/**
 * Removes `deferred_tools_delta` attachment entries from the session transcript,
 * re-linking the `parentUuid` chain around them. Returns how many entries were
 * dropped (0 = file untouched).
 */
export function stripDeferredToolsDelta(content: string): { content: string; removed: number } {
  if (!content.includes(MARKER)) {
    return { content, removed: 0 };
  }
  const lines = content.split("\n");
  const parsed = lines.map((line): TranscriptEntry | null => {
    if (!line.includes(MARKER)) {
      return null;
    }
    try {
      return JSON.parse(line) as TranscriptEntry;
    } catch {
      return null;
    }
  });
  const dropped = new Map<string, string | null>();
  const dropIndexes = new Set<number>();
  parsed.forEach((entry, index) => {
    if (entry?.type === "attachment" && entry.attachment?.type === "deferred_tools_delta") {
      dropIndexes.add(index);
      if (entry.uuid) {
        dropped.set(entry.uuid, entry.parentUuid ?? null);
      }
    }
  });
  if (dropIndexes.size === 0) {
    return { content, removed: 0 };
  }
  const resolveParent = (parentUuid: string): string | null => {
    let current: string | null = parentUuid;
    while (current !== null && dropped.has(current)) {
      current = dropped.get(current) ?? null;
    }
    return current;
  };
  const kept: string[] = [];
  lines.forEach((line, index) => {
    if (dropIndexes.has(index)) {
      return;
    }
    if (dropped.size > 0 && line.includes('"parentUuid"')) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (typeof entry.parentUuid === "string" && dropped.has(entry.parentUuid)) {
          entry.parentUuid = resolveParent(entry.parentUuid);
          kept.push(JSON.stringify(entry));
          return;
        }
      } catch {
        // Keep an unparseable line verbatim; Claude Code skips it the same way.
      }
    }
    kept.push(line);
  });
  return { content: kept.join("\n"), removed: dropIndexes.size };
}

export async function stripDeferredToolsDeltaFromTranscript(input: {
  cwd: string;
  sessionId: string;
  configDir?: string;
}): Promise<number> {
  const transcriptPath = claudeTranscriptPathSync(input);
  let original: string;
  try {
    original = await readFile(transcriptPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  const { content, removed } = stripDeferredToolsDelta(original);
  if (removed === 0) {
    return 0;
  }
  const { mode } = await stat(transcriptPath);
  // Safe against concurrent writers because reloadAgentSession closes the old
  // session before resumeSession runs; the unique tmp name only guards two resumes.
  const tmpPath = `${transcriptPath}.topos-switch.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, content, { mode });
    await rename(tmpPath, transcriptPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  return removed;
}
