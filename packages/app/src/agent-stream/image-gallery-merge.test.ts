import { describe, expect, it } from "vitest";
import type { AssistantMessageItem, StreamItem, ToolCallItem } from "@/types/stream";
import { createStreamPresentation } from "./presentation";
import { mergeSeparatedImageGalleries, pullGalleryAcrossBoundary } from "./image-gallery-merge";

const at = new Date("2026-01-01T00:00:00.000Z");

function image(id: string, source: string, extra: Partial<AssistantMessageItem> = {}) {
  return {
    kind: "assistant_message",
    id,
    text: `![](${source})`,
    timestamp: at,
    turnId: "turn-1",
    ...extra,
  } as AssistantMessageItem;
}

function read(id: string, extra: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: at,
    turnId: "turn-1",
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { id }, output: { id } },
      },
    },
    ...extra,
  };
}

function text(id: string, body: string): AssistantMessageItem {
  return { kind: "assistant_message", id, text: body, timestamp: at, turnId: "turn-1" };
}

const ids = (items: StreamItem[]) => items.map((item) => item.id);

describe("mergeSeparatedImageGalleries", () => {
  it("returns the same array when there is nothing to merge", () => {
    const items: StreamItem[] = [read("r1"), image("i1", "/a.png"), read("r2")];
    expect(mergeSeparatedImageGalleries(items)).toBe(items);
  });

  it("collects alternating read/result images at the last image's position", () => {
    const items: StreamItem[] = [
      read("r1"),
      image("i1", "/a.png"),
      read("r2"),
      image("i2", "/b.png"),
      read("r3"),
      image("i3", "/c.png"),
    ];
    const merged = mergeSeparatedImageGalleries(items);
    expect(ids(merged)).toEqual(["r1", "r2", "r3", "i1"]);
    expect(merged[3]).toMatchObject({ text: "![](/a.png)\n\n![](/b.png)\n\n![](/c.png)" });
  });

  it("keeps tool rows that come after the last image where they are", () => {
    const merged = mergeSeparatedImageGalleries([
      image("i1", "/a.png"),
      read("r1"),
      image("i2", "/b.png"),
      read("r2"),
    ]);
    expect(ids(merged)).toEqual(["r1", "i1", "r2"]);
  });

  it("does not merge across text, another turn, or a lone image", () => {
    const withText: StreamItem[] = [image("i1", "/a.png"), text("t", "hi"), image("i2", "/b.png")];
    expect(mergeSeparatedImageGalleries(withText)).toBe(withText);
    const otherTurn: StreamItem[] = [
      image("i1", "/a.png"),
      read("r1"),
      image("i2", "/b.png", { turnId: "turn-2" }),
    ];
    expect(mergeSeparatedImageGalleries(otherTurn)).toBe(otherTurn);
  });

  it("returns the identical merged row for an unchanged run", () => {
    const rows = [image("i1", "/a.png"), read("r1"), image("i2", "/b.png")];
    const first = mergeSeparatedImageGalleries(rows);
    const second = mergeSeparatedImageGalleries([...rows]);
    expect(second[1]).toBe(first[1]);
  });

  it("keeps the first row's id and the last row's timestamp as the gallery grows", () => {
    const later = new Date("2026-01-01T00:05:00.000Z");
    const merged = mergeSeparatedImageGalleries([
      image("i1", "/a.png"),
      read("r1"),
      image("i2", "/b.png", { timestamp: later, timelineCursor: { epoch: "e", seq: 9 } }),
    ]);
    expect(merged[1]).toMatchObject({
      id: "i1",
      timestamp: later,
      timelineCursor: { epoch: "e", seq: 9 },
    });
  });
});

describe("pullGalleryAcrossBoundary", () => {
  it("moves the tail's trailing gallery into the head", () => {
    const tail: StreamItem[] = [read("r0"), image("i1", "/a.png"), read("r2")];
    const head: StreamItem[] = [image("i2", "/b.png")];
    const split = pullGalleryAcrossBoundary(tail, head)!;
    expect(ids(split.tail)).toEqual(["r0", "r2"]);
    expect(ids(split.head)).toEqual(["i1"]);
    expect(split.head[0]).toMatchObject({ text: "![](/a.png)\n\n![](/b.png)" });
  });

  it("does nothing when the head does not open with an image or text intervenes", () => {
    expect(pullGalleryAcrossBoundary([image("i1", "/a.png")], [text("t", "hi")])).toBeNull();
    expect(
      pullGalleryAcrossBoundary([image("i1", "/a.png"), text("t", "hi")], [image("i2", "/b.png")]),
    ).toBeNull();
  });
});

describe("live presentation", () => {
  it("grows one gallery as image results arrive, without reordering earlier rows", () => {
    const present = createStreamPresentation();
    const run = (tail: StreamItem[], head: StreamItem[]) => {
      const out = present({
        tail,
        head,
        transform: undefined,
        level: "detailed",
        isTurnActive: true,
      });
      return ids([...out.tail, ...out.head]);
    };
    const r1 = read("r1");
    const i1 = image("i1", "/a.png");
    const r2 = read("r2");
    const i2 = image("i2", "/b.png");
    expect(run([r1], [])).toEqual(["r1"]);
    expect(run([r1], [i1])).toEqual(["r1", "i1:block:0"]);
    expect(run([r1, i1, r2], [])).toEqual(["r1", "i1:block:0", "r2"]);
    expect(run([r1, i1, r2], [i2])).toEqual(["r1", "r2", "i1:block:0"]);
    // Settling the head into the tail leaves the same visible order.
    expect(run([r1, i1, r2, i2], [])).toEqual(["r1", "r2", "i1:block:0"]);
  });

  it("does not move an image away from the caption text above it in the same message", () => {
    const caption = text("m:block:0", "Here:");
    const captioned = image("m:block:1", "/a.png", { blockIndex: 1, blockGroupId: "m" });
    const items = [caption, captioned, read("r1"), image("i2", "/b.png")];
    expect(mergeSeparatedImageGalleries(items)).toBe(items);
  });
});
