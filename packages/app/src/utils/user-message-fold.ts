import { isHarnessContextOnlyMessage } from "./harness-context-message";

/** How a user turn's text is shown in a relay thread (see `foldUserMessage`). */
export type UserMessageFold =
  | { kind: "full" }
  | { kind: "folded"; preview: string; sender: string | null };

/**
 * Settings value: fold long user turns only in a relay thread whose title *is* the mark
 * (`完了箱C`); "suffix" accepts titles that add something after it (`完了箱C (2)`).
 */
export type RelayFolding = "off" | "relay" | "suffix";

/** Turns longer than this fold; the one-line `#<n> <path>` report stays well below it. */
export const RELAY_FOLD_MIN_CHARS = 120;
const PREVIEW_MAX_CHARS = 80;

interface FoldUserMessageInput {
  /** Display title of the thread receiving the turn (Paseo's agent title). */
  agentTitle: string | null | undefined;
  /** Whether the turn carries the user's own images or attachments (never folded). */
  hasMedia?: boolean;
  /** Whether this app sent the turn (the composer stamps every send); the reader's own words stay whole. */
  isOwnSend?: boolean;
  relayFolding: RelayFolding;
  text: string;
  /** Substring identifying a relay thread, e.g. `完了箱C`. */
  titleMark: string;
}

/**
 * The settings `foldUserMessage` reads, kept apart so the view selects them in a single hook
 * instead of adding conditions to the component itself.
 */
export function selectRelayFoldSettings(settings: {
  relayFolding: RelayFolding;
  relayTitleMark: string;
}): { relayFolding: RelayFolding; relayTitleMark: string } {
  return { relayFolding: settings.relayFolding, relayTitleMark: settings.relayTitleMark };
}

/** The envelope the server wraps around a message sent by another agent. */
const AGENT_MESSAGE_ENVELOPE = /^<paseo-system([^<>]*)>\n([\s\S]*)\n<\/paseo-system>$/;

/** The thread is the relay itself, not a thread that merely talks about it. */
function isRelayTitle(title: string | null | undefined, mark: string, mode: RelayFolding): boolean {
  if (!title) return false;
  const normalized = title.trim();
  if (mode === "relay") return normalized === mark;
  return (
    normalized === mark || normalized.startsWith(`${mark} `) || normalized.startsWith(`${mark}(`)
  );
}

function findAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"<>]*)"`).exec(attributes);
  return match?.[1] ?? null;
}

function firstNonBlankLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function truncate(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}…`;
}

/**
 * Decides how a user turn in a relay thread (完了箱C and the like) is shown. Any long message —
 * whether the server wrapped it as an agent message or an older CLI pasted it in without
 * attributing the sender — folds to one line, so a direct send cannot take over the screen and
 * the relay's own answer stays the main content. Short turns (one-line `#<n> <path>` reports,
 * turns this app sent itself, turns carrying images, and every thread whose title is not the
 * relay's are shown whole. `relayFolding` is the reader's setting; `off` leaves the fold out
 * entirely.
 */
export function foldUserMessage(input: FoldUserMessageInput): UserMessageFold {
  const { agentTitle, hasMedia = false, isOwnSend = false, relayFolding, text, titleMark } = input;
  if (relayFolding === "off" || !titleMark || hasMedia || isOwnSend) return { kind: "full" };
  if (!isRelayTitle(agentTitle, titleMark, relayFolding)) return { kind: "full" };
  if (isHarnessContextOnlyMessage(text)) return { kind: "full" };
  if (Array.from(text.trim()).length < RELAY_FOLD_MIN_CHARS) return { kind: "full" };

  const envelope = AGENT_MESSAGE_ENVELOPE.exec(text);
  const attributes = envelope?.[1];
  const sourceId = attributes ? findAttribute(attributes, "source-agent-id") : null;
  if (attributes && sourceId && findAttribute(attributes, "kind") === "agent-message") {
    return {
      kind: "folded",
      preview: truncate(firstNonBlankLine(envelope[2]!), PREVIEW_MAX_CHARS),
      sender: findAttribute(attributes, "source-agent-title") ?? sourceId,
    };
  }
  const body = envelope?.[2] ?? text;
  return {
    kind: "folded",
    preview: truncate(firstNonBlankLine(body), PREVIEW_MAX_CHARS),
    sender: null,
  };
}
