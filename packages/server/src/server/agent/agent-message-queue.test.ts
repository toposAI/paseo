import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentMessageQueue } from "./agent-message-queue.js";

function createHarness() {
  let busy = true;
  let subscriber: ((event: unknown) => void) | null = null;
  const manager = {
    hasBlockingRun: () => busy,
    getAgent: () => undefined,
    subscribe: (cb: (event: unknown) => void) => {
      subscriber = cb;
      return () => {};
    },
  };
  const queue = new AgentMessageQueue(manager as never, pino({ level: "silent" }));
  return {
    queue,
    endTurn: async () => {
      busy = false;
      subscriber?.({ type: "agent_state", agent: { id: "a1" } });
      await new Promise((r) => setTimeout(r, 0));
    },
    startTurn: () => {
      busy = true;
    },
  };
}

describe("AgentMessageQueue", () => {
  it("holds messages while the agent is busy and delivers them at the turn boundary", async () => {
    const h = createHarness();
    const deliver = vi.fn(async () => {});
    h.queue.enqueue("a1", { sourceAgentId: "s", deliver });
    await new Promise((r) => setTimeout(r, 0));
    expect(deliver).not.toHaveBeenCalled();
    await h.endTurn();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(h.queue.depth("a1")).toBe(0);
  });

  it("delivers in order, one per turn", async () => {
    const h = createHarness();
    const order: string[] = [];
    h.queue.enqueue("a1", {
      sourceAgentId: "s",
      deliver: async () => {
        order.push("first");
        h.startTurn();
      },
    });
    h.queue.enqueue("a1", { sourceAgentId: "s", deliver: async () => void order.push("second") });
    await h.endTurn();
    expect(order).toEqual(["first"]);
    expect(h.queue.depth("a1")).toBe(1);
    await h.endTurn();
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps draining after a failed delivery", async () => {
    const h = createHarness();
    const ok = vi.fn(async () => {});
    h.queue.enqueue("a1", {
      sourceAgentId: "s",
      deliver: async () => {
        throw new Error("boom");
      },
    });
    h.queue.enqueue("a1", { sourceAgentId: "s", deliver: ok });
    await h.endTurn();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
