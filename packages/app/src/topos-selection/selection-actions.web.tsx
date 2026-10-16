import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useUnistyles } from "react-native-unistyles";
import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import { resolveComposerAttachmentSubmitFormat } from "@/composer/attachments/submit";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSettings } from "@/hooks/use-settings";
import { openKeyboardWarmup, useToposComposerCollapse } from "@/composer/topos-collapse-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { encodeImages } from "@/utils/encode-images";

const CHAT_SCROLL_SELECTOR = '[data-testid="agent-chat-scroll"]';
const GO_MESSAGE = "やって";
const HIDE_DELAY_MS = 250;
const PANEL_WIDTH = 340; // action bar and comment card share one width
const BAR_WIDTH_DESKTOP = PANEL_WIDTH;
const BAR_WIDTH_MOBILE = 160; // two buttons in an iOS-callout-style pill; copy is left to the native callout
const SETTLE_DELAY_MS = 220;
const HIGHLIGHT_COLOR = "rgba(80, 140, 255, 0.32)";
const BAR_HEIGHT = 44;
const EDGE = 8;
const SENT_FLASH_MS = 900;
const COMMENT_HEIGHT_ESTIMATE = 170;
const DESKTOP_MIN_WIDTH = 768;

/**
 * Per-form-factor tuning for the comment card. Same component, different knobs:
 * - anchor "screen-left": pinned to the left screen edge under the bar (phone).
 * - anchor "selection": opens right under the selection (desktop).
 * - draggable: grab the handle on top to move the card; rememberPosition reuses the last drop spot.
 */
const LAYOUT = {
  mobile: {
    commentWidth: PANEL_WIDTH,
    anchor: "screen-left",
    draggable: false,
    rememberPosition: false,
  },
  desktop: {
    commentWidth: PANEL_WIDTH,
    anchor: "selection",
    draggable: true,
    rememberPosition: true,
  },
} as const;

type Layout = (typeof LAYOUT)[keyof typeof LAYOUT];

function barWidth(): number {
  const width = window.innerWidth >= DESKTOP_MIN_WIDTH ? BAR_WIDTH_DESKTOP : BAR_WIDTH_MOBILE;
  return Math.min(width, window.innerWidth - EDGE * 2);
}

function currentLayout(): Layout {
  return window.innerWidth >= DESKTOP_MIN_WIDTH ? LAYOUT.desktop : LAYOUT.mobile;
}

interface CardPosition {
  top: number;
  left: number;
}

let rememberedPosition: CardPosition | null = null;

function clampCard(position: CardPosition, width: number): CardPosition {
  return {
    top: Math.min(Math.max(EDGE, position.top), Math.max(EDGE, window.innerHeight - 60)),
    left: Math.min(Math.max(EDGE, position.left), Math.max(EDGE, window.innerWidth - width - EDGE)),
  };
}

function initialCardPosition(pick: { top: number; left: number }, layout: Layout): CardPosition {
  const width = Math.min(layout.commentWidth, window.innerWidth - EDGE * 2);
  if (layout.rememberPosition && rememberedPosition) return clampCard(rememberedPosition, width);
  const left = layout.anchor === "selection" ? pick.left : EDGE;
  const top = Math.min(pick.top, window.innerHeight - COMMENT_HEIGHT_ESTIMATE - EDGE);
  return clampCard({ top, left }, width);
}

interface ToposSelectionActionsProps {
  serverId: string;
  agentId: string;
}

interface Pick {
  quote: string;
  range: Range;
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
  const width = barWidth();
  const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
  const left = Math.min(maxLeft, Math.max(EDGE, rect.left + rect.width / 2 - width / 2));
  // The OS callout sits on the opposite side of the selection from where it has room: above
  // when the selection is in the lower half, below when it is in the upper half. On phones we
  // take the other side so the two never overlap; on desktop the OS callout is always above.
  const isPhone = window.innerWidth < DESKTOP_MIN_WIDTH;
  const selectionInUpperHalf = rect.top + rect.height / 2 < window.innerHeight / 2;
  const wantAbove = isPhone && selectionInUpperHalf;
  const aboveTop = rect.top - BAR_HEIGHT - 16;
  const belowTop = rect.bottom + 28;
  const fitsAbove = aboveTop >= EDGE;
  const fitsBelow = belowTop + BAR_HEIGHT + EDGE <= window.innerHeight;
  const useAbove = wantAbove ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
  const top = useAbove ? Math.max(EDGE, aboveTop) : belowTop;
  return { quote, range: range.cloneRange(), top, left };
}

