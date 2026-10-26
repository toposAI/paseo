import { describe, expect, it } from "vitest";
import { nextHighWater, pickRestoreSeq } from "./read-position-sync";

const stored = { enabled: true, seq: 10, epoch: "e1" };

describe("pickRestoreSeq", () => {
  it("restores to the stored seq when newer rows exist", () => {
    expect(pickRestoreSeq({ stored, timelineEpoch: "e1", loadedSeqs: [8, 12, 15] })).toBe(10);
  });
  it("does nothing when nothing is newer than the stored seq", () => {
    expect(pickRestoreSeq({ stored, timelineEpoch: "e1", loadedSeqs: [8, 10] })).toBeNull();
  });
  it("ignores a record from another epoch, a disabled thread, or an empty record", () => {
    expect(pickRestoreSeq({ stored, timelineEpoch: "e2", loadedSeqs: [20] })).toBeNull();
    expect(
      pickRestoreSeq({
        stored: { ...stored, enabled: false },
        timelineEpoch: "e1",
        loadedSeqs: [20],
      }),
    ).toBeNull();
    expect(
      pickRestoreSeq({
        stored: { ...stored, seq: null },
        timelineEpoch: "e1",
        loadedSeqs: [20],
      }),
    ).toBeNull();
    expect(pickRestoreSeq({ stored: null, timelineEpoch: "e1", loadedSeqs: [20] })).toBeNull();
    expect(pickRestoreSeq({ stored, timelineEpoch: "e1", loadedSeqs: [] })).toBeNull();
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
