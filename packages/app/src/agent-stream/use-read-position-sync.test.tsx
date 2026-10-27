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

    // The viewport is quiet right after the jump; reports resume a few seconds later.
    const afterLanding = Date.now() + 10_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(afterLanding);
    act(() => result.current.reportViewedSeq(12));
    expect(result.current.unreadFromSeq).toBe(12);
    act(() => result.current.reportViewedSeq(15));
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
    await waitFor(() => expect(sentSeqs()).toContain(12), { timeout: 4000 });
    expect(sentSeqs()).not.toContain(15);
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
