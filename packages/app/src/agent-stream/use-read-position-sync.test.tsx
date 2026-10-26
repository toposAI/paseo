// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";

type RpcReply = { ok: boolean } | { enabled: boolean; seq: number | null; epoch: string | null; updatedAt?: number };
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

function row(seq: number): StreamItem {
  return {
    id: `row-${seq}`,
    kind: "assistant_message",
    text: `row ${seq}`,
    timestamp: new Date(),
    timelineCursor: { epoch: "e1", seq },
  } as StreamItem;
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
