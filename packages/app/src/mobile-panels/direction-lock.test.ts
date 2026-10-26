import { describe, expect, it } from "vitest";

import { decideDirectionLock, shouldReleaseLock } from "./direction-lock";

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

  it("locks a mild diagonal that the panel gesture would still accept", () => {
    expect(decideDirectionLock({ deltaX: -10, deltaY: 10 })).toBe("lock_horizontal");
  });

  it("releases a clearly steeper diagonal", () => {
    expect(decideDirectionLock({ deltaX: -7, deltaY: 12 })).toBe("release");
  });

  it("hands a locked touch back once it is clearly vertical", () => {
    expect(shouldReleaseLock(-12, 40)).toBe(true);
    expect(shouldReleaseLock(-40, 20)).toBe(false);
  });
});
