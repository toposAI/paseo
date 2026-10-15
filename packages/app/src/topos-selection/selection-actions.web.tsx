import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useUnistyles } from "react-native-unistyles";
import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import { resolveComposerAttachmentSubmitFormat } from "@/composer/attachments/submit";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { encodeImages } from "@/utils/encode-images";

const CHAT_SCROLL_SELECTOR = '[data-testid="agent-chat-scroll"]';
const GO_MESSAGE = "やって";
const HIDE_DELAY_MS = 250;
const BAR_WIDTH = 264;
const BAR_HEIGHT = 44;
const EDGE = 8;
const SENT_FLASH_MS = 900;

interface ToposSelectionActionsProps {
  serverId: string;
  agentId: string;
}

interface Pick {
  quote: string;
  top: number;
  left: number;
}

function toQuoteBlock(quote: string): string {
  return quote
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function readSelection(): Pick | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const container =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!container?.closest(CHAT_SCROLL_SELECTOR)) return null;
  const quote =
    createAssistantSelectionClipboardContent(selection)?.plainText ?? selection.toString();
  if (!quote.trim()) return null;
  const rect = range.getBoundingClientRect();
  const maxLeft = Math.max(EDGE, window.innerWidth - BAR_WIDTH - EDGE);
  const left = Math.min(maxLeft, Math.max(EDGE, rect.left + rect.width / 2 - BAR_WIDTH / 2));
  // Below the selection (the OS callout sits above it); flip above when there is no room.
  const below = rect.bottom + 28;
  const top =
    below + BAR_HEIGHT + EDGE > window.innerHeight
      ? Math.max(EDGE, rect.top - BAR_HEIGHT - 12)
      : below;
  return { quote, top, left };
}

export function ToposSelectionActions({ serverId, agentId }: ToposSelectionActionsProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const enabled = useSettings((settings) => settings.toposChatStyle);
  const client = useHostRuntimeClient(serverId);
  const [pick, setPick] = useState<Pick | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentingRef = useRef(false);
  commentingRef.current = commenting;

  const close = useCallback(() => {
    setPick(null);
    setCommenting(false);
    setComment("");
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleChange = () => {
      if (commentingRef.current) return;
      const next = readSelection();
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (next) {
        setStatus("idle");
        setPick(next);
        return;
      }
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        if (!commentingRef.current) setPick(null);
      }, HIDE_DELAY_MS);
    };
    document.addEventListener("selectionchange", handleChange);
    return () => {
      document.removeEventListener("selectionchange", handleChange);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [enabled]);

  const send = useCallback(
    async (body: string) => {
      if (!pick || !client) {
        setStatus("error");
        return;
      }
      const text = `${toQuoteBlock(pick.quote)}\n\n${body}`;
      try {
        // Deliberately no scroll-to-bottom: the reader keeps their place while approving/commenting.
        await dispatchComposerAgentMessage({
          client,
          agentId,
          text,
          attachments: [],
          attachmentSubmitFormat: resolveComposerAttachmentSubmitFormat({
            supportsForgeAttachments: false,
          }),
          encodeImages,
          submission: createMessageSubmissionWriter(serverId),
          activeTurnBehavior: "steer",
        });
        setStatus("sent");
        window.getSelection()?.removeAllRanges();
        setTimeout(() => {
          setStatus("idle");
          close();
        }, SENT_FLASH_MS);
      } catch {
        setStatus("error");
      }
    },
    [agentId, client, close, pick, serverId],
  );

  const handleGo = useCallback(() => void send(GO_MESSAGE), [send]);
  const handleSendComment = useCallback(() => {
    const body = comment.trim();
    if (body) void send(body);
  }, [comment, send]);
  const handleCopy = useCallback(() => {
    // execCommand("copy") runs through the surface's onCopy handler (markdown-aware copy).
    if (!document.execCommand("copy") && pick) void navigator.clipboard?.writeText(pick.quote);
    window.getSelection()?.removeAllRanges();
    close();
  }, [close, pick]);
  const handleStartComment = useCallback(() => setCommenting(true), []);

  if (!enabled || !pick) return null;

  const colors = theme.colors;
  const panel: CSSProperties = {
    position: "fixed",
    top: pick.top,
    left: pick.left,
    zIndex: 1000,
    background: colors.popover,
    color: colors.foreground,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    fontSize: 15,
  };
  const button: CSSProperties = {
    flex: 1,
    height: BAR_HEIGHT - 8,
    margin: 4,
    border: "none",
    borderRadius: 10,
    background: "transparent",
    color: colors.foreground,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
  const keepSelection = (event: { preventDefault: () => void }) => event.preventDefault();

  if (status !== "idle") {
    return (
      <div style={{ ...panel, padding: "10px 16px" }} data-testid="topos-selection-status">
        {status === "sent" ? t("toposSelection.sent") : t("toposSelection.failed")}
      </div>
    );
  }

  if (commenting) {
    return (
      <div
        style={{
          ...panel,
          left: EDGE,
          width: Math.min(340, window.innerWidth - EDGE * 2),
          padding: 8,
        }}
        data-testid="topos-selection-comment"
      >
        <textarea
          autoFocus
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t("toposSelection.commentPlaceholder")}
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            padding: 8,
            background: colors.surface1,
            color: colors.foreground,
            fontSize: 16,
            fontFamily: "inherit",
          }}
          data-testid="topos-selection-comment-input"
        />
        <div style={{ display: "flex", marginTop: 4 }}>
          <button type="button" style={button} onClick={close}>
            {t("toposSelection.cancel")}
          </button>
          <button
            type="button"
            style={{ ...button, opacity: comment.trim() ? 1 : 0.4 }}
            onClick={handleSendComment}
            data-testid="topos-selection-comment-send"
          >
            {t("toposSelection.send")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ ...panel, width: BAR_WIDTH, display: "flex" }}
      onMouseDown={keepSelection}
      data-testid="topos-selection-bar"
    >
      <button type="button" style={button} onClick={handleGo} data-testid="topos-selection-go">
        {t("toposSelection.go")}
      </button>
      <button
        type="button"
        style={button}
        onClick={handleStartComment}
        data-testid="topos-selection-comment-button"
      >
        {t("toposSelection.comment")}
      </button>
      <button type="button" style={button} onClick={handleCopy} data-testid="topos-selection-copy">
        {t("toposSelection.copy")}
      </button>
    </div>
  );
}
