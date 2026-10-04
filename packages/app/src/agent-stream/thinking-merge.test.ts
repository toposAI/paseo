import { describe, expect, it } from "vitest";
import type { StreamItem, ThoughtItem } from "@/types/stream";
import { mergeAdjacentThoughts } from "./thinking-merge";

function thought(id: string, text: string, extra: Partial<ThoughtItem> = {}): ThoughtItem {
  return {
    kind: "thought",
    id,
    text,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    status: "ready",
    ...extra,
  };
}

const separator: StreamItem = {
  kind: "assistant_message",
  id: "message-1",
  text: "Between them.",
  timestamp: new Date("2026-01-01T00:00:00.000Z"),
};

describe("mergeAdjacentThoughts", () => {
  it("returns the same array when there is nothing to merge", () => {
    const items: StreamItem[] = [thought("a", "one"), separator, thought("b", "two")];
    expect(mergeAdjacentThoughts(items)).toBe(items);
    expect(mergeAdjacentThoughts([])).toEqual([]);
  });

  it("joins a run of adjacent thoughts into the first row", () => {
    const items: StreamItem[] = [thought("a", "one"), thought("b", "two"), thought("c", "three")];
    const merged = mergeAdjacentThoughts(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      kind: "thought",
      id: "a",
      text: "one\n\ntwo\n\nthree",
    });
  });

  it("takes the last row's timestamp and cursor and keeps the turn", () => {
    const cursor = { epoch: "e1", seq: 42 };
    const items: StreamItem[] = [
      thought("a", "one", { turnId: "turn-1" }),
      thought("b", "two", { turnId: "turn-1", timelineCursor: cursor }),
    ];
    const merged = mergeAdjacentThoughts(items);
    expect(merged[0]).toMatchObject({
      turnId: "turn-1",
      timelineCursor: cursor,
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("stays loading until every row in the run is ready", () => {
    const items: StreamItem[] = [thought("a", "one"), thought("b", "two", { status: "loading" })];
    expect(mergeAdjacentThoughts(items)[0]).toMatchObject({ status: "loading" });
  });

  it("never merges across a turn boundary", () => {
    const items: StreamItem[] = [
      thought("a", "one", { turnId: "turn-1" }),
      thought("b", "two", { turnId: "turn-2" }),
    ];
    expect(mergeAdjacentThoughts(items)).toBe(items);
  });

  it("reuses the merged row while an unchanged run is reprojected", () => {
    const items: StreamItem[] = [thought("a", "one"), thought("b", "two")];
    const first = mergeAdjacentThoughts(items)[0];
    const second = mergeAdjacentThoughts(items)[0];
    expect(second).toBe(first);
  });

  it("rebuilds the row when the trailing thought grows", () => {
    const head: StreamItem[] = [thought("a", "one"), thought("b", "two")];
    const first = mergeAdjacentThoughts(head)[0];
    const grown: StreamItem[] = [head[0]!, thought("b", "two more")];
    const second = mergeAdjacentThoughts(grown)[0];
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ text: "one\n\ntwo more" });
  });
});