export function ToposSelectionActions({ serverId, agentId }: ToposSelectionActionsProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const enabled = useSettings((settings) => settings.toposChatStyle);
  const client = useHostRuntimeClient(serverId);
  const [pick, setPick] = useState<Pick | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const [cardPos, setCardPos] = useState<CardPosition | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const latestPosRef = useRef<CardPosition | null>(null);
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
    let pointerDown = false;
    const clearTimer = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
    // Show only once the selection has settled (pointer released / handles stopped moving),
    // never while the user is still dragging it out.
    const showSettled = () => {
      if (commentingRef.current) return;
      clearTimer();
      const next = readSelection();
      if (next) {
        setStatus("idle");
        setPick(next);
      } else {
        setPick(null);
      }
    };
    const handleChange = () => {
      if (commentingRef.current) return;
      clearTimer();
      setPick(null);
      if (pointerDown) return;
      hideTimerRef.current = setTimeout(showSettled, SETTLE_DELAY_MS);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (commentingRef.current) return;
      if ((event.target as Element | null)?.closest?.('[data-testid^="topos-selection-"]')) return;
      pointerDown = true;
    };
    const handlePointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      clearTimer();
      hideTimerRef.current = setTimeout(showSettled, 0);
    };
    document.addEventListener("selectionchange", handleChange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerUp, true);
    return () => {
      document.removeEventListener("selectionchange", handleChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", handlePointerUp, true);
      clearTimer();
    };
  }, [enabled]);

  // While the comment card is open the textarea steals focus and the native selection
  // disappears, so paint the saved range ourselves and keep it aligned on scroll/resize.
  const [, setRepaint] = useState(0);
  useEffect(() => {
    if (!commenting) return undefined;
    const bump = () => setRepaint((n) => n + 1);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  }, [commenting]);

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
  const handleStartComment = useCallback(() => {
    if (!pick) return;
    if (window.innerWidth < DESKTOP_MIN_WIDTH) {
      // Phone: use the regular prompt composer so the keyboard handling is the normal one.
      openKeyboardWarmup();
      useToposComposerCollapse.getState().requestQuote(agentId, pick.quote);
      window.getSelection()?.removeAllRanges();
      close();
      return;
    }
    setCardPos(initialCardPosition(pick, currentLayout()));
    setCommenting(true);
  }, [agentId, close, pick]);
  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!cardPos) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { dx: event.clientX - cardPos.left, dy: event.clientY - cardPos.top };
    },
    [cardPos],
  );
  const handleDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const layout = currentLayout();
    const width = Math.min(layout.commentWidth, window.innerWidth - EDGE * 2);
    const next = clampCard({ top: event.clientY - drag.dy, left: event.clientX - drag.dx }, width);
    latestPosRef.current = next;
    setCardPos(next);
  }, []);
  const handleDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (latestPosRef.current && currentLayout().rememberPosition) {
      rememberedPosition = latestPosRef.current;
    }
  }, []);

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
    const layout = currentLayout();
    const highlightRects = Array.from(pick.range.getClientRects());
    return (
      <>
        {highlightRects.map((rect, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            aria-hidden
            style={{
              position: "fixed",
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              background: HIGHLIGHT_COLOR,
              pointerEvents: "none",
              zIndex: 999,
            }}
          />
        ))}
        <div
          style={{
            ...panel,
            top: cardPos?.top ?? pick.top,
            left: cardPos?.left ?? EDGE,
            width: Math.min(layout.commentWidth, window.innerWidth - EDGE * 2),
            padding: 8,
          }}
          data-testid="topos-selection-comment"
        >
          {layout.draggable ? (
            <div
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              style={{
                height: 16,
                margin: "-4px 0 4px",
                cursor: "grab",
                touchAction: "none",
                textAlign: "center",
                color: colors.foregroundMuted,
                fontSize: 12,
                lineHeight: "16px",
                userSelect: "none",
              }}
              data-testid="topos-selection-comment-handle"
            >
              ⋯⋯
            </div>
          ) : null}
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
      </>
    );
  }

  // Phone: mimic the iOS edit-menu callout (measured off a screenshot: ~43pt tall, 15pt text,
  // content-sized buttons, hairline separators, translucent dark blur). There is no official web copy.
  const phone = window.innerWidth < DESKTOP_MIN_WIDTH;
  const barButton: CSSProperties = phone
    ? {
        ...button,
        flex: "none",
        margin: 0,
        padding: "0 20px",
        height: 43,
        fontSize: 15,
        fontWeight: 400,
        color: "#fff",
      }
    : { ...button, fontSize: 17, fontWeight: 400, margin: 0, height: BAR_HEIGHT };
  const separator: CSSProperties = {
    width: 1,
    height: 20,
    background: phone ? "rgba(255,255,255,0.22)" : colors.border,
  };
  return (
    <div
      style={{
        ...panel,
        ...(phone
          ? {
              width: "auto",
              height: 43,
              background: "rgba(44,44,46,0.86)",
              backdropFilter: "blur(20px) saturate(180%)",
              WebkitBackdropFilter: "blur(20px) saturate(180%)",
              border: "none",
              color: "#fff",
              boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
            }
          : { width: barWidth(), height: BAR_HEIGHT }),
        display: "flex",
        alignItems: "center",
        borderRadius: 999,
        overflow: "hidden",
      }}
      onMouseDown={keepSelection}
      data-testid="topos-selection-bar"
    >
      <button type="button" style={barButton} onClick={handleGo} data-testid="topos-selection-go">
        {t("toposSelection.go")}
      </button>
      <div style={separator} />
      <button
        type="button"
        style={barButton}
        onClick={handleStartComment}
        data-testid="topos-selection-comment-button"
      >
        {t("toposSelection.comment")}
      </button>
    </div>
  );
}
