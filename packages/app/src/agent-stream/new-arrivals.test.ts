import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { countArrivalsAfter, newestSeqOf } from "./new-arrivals";

function row(seq: number, epoch = "e1"): StreamItem {
  return { id: `r${seq}`, timelineCursor: { epoch, seq } } as unknown as StreamItem;
}

describe("new arrivals", () => {
  it("finds the newest committed row of the epoch", () => {
    expect(newestSeqOf([row(3), row(9), row(5, "e0")], "e1")).toBe(9);
    expect(newestSeqOf([], "e1")).toBeNull();
  });

  it("counts only rows newer than the baseline", () => {
    expect(countArrivalsAfter([row(1), row(2), row(3), row(4)], "e1", 2)).toBe(2);
  });

  it("does not count older history loaded in above the reader", () => {
    expect(countArrivalsAfter([row(-5), row(-4), row(1), row(2)], "e1", 2)).toBe(0);
  });

  it("ignores rows of another epoch and a missing baseline", () => {
    expect(countArrivalsAfter([row(5, "e0"), row(6)], "e1", 5)).toBe(1);
    expect(countArrivalsAfter([row(5)], "e1", null)).toBe(0);
  });

  it("counts an assistant message once however many rows it has, and skips own messages", () => {
    const part = (seq: number, group: string) =>
      ({
        id: `${group}:${seq}`,
        kind: "assistant_message",
        blockGroupId: group,
        timelineCursor: { epoch: "e1", seq },
      }) as unknown as StreamItem;
    const mine = { id: "u1", kind: "user_message", timelineCursor: { epoch: "e1", seq: 3 } };
    const items = [
      row(1),
      part(2, "m1"),
      part(4, "m1"),
      part(5, "m1"),
      mine as unknown as StreamItem,
    ];
    expect(countArrivalsAfter(items, "e1", 1)).toBe(1);
  });
});
