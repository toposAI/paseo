import type { ChatImageFetchResult, FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { getFileNameFromPath } from "@/attachments/utils";
import type { AssistantImageSourceResolution } from "@/utils/assistant-image-source";
import {
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
  createAssistantImageRemoteAcquisitionKey,
  createAssistantImageRemotePreviewAttachmentId,
} from "./acquisition-cache";

/**
 * Acquisition outcome for one assistant image. `directUri` is set when the
 * daemon declines to proxy (old daemon, or proxy disabled) and the image is
 * loaded straight from its URL, matching the pre-proxy behaviour.
 */
export type AssistantImageLocated =
  | { kind: "attachment"; attachment: AttachmentMetadata }
  | { kind: "direct"; uri: string };

export interface AssistantImageFileAcquisitionPort {
  readFile(cwd: string, path: string): Promise<FileReadResult>;
  fetchChatImage(url: string): Promise<ChatImageFetchResult>;
  persist(input: {
    id: string;
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

export interface AssistantImageAcquisition {
  key: string;
  locate: () => Promise<AssistantImageLocated>;
}

const CHAT_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function chatImageFileName(url: string, mimeType: string): string {
  let base = "image";
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (lastSegment) {
      base = lastSegment;
    }
  } catch {
    // Keep the fallback name; the URL was already accepted by the renderer.
  }
  return /\.(png|jpe?g|webp|gif)$/i.test(base)
    ? base
    : `${base}.${CHAT_IMAGE_EXTENSIONS[mimeType] ?? "img"}`;
}

async function locateRemoteImage(input: {
  port: AssistantImageFileAcquisitionPort;
  url: string;
  serverId?: string;
  occurrenceKey: string;
  unavailableMessage: string;
}): Promise<AssistantImageLocated> {
  let result: ChatImageFetchResult;
  try {
    result = await input.port.fetchChatImage(input.url);
  } catch {
    // Old daemons reject unknown requests and timeouts surface here too.
    return { kind: "direct", uri: input.url };
  }
  if (result.status === "direct") {
    return { kind: "direct", uri: input.url };
  }
  if (result.status === "error") {
    throw new Error(input.unavailableMessage);
  }
  return {
    kind: "attachment",
    attachment: await input.port.persist({
      id: createAssistantImageRemotePreviewAttachmentId({
        serverId: input.serverId,
        occurrenceKey: input.occurrenceKey,
        mimeType: result.mimeType,
        url: input.url,
        contentLength: result.bytes.byteLength,
      }),
      bytes: result.bytes,
      mimeType: result.mimeType,
      fileName: chatImageFileName(input.url, result.mimeType),
    }),
  };
}

export function createAssistantImageFileAcquisition(input: {
  port: AssistantImageFileAcquisitionPort | null;
  resolution: AssistantImageSourceResolution | null;
  serverId?: string;
  occurrenceKey: string;
  unavailableMessage: string;
}): AssistantImageAcquisition | null {
  const { port, resolution } = input;
  if (resolution?.kind === "remote") {
    return {
      key: createAssistantImageRemoteAcquisitionKey({
        serverId: input.serverId,
        occurrenceKey: input.occurrenceKey,
        url: resolution.url,
      }),
      locate: async () => {
        if (!port) {
          // No connection yet: behave like the daemon declining the proxy.
          return { kind: "direct", uri: resolution.url };
        }
        return await locateRemoteImage({
          port,
          url: resolution.url,
          serverId: input.serverId,
          occurrenceKey: input.occurrenceKey,
          unavailableMessage: input.unavailableMessage,
        });
      },
    };
  }
  if (resolution?.kind !== "file_rpc") {
    return null;
  }
  return {
    key: createAssistantImageFileAcquisitionKey({
      serverId: input.serverId,
      occurrenceKey: input.occurrenceKey,
      cwd: resolution.cwd,
      path: resolution.path,
    }),
    locate: async () => {
      if (!port) {
        throw new Error(input.unavailableMessage);
      }
      const file = await port.readFile(resolution.cwd, resolution.path);
      if (file.kind !== "image") {
        throw new Error(input.unavailableMessage);
      }
      const attachment = await port.persist({
        id: createAssistantImageFilePreviewAttachmentId({
          serverId: input.serverId,
          occurrenceKey: input.occurrenceKey,
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path || resolution.path),
      });
      return { kind: "attachment", attachment };
    },
  };
}
