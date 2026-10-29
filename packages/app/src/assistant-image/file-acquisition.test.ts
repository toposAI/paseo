import { describe, expect, it } from "vitest";
import type { ChatImageFetchResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import {
  createAssistantImageFileAcquisition,
  type AssistantImageFileAcquisitionPort,
} from "./file-acquisition";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

class MemoryFileAcquisitionPort implements AssistantImageFileAcquisitionPort {
  readonly reads: Array<{ cwd: string; path: string }> = [];
  readonly chatImageUrls: string[] = [];
  chatImageResult: ChatImageFetchResult | Error = {
    status: "ok",
    bytes: PNG_BYTES,
    mimeType: "image/png",
  };
  readonly persisted: Array<{ id: string; mimeType: string; fileName: string | null }> = [];

  async readFile(cwd: string, path: string) {
    this.reads.push({ cwd, path });
    return {
      kind: "image" as const,
      path,
      mime: "image/png",
      size: 4,
      modifiedAt: "1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
  }

  async fetchChatImage(url: string): Promise<ChatImageFetchResult> {
    this.chatImageUrls.push(url);
    if (this.chatImageResult instanceof Error) {
      throw this.chatImageResult;
    }
    return this.chatImageResult;
  }

  async persist(input: { id: string; mimeType: string; fileName: string | null }) {
    this.persisted.push(input);
    return {
      id: input.id,
      mimeType: input.mimeType,
      storageType: "web-indexeddb" as const,
      storageKey: input.id,
      fileName: input.fileName,
      byteSize: 4,
      createdAt: 1,
    } satisfies AttachmentMetadata;
  }
}

describe("resolveAssistantImageSource", () => {
  it("routes http and https images through the daemon", () => {
    expect(resolveAssistantImageSource({ source: "https://example.com/a.png" })).toEqual({
      kind: "remote",
      url: "https://example.com/a.png",
    });
    expect(resolveAssistantImageSource({ source: "  http://example.com/a.aspx  " })).toEqual({
      kind: "remote",
      url: "http://example.com/a.aspx",
    });
  });

  it("keeps data and blob URIs direct and local files on the file rpc path", () => {
    expect(resolveAssistantImageSource({ source: "data:image/png;base64,AAAA" })?.kind).toBe(
      "direct",
    );
    expect(resolveAssistantImageSource({ source: "blob:https://app/1" })?.kind).toBe("direct");
    expect(
      resolveAssistantImageSource({ source: "shot.png", workspaceRoot: "/workspace" }),
    ).toEqual({ kind: "file_rpc", cwd: "/workspace", path: "shot.png" });
    expect(resolveAssistantImageSource({ source: "   " })).toBeNull();
  });
});

describe("assistant image file acquisition", () => {
  it("recreates the same acquisition with a live port after reconnect", async () => {
    const common = {
      resolution: { kind: "file_rpc" as const, cwd: "/workspace", path: "reconnect.png" },
      serverId: "server",
      occurrenceKey: "agent:message:reconnect-image",
      unavailableMessage: "Image unavailable",
    };
    const disconnected = createAssistantImageFileAcquisition({ ...common, port: null });
    const connectedPort = new MemoryFileAcquisitionPort();
    const connected = createAssistantImageFileAcquisition({ ...common, port: connectedPort });

    expect(disconnected?.key).toBe(connected?.key);
    await expect(disconnected?.locate()).rejects.toThrow("Image unavailable");
    await expect(connected?.locate()).resolves.toMatchObject({
      kind: "attachment",
      attachment: { mimeType: "image/png" },
    });
    expect(connectedPort.reads).toEqual([{ cwd: "/workspace", path: "reconnect.png" }]);
  });

  describe("remote images", () => {
    const remote = (url = "https://cdn.example.com/photos/product-1.png") => ({
      resolution: { kind: "remote" as const, url },
      serverId: "server",
      occurrenceKey: "agent:message:remote-image",
      unavailableMessage: "Image unavailable",
    });

    it("persists proxied bytes with a URL-based key", async () => {
      const port = new MemoryFileAcquisitionPort();
      const acquisition = createAssistantImageFileAcquisition({ ...remote(), port });
      expect(acquisition?.key).toContain("https://cdn.example.com/photos/product-1.png");

      const located = await acquisition?.locate();
      expect(located).toMatchObject({
        kind: "attachment",
        attachment: { mimeType: "image/png", fileName: "product-1.png" },
      });
      expect(port.chatImageUrls).toEqual(["https://cdn.example.com/photos/product-1.png"]);
      expect(port.persisted).toHaveLength(1);
      expect(port.persisted[0]?.id).toMatch(/^preview_/);
    });

    it("adds an extension for URLs without an image suffix", async () => {
      const port = new MemoryFileAcquisitionPort();
      const acquisition = createAssistantImageFileAcquisition({
        ...remote("https://cdn.example.com/image?id=1"),
        port,
      });
      await acquisition?.locate();
      expect(port.persisted[0]?.fileName).toBe("image.png");
    });

    it("loads the URL directly when the daemon declines to proxy", async () => {
      const port = new MemoryFileAcquisitionPort();
      port.chatImageResult = { status: "direct", reason: "disabled" };
      const acquisition = createAssistantImageFileAcquisition({ ...remote(), port });
      await expect(acquisition?.locate()).resolves.toEqual({
        kind: "direct",
        uri: "https://cdn.example.com/photos/product-1.png",
      });
      expect(port.persisted).toHaveLength(0);
    });

    it("falls back to direct when an old daemon rejects the request", async () => {
      const port = new MemoryFileAcquisitionPort();
      port.chatImageResult = new Error("Unknown request type chat_image_request");
      const acquisition = createAssistantImageFileAcquisition({ ...remote(), port });
      await expect(acquisition?.locate()).resolves.toMatchObject({ kind: "direct" });
    });

    it("falls back to direct without a connection", async () => {
      const acquisition = createAssistantImageFileAcquisition({ ...remote(), port: null });
      await expect(acquisition?.locate()).resolves.toEqual({
        kind: "direct",
        uri: "https://cdn.example.com/photos/product-1.png",
      });
    });

    it("throws the unavailable message when the fetch fails", async () => {
      const port = new MemoryFileAcquisitionPort();
      port.chatImageResult = { status: "error", reason: "http_404" };
      const acquisition = createAssistantImageFileAcquisition({ ...remote(), port });
      await expect(acquisition?.locate()).rejects.toThrow("Image unavailable");
      expect(port.persisted).toHaveLength(0);
    });
  });
});
