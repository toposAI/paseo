import type { AttachmentMetadata } from "@/attachments/types";
import type { StreamItem } from "@/types/stream";
import { createAssistantImageOccurrenceKey } from "@/assistant-image/acquisition-cache";
import { parseAssistantImageMarkdownEntries } from "@/utils/assistant-image-metadata";

/**
 * Every image of one chat in reading order, so the enlarged view can step from one image
 * to the next across messages instead of showing a single image at a time.
 */
export type ChatImageEntry =
  | {
      type: "user";
      key: string;
      metadata: AttachmentMetadata;
      /** Short name for the comment that tells the agent which image this is. */
      name: string;
    }
  | {
      type: "assistant";
      key: string;
      source: string;
      alt?: string;
      /** `${agentId}:${itemId}`, the prefix of the occurrence key of every image in the message. */
      occurrencePrefix: string;
      name: string;
    };

export function collectChatImages(items: readonly StreamItem[], agentId: string): ChatImageEntry[] {
  const entries: ChatImageEntry[] = [];
  for (const item of items) {
    if (item.kind === "user_message") {
      for (const image of item.images ?? []) {
        entries.push({
          type: "user",
          key: `user:${item.id}:${image.id}`,
          metadata: image,
          name: image.fileName?.trim() || image.id,
        });
      }
    } else if (item.kind === "assistant_message") {
      parseAssistantImageMarkdownEntries(item.text).forEach((image, index) => {
        entries.push({
          type: "assistant",
          key: `assistant:${item.id}:${index}`,
          source: image.source,
          ...(image.alt ? { alt: image.alt } : {}),
          occurrencePrefix: createAssistantImageOccurrenceKey({
            agentId,
            itemId: item.id,
          }),
          name: image.alt?.trim() || image.source,
        });
      });
    }
  }
  return entries;
}

export function findUserImageIndex(entries: readonly ChatImageEntry[], imageId: string): number {
  return entries.findIndex((entry) => entry.type === "user" && entry.metadata.id === imageId);
}

/**
 * The clicked image knows its source and an occurrence key that starts with its message's
 * prefix. A merged gallery borrows the first message's id, so a source match is the fallback.
 */
export function findAssistantImageIndex(
  entries: readonly ChatImageEntry[],
  source: string,
  occurrenceKey: string,
): number {
  let fallback = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "assistant" || entry.source !== source) continue;
    if (occurrenceKey.startsWith(`${entry.occurrencePrefix}:`)) return index;
    if (fallback < 0) fallback = index;
  }
  return fallback;
}

export function describeChatImageForComment(input: {
  entry: ChatImageEntry;
  index: number;
  total: number;
}): string {
  const { entry, index, total } = input;
  const who = entry.type === "user" ? "あなたが添付した画像" : "あなたの回答に含まれる画像";
  const source = entry.type === "user" ? entry.name : entry.source;
  // An embedded image's source is its whole base64 body; naming it would flood the message.
  const where = source.startsWith("data:") ? "埋め込み画像" : source;
  return `[画像へのコメント] このチャットの画像 ${index + 1}/${total}(${who}: ${where})`;
}
