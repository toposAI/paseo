import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import type { StreamItem } from "@/types/stream";
import {
  collectChatImages,
  describeChatImageForComment,
  findAssistantImageIndex,
  findUserImageIndex,
} from "./chat-images";

function image(id: string, fileName: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    fileName,
    byteSize: 1,
    createdAt: 1,
  };
}

function user(id: string, images: AttachmentMetadata[]): StreamItem {
  return { kind: "user_message", id, text: "", timestamp: new Date(0), images };
}

function assistant(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(0) } as StreamItem;
}

describe("collectChatImages", () => {
  const items = [
    user("u1", [image("a", "one.png"), image("b", "two.png")]),
    assistant("m1", "text only"),
    assistant("m2", "see ![shot](/tmp/shot.png) and ![](https://example.com/x.png)"),
    user("u2", [image("c", "three.png")]),
  ];

  it("lists user attachments and assistant images across messages in reading order", () => {
    const entries = collectChatImages(items, "agent-1");

    expect(entries.map((entry) => entry.key)).toEqual([
      "user:u1:a",
      "user:u1:b",
      "assistant:m2:0",
      "assistant:m2:1",
      "user:u2:c",
    ]);
  });

  it("ignores image syntax shown inside code", () => {
    const entries = collectChatImages(
      [assistant("m3", "`![a](/x.png)`\n```\n![b](/y.png)\n```\n![c](/z.png)")],
      "agent-1",
    );

    expect(entries.map((entry) => entry.type === "assistant" && entry.source)).toEqual(["/z.png"]);
  });

  it("finds the clicked user image by its attachment id", () => {
    const entries = collectChatImages(items, "agent-1");

    expect(findUserImageIndex(entries, "c")).toBe(4);
    expect(findUserImageIndex(entries, "missing")).toBe(-1);
  });

  it("finds the clicked assistant image by source, preferring its own message", () => {
    const entries = collectChatImages(
      [assistant("m1", "![](/tmp/same.png)"), assistant("m2", "![](/tmp/same.png)")],
      "agent-1",
    );

    expect(findAssistantImageIndex(entries, "/tmp/same.png", "agent-1:m2:node-1")).toBe(1);
    // A merged gallery borrows the first message's id; the source alone still locates it.
    expect(findAssistantImageIndex(entries, "/tmp/same.png", "agent-1:other:node-1")).toBe(0);
    expect(findAssistantImageIndex(entries, "/tmp/none.png", "agent-1:m1:node-1")).toBe(-1);
  });
});

describe("describeChatImageForComment", () => {
  const entries = collectChatImages(
    [
      user("u1", [image("a", "one.png")]),
      assistant("m1", "![](/tmp/shot.png) ![](data:image/png;base64,AAAA)"),
    ],
    "agent-1",
  );

  it("names the position and where the image came from", () => {
    expect(describeChatImageForComment({ entry: entries[0]!, index: 0, total: 3 })).toContain(
      "画像 1/3(あなたが添付した画像: one.png)",
    );
    expect(describeChatImageForComment({ entry: entries[1]!, index: 1, total: 3 })).toContain(
      "あなたの回答に含まれる画像: /tmp/shot.png",
    );
  });

  it("does not paste an embedded image's data into the message", () => {
    const text = describeChatImageForComment({ entry: entries[2]!, index: 2, total: 3 });

    expect(text).toContain("埋め込み画像");
    expect(text).not.toContain("base64");
  });
});
