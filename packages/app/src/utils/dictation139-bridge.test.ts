import { beforeAll, describe, expect, it } from "vitest";
import {
  getDictation139Bridge,
  subscribeDictation139,
  switchDictation139App,
} from "@/utils/dictation139-bridge";

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
  it("同じ文の別イベントが窓内に再到達しても誰もclaimできない(ネイティブ二重送信)", () => {
    const claims: boolean[] = [];
    const unsub = subscribeDictation139((_e, claim) => {
      claims.push(claim());
    });
    dispatchResult("二重送信テスト");
    dispatchResult("二重送信テスト");
    dispatchResult("別の文");
    unsub();
    expect(claims).toEqual([true, false, true]);
  });

  it("同じイベントのclaimは購読者が何人いても最初の1回だけtrueになる", () => {
    const claims: boolean[] = [];
    const listener = (_event: unknown, claim: () => boolean) => {
      claims.push(claim());
    };
    const unsubs = [1, 2, 3, 4, 5].map(() => subscribeDictation139(listener));
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

describe("switchDictation139App", () => {
  it("橋が無い(ブラウザ)ときは何も起きず、橋があるときだけswitchAppを送る", () => {
    const w = globalThis as unknown as { window?: Record<string, unknown> };
    const saved = w.window;
    try {
      w.window = new EventTarget() as unknown as Record<string, unknown>;
      expect(getDictation139Bridge()).toBeNull();
      expect(() => switchDictation139App()).not.toThrow();
      const sent: unknown[] = [];
      (w.window as Record<string, unknown>).webkit = {
        messageHandlers: { dictation139: { postMessage: (m: unknown) => sent.push(m) } },
      };
      switchDictation139App();
      expect(sent).toEqual([{ action: "switchApp" }]);
    } finally {
      w.window = saved;
    }
  });
});
