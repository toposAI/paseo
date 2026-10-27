// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";

type RpcReply =
  | { ok: boolean }
  | { enabled: boolean; seq: number | null; epoch: string | null; updatedAt?: number };
const rpc = vi.hoisted(() => ({
  invokePluginRpc: vi.fn(
    async (_pluginId: string, _method: string, _input?: unknown): Promise<RpcReply | null> => null,
  ),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ invokePluginRpc: rpc.invokePluginRpc }),
  }),
}));
vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  isWeb: true,
}));

import { useSessionStore } from "@/stores/session-store";
import { useReadPositionSync } from "./use-read-position-sync";

function row(seq: number, epoch = "e1"): StreamItem {
  return {
    id: `row-${seq}`,
    kind: "assistant_message",
    text: `row ${seq}`,
    timestamp: new Date(),
    timelineCursor: { epoch, seq },
  } as StreamItem;
}

function readposSetCalls() {
  return rpc.invokePluginRpc.mock.calls.filter(([, method]) => method === "topos.readpos.set");
}

/** The positions actually sent to the daemon, oldest first. */
function sentSeqs(): number[] {
  return readposSetCalls().flatMap(([, , input]) => {
    const seq = (input as { seq?: unknown } | undefined)?.seq;
    return typeof seq === "number" ? [seq] : [];
  });
}

/** The reader scrolling with the keyboard/wheel: the only thing that counts as reading. */
function readerScrolls() {
  act(() => {
    document.dispatchEvent(new Event("wheel"));
  });
}

/** Adds the chat's scrolling area (or gets it) and something on the page outside it. */
function withChatArea(run: (box: HTMLElement, outside: HTMLElement) => void) {
  let box = document.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  const ownBox = box === null;
  if (box === null) {
    box = document.createElement("div");
    box.setAttribute("data-testid", "agent-chat-scroll");
    document.body.appendChild(box);
  }
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  try {
    run(box, outside);
  } finally {
    outside.remove();
    if (ownBox) box.remove();
  }
}

