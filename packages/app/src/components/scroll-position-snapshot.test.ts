// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { captureScrollPositions, restoreScrollPositions } from "./scroll-position-snapshot";

function makeScroller(input: { scrollTop: number; scrollHeight: number }) {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  Object.defineProperty(element, "clientHeight", { value: 100, configurable: true });
  Object.defineProperty(element, "scrollHeight", {
    value: input.scrollHeight,
    configurable: true,
    writable: true,
  });
  element.scrollTop = input.scrollTop;
  document.body.appendChild(element);
  return element;
}

describe("scroll position snapshot", () => {
  it("puts a scroller back to where it was when it drifted", () => {
    const list = makeScroller({ scrollTop: 400, scrollHeight: 900 });
    const snapshot = captureScrollPositions(document.body);
    list.scrollTop = 336;
    restoreScrollPositions(snapshot);
    expect(list.scrollTop).toBe(400);
  });

  it("leaves a list alone when its content changed meanwhile", () => {
    const list = makeScroller({ scrollTop: 400, scrollHeight: 900 });
    const snapshot = captureScrollPositions(document.body);
    (list as unknown as { scrollHeight: number }).scrollHeight = 1200;
    list.scrollTop = 700;
    restoreScrollPositions(snapshot);
    expect(list.scrollTop).toBe(700);
  });

  it("ignores elements that are not scrollable", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(captureScrollPositions(document.body).some((e) => e.element === plain)).toBe(false);
  });
});
