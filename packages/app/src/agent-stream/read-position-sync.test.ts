import { describe, expect, it } from "vitest";
import {
  nextHighWater,
  pickResume,
  shouldDismissUnreadDivider,
  type StoredReadPosition,
} from "./read-position-sync";

const stored: StoredReadPosition = { enabled: true, seq: 10, epoch: "e1" };

describe("pickResume", () => {
  it("opens at the row before the first unread row and marks it", () => {
    expect(pickResume({ stored, timelineEpoch: "e1", loadedSeqs: [8, 10, 12, 15] })).toEqual({
      restoreSeq: 10,
      firstUnreadSeq: 12,
      newestSeq: 15,
    });
  });

  it("starts at the first unread row when the stored row is not loaded", () => {
    expect(pickResume({ stored, timelineEpoch: "e1", loadedSeqs: [12, 15] })).toEqual({
      restoreSeq: 12,
      firstUnreadSeq: 12,
      newestSeq: 15,
    });
  });

  it("does nothing when nothing is newer than the stored row", () => {
    expect(pickResume({ stored, timelineEpoch: "e1", loadedSeqs: [8, 10] })).toBeNull();
    expect(pickResume({ stored, timelineEpoch: "e1", loadedSeqs: [10, 9, 3] })).toBeNull();
  });

  it("ignores a record from another epoch, a disabled thread, or an empty record", () => {
    expect(pickResume({ stored, timelineEpoch: "e2", loadedSeqs: [20] })).toBeNull();
    expect(
      pickResume({ stored: { ...stored, enabled: false }, timelineEpoch: "e1", loadedSeqs: [20] }),
    ).toBeNull();
    expect(
      pickResume({ stored: { ...stored, seq: null }, timelineEpoch: "e1", loadedSeqs: [20] }),
    ).toBeNull();
    expect(pickResume({ stored: null, timelineEpoch: "e1", loadedSeqs: [20] })).toBeNull();
    expect(pickResume({ stored, timelineEpoch: null, loadedSeqs: [20] })).toBeNull();
    expect(pickResume({ stored, timelineEpoch: "e1", loadedSeqs: [] })).toBeNull();
  });
});

describe("nextHighWater", () => {
  it("advances only forward", () => {
    expect(nextHighWater(null, 5)).toBe(5);
    expect(nextHighWater(5, 9)).toBe(9);
    expect(nextHighWater(9, 5)).toBeNull();
    expect(nextHighWater(9, 9)).toBeNull();
    expect(nextHighWater(9, null)).toBeNull();
  });
});

describe("shouldDismissUnreadDivider", () => {
  it("dismisses once the newest row at open has been seen", () => {
    expect(shouldDismissUnreadDivider(14, 15)).toBe(false);
    expect(shouldDismissUnreadDivider(15, 15)).toBe(true);
    expect(shouldDismissUnreadDivider(16, 15)).toBe(true);
    expect(shouldDismissUnreadDivider(null, 15)).toBe(false);
    expect(shouldDismissUnreadDivider(16, null)).toBe(false);
  });
});
