/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickRecorder, type ClickRecorder } from "./click-recorder";

let sent: Array<{ reason: string; events: Array<Record<string, unknown>> }> = [];
let recorder: ClickRecorder | null = null;
let clock = 1_000_000;

function tap(el: Element, opts: { click: boolean; dx?: number }) {
  el.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5, button: 0 }),
  );
  el.dispatchEvent(
    new MouseEvent("pointerup", {
      bubbles: true,
      clientX: 5 + (opts.dx ?? 0),
      clientY: 5,
      button: 0,
    }),
  );
  if (opts.click)
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  clock = 1_000_000;
  document.body.innerHTML =
    '<div data-testid="sidebar-x"><button id="b" data-testid="row">SECRET LABEL</button></div>';
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  recorder = createClickRecorder({
    win: window,
    doc: document,
    now: () => clock,
    send: (payload) => sent.push(payload as never),
  });
});

afterEach(() => {
  recorder?.dispose();
  vi.useRealTimers();
});

describe("click recorder", () => {
  it("sends nothing when the tap produces a click", () => {
    tap(document.getElementById("b") as Element, { click: true });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });

  it("sends the recent events when a tap gets no click, without any element text", () => {
    tap(document.getElementById("b") as Element, { click: false });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.reason).toBe("no-click");
    const kinds = sent[0]?.events.map((e) => e.kind);
    expect(kinds).toEqual(["pointerdown", "no-click"]);
    expect(JSON.stringify(sent[0])).not.toContain("SECRET");
    expect(sent[0]?.events[1]).toMatchObject({ inSidebar: true });
  });

  it("ignores a drag (pointer moved beyond the tap slop)", () => {
    tap(document.getElementById("b") as Element, { click: false, dx: 40 });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });

  it("throttles repeated no-click reports", () => {
    tap(document.getElementById("b") as Element, { click: false });
    vi.advanceTimersByTime(1000);
    clock += 1000;
    tap(document.getElementById("b") as Element, { click: false });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });

  it("reports immediately when the drag guard cancels a stuck drag", () => {
    recorder?.recordGuardCancel();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.reason).toBe("drag-guard-cancel");
  });

  it("reports a click that was stopped before reaching the bubble phase", () => {
    const stop = (e: Event) => e.stopPropagation();
    document.addEventListener("click", stop, true);
    tap(document.getElementById("b") as Element, { click: true });
    vi.advanceTimersByTime(10);
    document.removeEventListener("click", stop, true);
    expect(sent.map((p) => p.reason)).toEqual(["click-swallowed"]);
  });
});
