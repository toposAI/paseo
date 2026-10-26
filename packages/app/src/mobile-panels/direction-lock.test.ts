import { describe, expect, it } from "vitest";

import { decideDirectionLock } from "./direction-lock";

describe("decideDirectionLock", () => {
  it("waits until the finger has moved past the slop", () => {
    expect(decideDirectionLock({ deltaX: -5, deltaY: 3 })).toBe("undecided");
  });

  it("locks to horizontal when the first movement is mostly sideways", () => {
    expect(decideDirectionLock({ deltaX: -12, deltaY: 6 })).toBe("lock_horizontal");
  });

  it("releases to native scrolling when the first movement is vertical", () => {
    expect(decideDirectionLock({ deltaX: -3, deltaY: 14 })).toBe("release");
  });

  it("releases an ambiguous diagonal so list scrolling stays easy", () => {
    expect(decideDirectionLock({ deltaX: -10, deltaY: 10 })).toBe("release");
  });
});
