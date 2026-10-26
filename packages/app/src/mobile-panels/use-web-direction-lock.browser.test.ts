import { afterEach, expect, test } from "vitest";
import { attachLeftSwipeDirectionLock } from "./use-web-direction-lock";

let root: HTMLElement;
let detach: () => void;
afterEach(() => {
  detach?.();
  root?.remove();
});

function setup(inner = "") {
  root = document.createElement("div");
  root.innerHTML = `<div id="list" style="height:200px;overflow-y:auto"><div style="height:800px">row</div></div>${inner}`;
  document.body.appendChild(root);
  detach = attachLeftSwipeDirectionLock(root);
  return root.querySelector("#list") as HTMLElement;
}

function touch(target: Element, type: string, x: number, y: number): TouchEvent {
  const point = new Touch({ identifier: 1, target, clientX: x, clientY: y });
  const event = new TouchEvent(type, {
    touches: type === "touchend" ? [] : [point],
    changedTouches: [point],
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

test("a leftward-horizontal start keeps being prevented even after vertical drift", () => {
  const list = setup();
  touch(list, "touchstart", 200, 100);
  expect(touch(list, "touchmove", 188, 103).defaultPrevented).toBe(true);
  expect(touch(list, "touchmove", 170, 140).defaultPrevented).toBe(true);
  touch(list, "touchend", 170, 140);
});

test("a locked touch is handed back to native scrolling when it turns clearly vertical", () => {
  const list = setup();
  touch(list, "touchstart", 200, 100);
  expect(touch(list, "touchmove", 190, 102).defaultPrevented).toBe(true);
  expect(touch(list, "touchmove", 188, 150).defaultPrevented).toBe(false);
});

test("a vertical start is left to native scrolling for the whole touch", () => {
  const list = setup();
  touch(list, "touchstart", 200, 100);
  expect(touch(list, "touchmove", 198, 115).defaultPrevented).toBe(false);
  expect(touch(list, "touchmove", 150, 130).defaultPrevented).toBe(false);
  touch(list, "touchend", 150, 130);
});

test("a rightward-horizontal start is not locked", () => {
  const list = setup();
  touch(list, "touchstart", 100, 100);
  expect(touch(list, "touchmove", 115, 102).defaultPrevented).toBe(false);
});

test("a horizontally scrollable child keeps its own sideways scroll", () => {
  setup(
    `<div id="bar" style="width:100px;overflow-x:auto"><div style="width:400px">items</div></div>`,
  );
  const bar = root.querySelector("#bar") as HTMLElement;
  touch(bar, "touchstart", 80, 100);
  expect(touch(bar, "touchmove", 60, 102).defaultPrevented).toBe(false);
});
