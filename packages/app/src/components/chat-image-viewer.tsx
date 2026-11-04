import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  collectChatImages,
  describeChatImageForComment,
  findAssistantImageIndex,
  findUserImageIndex,
  type ChatImageEntry,
} from "@/agent-stream/chat-images";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import {
  captureScrollPositions,
  restoreScrollPositions,
  type ScrollPositionSnapshot,
} from "@/components/scroll-position-snapshot";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { resolveComposerAttachmentSubmitFormat } from "@/composer/attachments/submit";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useAppSettings } from "@/hooks/use-settings";
import type { StreamItem } from "@/types/stream";

interface ChatImageViewerApi {
  /** Both return false when the image is not part of the chat (the caller shows it alone). */
  openUserImage: (imageId: string) => boolean;
  openAssistantImage: (source: string, occurrenceKey: string) => boolean;
}

const ChatImageViewerContext = createContext<ChatImageViewerApi | null>(null);

export function useChatImageViewer(): ChatImageViewerApi | null {
  return useContext(ChatImageViewerContext);
}

interface ChatImageViewerProviderProps {
  agentId: string;
  serverId: string;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  items: readonly StreamItem[];
  children: ReactNode;
}

function toLightboxSource(input: {
  entry: ChatImageEntry;
  index: number;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId: string;
}): ImageLightboxSource {
  const { entry } = input;
  if (entry.type === "user") return { type: "attachment", metadata: entry.metadata };
  return {
    type: "assistant",
    source: entry.source,
    occurrenceKey: `${entry.occurrencePrefix}:viewer:${input.index}`,
    client: input.client,
    workspaceRoot: input.workspaceRoot,
    serverId: input.serverId,
  };
}

/**
 * One enlarged-image viewer per chat. Opening any image of the chat lands on that image, and
 * swiping / the arrows / the side buttons step through the chat's other images in order; the
 * comment box under the image sends a message to this chat that names the image.
 */
export function ChatImageViewerProvider({
  agentId,
  serverId,
  client,
  workspaceRoot,
  items,
  children,
}: ChatImageViewerProviderProps) {
  const { settings } = useAppSettings();
  const sendBehavior: "steer" | "interrupt" =
    settings.sendBehavior === "steer" ? "steer" : "interrupt";
  const entries = useMemo(() => collectChatImages(items, agentId), [agentId, items]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const index = openKey === null ? -1 : entries.findIndex((entry) => entry.key === openKey);
  const current = index >= 0 ? entries[index]! : null;

  const scrollBeforeOpenRef = useRef<ScrollPositionSnapshot | null>(null);

  const close = useCallback(() => {
    setOpenKey(null);
    const snapshot = scrollBeforeOpenRef.current;
    scrollBeforeOpenRef.current = null;
    if (!snapshot) return;
    // The chat behind the viewer must be exactly where it was when the viewer opened.
    restoreScrollPositions(snapshot);
    requestAnimationFrame(() => restoreScrollPositions(snapshot));
    setTimeout(() => restoreScrollPositions(snapshot), 250);
  }, []);
  const openIndex = useCallback(
    (nextIndex: number) => {
      const entry = entries[nextIndex];
      if (!entry) return false;
      if (scrollBeforeOpenRef.current === null && typeof document !== "undefined") {
        scrollBeforeOpenRef.current = captureScrollPositions(document.body);
      }
      setOpenKey(entry.key);
      return true;
    },
    [entries],
  );
  const api = useMemo<ChatImageViewerApi>(
    () => ({
      openUserImage: (imageId) => openIndex(findUserImageIndex(entries, imageId)),
      openAssistantImage: (source, occurrenceKey) =>
        openIndex(findAssistantImageIndex(entries, source, occurrenceKey)),
    }),
    [entries, openIndex],
  );

  const goPrevious = useCallback(() => openIndex(index - 1), [index, openIndex]);
  const goNext = useCallback(() => openIndex(index + 1), [index, openIndex]);
  const submitComment = useCallback(
    async (text: string) => {
      if (!client || !current) throw new Error("not connected");
      const header = describeChatImageForComment({
        entry: current,
        index,
        total: entries.length,
      });
      await dispatchComposerAgentMessage({
        client,
        agentId,
        text: `${header}\n${text}`,
        attachments: [],
        attachmentSubmitFormat: resolveComposerAttachmentSubmitFormat({
          supportsForgeAttachments: false,
        }),
        encodeImages: async () => undefined,
        submission: createMessageSubmissionWriter(serverId),
        activeTurnBehavior: sendBehavior,
      });
    },
    [agentId, client, current, entries.length, index, sendBehavior, serverId],
  );

  const source = useMemo(
    () =>
      current
        ? toLightboxSource({
            entry: current,
            index,
            client,
            workspaceRoot,
            serverId,
          })
        : null,
    [client, current, index, serverId, workspaceRoot],
  );
  const gallery = useMemo(
    () =>
      current
        ? {
            imageKey: current.key,
            index,
            total: entries.length,
            onPrevious: goPrevious,
            onNext: goNext,
          }
        : undefined,
    [current, entries.length, goNext, goPrevious, index],
  );
  // Half-typed comments outlive the viewer: closing and reopening gives each image its text back.
  const draftsRef = useRef<Record<string, string>>({});
  const drafts = useMemo(
    () => ({
      get: (imageKey: string) => draftsRef.current[imageKey] ?? "",
      set: (imageKey: string, text: string) => {
        draftsRef.current[imageKey] = text;
      },
    }),
    [],
  );
  const comment = useMemo(
    () =>
      client
        ? {
            drafts,
            onSubmit: submitComment,
            client,
            serverId,
            agentId,
            cwd: workspaceRoot ?? "",
            sendBehavior,
          }
        : undefined,
    [agentId, client, drafts, sendBehavior, serverId, submitComment, workspaceRoot],
  );

  return (
    <ChatImageViewerContext.Provider value={api}>
      {children}
      <AttachmentLightbox source={source} gallery={gallery} comment={comment} onClose={close} />
    </ChatImageViewerContext.Provider>
  );
}
