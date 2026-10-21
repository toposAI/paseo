import { beforeAll, describe, expect, it } from "vitest";
import { subscribeDictation139 } from "@/utils/dictation139-bridge";

beforeAll(() => {
  // node環境にはwindowが無いため、イベント配送だけをEventTargetで代用する。
  (globalThis as { window?: unknown }).window = new EventTarget();
});

function dispatchResult(text: string) {
  (window as unknown as EventTarget).dispatchEvent(
    new CustomEvent("dictation139", { detail: { type: "result", text } }),
  );
}

describe("subscribeDictation139", () => {
  it("同じイベントのclaimは購読者が何人いても最初の1回だけtrueになる", () => {
    const claims: boolean[] = [];
    const unsubs = [1, 2, 3, 4, 5].map(() =>
      subscribeDictation139((_event, claim) => {
        claims.push(claim());
      }),
    );
    dispatchResult("確認箱");
    unsubs.forEach((u) => u());
    expect(claims).toEqual([true, false, false, false, false]);
  });

  it("別のイベントは別々にclaimできる", () => {
    const claims: boolean[] = [];
    const unsub = subscribeDictation139((_event, claim) => {
      claims.push(claim());
      claims.push(claim());
    });
    dispatchResult("a");
    dispatchResult("b");
    unsub();
    expect(claims).toEqual([true, false, true, false]);
  });

  it("購読解除後は呼ばれない", () => {
    let calls = 0;
    const unsub = subscribeDictation139(() => {
      calls += 1;
    });
    unsub();
    dispatchResult("x");
    expect(calls).toBe(0);
  });
});