/** The reader clicking in the chat's scrolling area. */
function readerClicksChat() {
  withChatArea((box) => {
    act(() => {
      box.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
  });
}

/** The reader clicking anywhere on the page but the chat. */
function readerClicksOutsideChat() {
  withChatArea((_box, outside) => {
    act(() => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
  });
}

/** The reader pressing a key somewhere on the page. */
function pressKey(key: string, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** Waits for the report debounce to run out, then restores the clock. */
async function settle(spy: ReturnType<typeof vi.spyOn>) {
  await new Promise((resolve) => setTimeout(resolve, 1800));
  spy.mockRestore();
}

function setTitle(title: string) {
  useSessionStore.setState({
    sessions: {
      "host-1": { agents: new Map([["a1", { title }]]) },
    } as never,
  });
}

beforeEach(() => {
  rpc.invokePluginRpc.mockReset();
  rpc.invokePluginRpc.mockImplementation(async (_pluginId, method): Promise<RpcReply | null> => {
    if (method === "topos.readpos.get")
      return { enabled: true, seq: 10, epoch: "e1", updatedAt: 1 };
    return { ok: true };
  });
  setTitle("完了箱C テスト");
});

afterEach(() => {
  vi.restoreAllMocks();
  useSessionStore.setState({ sessions: {} } as never);
});

describe("useReadPositionSync", () => {
  it("jumps to the row before the first unread row and reports where the divider goes", async () => {
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12), row(15)],
        jumpToSeq: jump,
      }),
    );

    await waitFor(() => expect(jump).toHaveBeenCalledWith(10));
    expect(result.current.unreadFromSeq).toBe(12);
  });

  it("leaves the chat at the bottom when there is nothing new", async () => {
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(9), row(10)],
        jumpToSeq: jump,
      }),
    );

    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    expect(jump).not.toHaveBeenCalled();
    expect(result.current.unreadFromSeq).toBeNull();
  });

  it("drops the divider once the newest row at open has been seen", async () => {
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12), row(15)],
        jumpToSeq: jump,
      }),
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    // The viewport is quiet right after the jump; reports resume a few seconds later. The view
    // reports both cursors: the top row (at the divider) and the last row shown in full.
    const afterLanding = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterLanding);
    act(() => result.current.reportViewedSeq(12, 10));
    expect(result.current.unreadFromSeq).toBe(12);
    act(() => result.current.reportViewedSeq(15, 12));
    await waitFor(() => expect(result.current.unreadFromSeq).toBeNull());
    spy.mockRestore();
  });

  it("lands when every unread row already fits on screen (nothing newer is left unseen)", async () => {
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(9), row(10), row(11)],
        jumpToSeq: jump,
      }),
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(11));

    // The viewport reports during the quiet moment: the view is at the top of the unread stretch, so
    // the jump landed, but nothing may be recorded yet. The settle timer has to fire after the quiet
    // window and do the recording itself, or the record never moves and the divider never goes.
    act(() => result.current.reportViewedSeq(11, 9));
    expect(result.current.unreadFromSeq).toBe(11);

    await waitFor(() => expect(result.current.unreadFromSeq).toBeNull(), { timeout: 6000 });
    expect(jump).toHaveBeenCalledWith(10);
  });

  it("does not mark the unread rows as read when the jump never landed", async () => {
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12), row(15)],
        jumpToSeq: jump,
      }),
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    // A failed jump leaves the view at the bottom: the top row is the newest one, below the divider.
    const afterQuiet = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterQuiet);
    act(() => result.current.reportViewedSeq(15, 15));
    expect(result.current.unreadFromSeq).toBe(12);
    // Scrolling down to the newest row is the reader moving, but every row below the divider was
    // already on screen: the report must keep the old position rather than mark them read.
    expect(sentSeqs()).not.toContain(15);
    act(() => result.current.reportViewedSeq(12, 10));
    spy.mockRestore();

    // Only after the reader has been back to the divider is the position theirs to move. The report
    // is debounced by 1.5s, so give the send more room than waitFor's default.
    readerScrolls();
    act(() => result.current.reportViewedSeq(12, 10));
    await waitFor(() => expect(sentSeqs()).toContain(12), { timeout: 4000 });
    expect(sentSeqs()).not.toContain(15);
  });

  it("jumps once more when the rows are attached after the restore", async () => {
    // A fresh page attaches the chat before its rows: the first jump has nothing to go to.
    const jump = vi.fn();
    const { rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [] as StreamItem[] } },
    );
    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(jump).not.toHaveBeenCalled();

    rerender({ items: [row(10), row(12), row(15)] });
    await waitFor(() => expect(jump).toHaveBeenCalledWith(10));
  });

  it("jumps again when older history arrives after the first jump", async () => {
    // A direct link mounts the thread with only its tail attached and the workspace then shows the
    // whole history: the first jump lands on the tail, and only the older rows can reach the record.
    const jump = vi.fn();
    const { rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(12), row(15)] as StreamItem[] } },
    );
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));

    rerender({ items: [row(10), row(12), row(15)] });
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(2));
    expect(jump).toHaveBeenLastCalledWith(10);
  });

  it("stops asking after the second jump", async () => {
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(12), row(15)] as StreamItem[] } },
    );
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
    rerender({ items: [row(10), row(12), row(15)] });
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(2));
    // The reader has scrolled up to a row they had already read: more rows must not pull them back.
    readerScrolls();
    act(() => result.current.reportViewedSeq(12, 12));
    act(() => result.current.reportViewedSeq(8, 8));
    rerender({ items: [row(8), row(10), row(12), row(15)] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(jump).toHaveBeenCalledTimes(2);
  });

  it("forgets the divider when the history changes", async () => {
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items, epoch }: { items: StreamItem[]; epoch: string }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: epoch,
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12), row(15)], epoch: "e1" } },
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    // seq 12 exists in the new history too, but it is a different row: showing the old divider there
    // would point at something the reader never saw.
    rerender({ items: [row(11, "e2"), row(12, "e2"), row(13, "e2")], epoch: "e2" });
    await waitFor(() => expect(result.current.unreadFromSeq).toBeNull());
  });

  it("asks for the history around a record older than the loaded rows instead of the oldest row", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: 5, epoch: "e1" } : { ok: true },
    );
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12)],
        jumpToSeq: jump,
      }),
    );

    await waitFor(() => expect(jump).toHaveBeenCalled());
    // The rows between 5 and 10 are not loaded yet: restore waits for them instead of putting the
    // divider under a gap (which would silently skip that stretch).
    expect(jump).toHaveBeenCalledWith(5);
    expect(result.current.unreadFromSeq).toBeNull();
  });

  it("keeps fetching until the rows between the record and the loaded ones arrive", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: 1, epoch: "e1" } : { ok: true },
    );
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12)] } },
    );
    await waitFor(() => expect(jump).toHaveBeenCalledWith(1));

    // The older rows arrive, but not far enough yet: keep asking instead of giving up on the first
    // answer, or the divider would sit under a gap (or never appear at all).
    rerender({ items: [row(5), row(10), row(12)] });
    await waitFor(() => expect(jump.mock.calls.length).toBeGreaterThan(1));

    rerender({ items: [row(1), row(5), row(10), row(12)] });
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(5));
  });

  it("keeps recording after the history changes", async () => {
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items, epoch }: { items: StreamItem[]; epoch: string }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: epoch,
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12), row(15)], epoch: "e1" } },
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    rerender({ items: [row(11, "e2"), row(12, "e2"), row(13, "e2")], epoch: "e2" });
    await waitFor(() => expect(result.current.unreadFromSeq).toBeNull());

    // The new history is not resumed from (the record belongs to the old one), so what the chat
    // opened with is not where the reader has read to; once the reader moves, reading is recorded —
    // under the new row's history.
    const afterQuiet = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterQuiet);
    act(() => result.current.reportViewedSeq(13, 11));
    readerScrolls();
    act(() => result.current.reportViewedSeq(12, 10));
    spy.mockRestore();
    await waitFor(() => expect(readposSetCalls().length).toBeGreaterThan(0), { timeout: 4000 });
    const last = readposSetCalls().at(-1);
    expect((last?.[2] as { epoch?: string } | undefined)?.epoch).toBe("e2");
  });

  it("does not mark the chat as read from where it opened when there is no record yet", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: null, epoch: null } : { ok: true },
    );
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12), row(15)],
        jumpToSeq: jump,
      }),
    );
    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    // Let the view's first report (taken while the record is still on its way) and the fetched record
    // be applied: where the chat opened is seen from the record on.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    // The chat opens at the bottom and the newest row is on screen without the reader having read
    // it. Recording that would make everything look read: the record waits for the view to move.
    const afterQuiet = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterQuiet);
    act(() => result.current.reportViewedSeq(15, 15));
    act(() => result.current.reportViewedSeq(15, 15));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(sentSeqs()).toEqual([]);
    spy.mockRestore();

    // A resize re-lays the rows out: the top row changes while the reader is still at the bottom.
    // That is not the reader moving.
    const resized = Date.now() + 15_000;
    const spyResize = vi.spyOn(Date, "now").mockReturnValue(resized);
    act(() => result.current.reportViewedSeq(15, 14));
    spyResize.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(sentSeqs()).toEqual([]);

    // Once the reader actually scrolls, reading is recorded again.
    const later = Date.now() + 20_000;
    const spy2 = vi.spyOn(Date, "now").mockReturnValue(later);
    readerScrolls();
    act(() => result.current.reportViewedSeq(12, 10));
    spy2.mockRestore();
    await waitFor(() => expect(sentSeqs()).toContain(12), { timeout: 4000 });
    expect(sentSeqs()).not.toContain(15);
  }, 15_000);

  it("does not record rows that arrive while nobody is at the screen", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: null, epoch: null } : { ok: true },
    );
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12)] } },
    );
    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    // The chat is left open at the bottom and new rows keep coming: they move both ends of the view
    // without anyone scrolling. Recording that is exactly "the chat was newest in the morning".
    const afterQuiet = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterQuiet);
    act(() => result.current.reportViewedSeq(12, 12));
    rerender({ items: [row(10), row(12), row(15)] });
    act(() => result.current.reportViewedSeq(15, 15));
    rerender({ items: [row(10), row(12), row(15), row(18)] });
    act(() => result.current.reportViewedSeq(18, 18));
    spy.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(sentSeqs()).toEqual([]);
  }, 15_000);

  it("keeps recording when the stored row is gone from the history", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: 5, epoch: "e1" } : { ok: true },
    );
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12)] } },
    );
    // The row the record points at is gone from the loaded rows and the history will not grow.
    await waitFor(() => expect(jump).toHaveBeenCalledWith(5));
    rerender({ items: [row(10), row(12)] });
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    const later = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    readerScrolls();
    // The chat stays where it opened (the bottom) until the reader scrolls; the first report is
    // where it opened, the second is the reader.
    act(() => result.current.reportViewedSeq(12, 10));
    act(() => result.current.reportViewedSeq(13, 12));
    spy.mockRestore();
    // Even though the record could not be brought into view, reading is still recorded past it —
    // otherwise this chat would never record anything again.
    await waitFor(() => expect(sentSeqs().length).toBeGreaterThan(0), { timeout: 4000 });
  }, 15_000);

  it("keeps the newest rows out of the record when the jump could not land and news arrives", async () => {
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12), row(15)] } },
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    // The jump did not take effect: the view stays at the bottom, where the top row is the newest.
    // After the landing grace the view is measured there.
    act(() => result.current.reportViewedSeq(15, 15));
    // A new row arrives and the bottom follows it downwards. That is not a landing either: the
    // reader has still not been shown anything above the divider.
    rerender({ items: [row(10), row(12), row(15), row(18)] });
    act(() => result.current.reportViewedSeq(18, 18));

    const afterQuiet = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterQuiet);
    readerScrolls();
    act(() => result.current.reportViewedSeq(18, 18));
    spy.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(sentSeqs()).not.toContain(18);
    expect(sentSeqs()).not.toContain(15);
  }, 15_000);

  it("makes a report held back during the quiet moment wait for the reader", async () => {
    // Everything unread fits on one screen, so a reader who scrolls during the quiet moment sees the
    // whole of it at once: the view does not move afterwards and only the settle timer can record.
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(9), row(10), row(11)],
        jumpToSeq: jump,
      }),
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(11));

    act(() => result.current.reportViewedSeq(11, 9));
    readerClicksChat();
    await waitFor(() => expect(result.current.unreadFromSeq).toBeNull(), { timeout: 6000 });
    // The reader clicked in the chat and looks at row 11 now: that is where their reading is.
    await waitFor(() => expect(sentSeqs()).toEqual([11]), { timeout: 4000 });
  }, 15_000);

  it("does not count a click outside the chat as the reader moving it", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: null, epoch: null } : { ok: true },
    );
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12), row(15)],
        jumpToSeq: jump,
      }),
    );
    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    // The chat opens at the bottom; clicking in the thread list is not scrolling the chat.
    const afterQuiet = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterQuiet);
    act(() => result.current.reportViewedSeq(15, 15));
    readerClicksOutsideChat();
    pressKey("Tab");
    // The view is elsewhere now (a resize, a late layout): the report must still not count, or every
    // click anywhere on the page would let the chat record where it happens to be.
    act(() => result.current.reportViewedSeq(12, 10));
    spy.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(sentSeqs()).toEqual([]);
  }, 15_000);

  describe("a position read on another device", () => {
    function expectUnreadFrom(
      result: { current: { unreadFromSeq: number | null } },
      seq: number | null,
    ) {
      return waitFor(() => expect(result.current.unreadFromSeq).toBe(seq));
    }

    async function openThenComeBack(remoteSeq: number) {
      const jump = vi.fn();
      const { result } = renderHook(() =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items: [row(10), row(12), row(15), row(18)],
          jumpToSeq: jump,
        }),
      );
      await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));
      rpc.invokePluginRpc.mockImplementation(async (_pluginId, method) =>
        method === "topos.readpos.get"
          ? { enabled: true, seq: remoteSeq, epoch: "e1", updatedAt: 2 }
          : { ok: true },
      );
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockRestore();
      jump.mockClear();
      return { result, jump };
    }

    it("moves the divider below what the other device read, without moving the view", async () => {
      const { result, jump } = await openThenComeBack(15);
      await expectUnreadFrom(result, 18);
      expect(jump).not.toHaveBeenCalled();
    });

    it("drops the divider when the other device read everything that was unread", async () => {
      const { result, jump } = await openThenComeBack(18);
      await expectUnreadFrom(result, null);
      expect(jump).not.toHaveBeenCalled();
    });

    it("keeps the divider when the other device is behind this one", async () => {
      const { result } = await openThenComeBack(11);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(result.current.unreadFromSeq).toBe(12);
    });
  });

  it("does not record a chat that followed new rows while the page was away", async () => {
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12), row(15)] } },
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    // The reader scrolls a little and stops below the divider, then leaves the page.
    const later = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    readerScrolls();
    act(() => result.current.reportViewedSeq(14, 12));
    await waitFor(() => expect(sentSeqs()).toEqual([14]), { timeout: 4000 });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // The rows keep coming in overnight and the chat follows them to the bottom. Coming back to the
    // page is not the reader moving the chat: it sits where the news left it, above rows nobody read.
    rerender({ items: [row(10), row(12), row(15), row(18), row(21)] });
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();
    // The reader comes back and scrolls once, finding the chat already at the bottom.
    readerScrolls();
    act(() => result.current.reportViewedSeq(21, 21));
    await settle(spy);
    expect(sentSeqs()).not.toContain(18);
    expect(sentSeqs()).not.toContain(21);
  }, 15_000);

  it("does not record rows that arrived to a chat the reader had stopped scrolling", async () => {
    const jump = vi.fn();
    const { result, rerender } = renderHook(
      ({ items }: { items: StreamItem[] }) =>
        useReadPositionSync({
          serverId: "host-1",
          agentId: "a1",
          timelineEpoch: "e1",
          items,
          jumpToSeq: jump,
        }),
      { initialProps: { items: [row(10), row(12), row(15)] } },
    );
    await waitFor(() => expect(result.current.unreadFromSeq).toBe(12));

    // The reader scrolls back up and stops there; a few seconds later the view's layout settles and
    // reports the same spot again.
    const later = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    readerScrolls();
    act(() => result.current.reportViewedSeq(11, 10));
    await waitFor(() => expect(sentSeqs()).toEqual([11]), { timeout: 4000 });

    // The chat follows the new rows down on its own and the layout settles again at the bottom. The
    // row that arrived while the reader was away is not read by it: the record may only reach what
    // was loaded when the reader last scrolled.
    rerender({ items: [row(10), row(12), row(15), row(18)] });
    act(() => result.current.reportViewedSeq(18, 18));
    act(() => result.current.reportViewedSeq(18, 18));
    rerender({ items: [row(10), row(12), row(15), row(18), row(21)] });
    act(() => result.current.reportViewedSeq(21, 21));
    await settle(spy);
    expect(sentSeqs()).not.toContain(18);
    expect(sentSeqs()).not.toContain(21);
  }, 15_000);

  it("does not resume from a record written under another history", async () => {
    rpc.invokePluginRpc.mockImplementation(
      async (_pluginId, method): Promise<RpcReply | null> =>
        method === "topos.readpos.get" ? { enabled: true, seq: 2, epoch: "e0" } : { ok: true },
    );
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12)],
        jumpToSeq: jump,
      }),
    );

    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    expect(jump).not.toHaveBeenCalled();
    expect(result.current.unreadFromSeq).toBeNull();
  });

  it("asks again when the page is not connected yet", async () => {
    // Opening a thread before the daemon connection is up fails the first fetch ("no client").
    rpc.invokePluginRpc.mockRejectedValueOnce(new Error("no client"));
    const jump = vi.fn();
    renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(12), row(20)],
        jumpToSeq: jump,
      }),
    );

    await waitFor(() => expect(jump).toHaveBeenCalledWith(10), { timeout: 4000 });
    expect(
      rpc.invokePluginRpc.mock.calls.filter(([, method]) => method === "topos.readpos.get"),
    ).toHaveLength(2);
  });

  it("does nothing when the record cannot be fetched", async () => {
    rpc.invokePluginRpc.mockRejectedValue(new Error("offline"));
    const jump = vi.fn();
    const { result } = renderHook(() =>
      useReadPositionSync({
        serverId: "host-1",
        agentId: "a1",
        timelineEpoch: "e1",
        items: [row(10), row(20)],
        jumpToSeq: jump,
      }),
    );

    await waitFor(() => expect(rpc.invokePluginRpc).toHaveBeenCalled());
    expect(jump).not.toHaveBeenCalled();
    expect(result.current.unreadFromSeq).toBeNull();
  });
});
