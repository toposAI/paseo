/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { useMemo, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { QueueWriter, QueuedComposerMessage } from "@/composer/actions";
import type { SendBehavior } from "@/composer/input/state";
import { en } from "@/i18n/resources/en";
import {
  AUTO_DRAIN_HALT_REASON_CODES,
  autoDrainHaltReasonKey,
  AWAIT_TURN_ACTIVE_TIMEOUT_MS,
  useComposerAutoDrainQueue,
} from "./auto-drain";

const AGENT_ID = "agent-1";

function queuedMessage(id: string, text = "hello"): QueuedComposerMessage {
  return { id, text, attachments: [] };
}

function appendQueuedMessage(
  id: string,
): (prev: QueuedComposerMessage[]) => QueuedComposerMessage[] {
  return (prev) => [...prev, queuedMessage(id)];
}

// Reads always come back empty (and clear the queue as a side effect) to simulate a queue store
// that has already dropped the item auto-drain is about to dispatch.
function createReadsAsMissingQueue(
  setQueuedMessages: (next: QueuedComposerMessage[]) => void,
): QueueWriter {
  return {
    read: () => {
      setQueuedMessages([]);
      return [];
    },
    write: () => {},
  };
}

interface HarnessInput {
  initialQueue?: QueuedComposerMessage[];
  initialIsAgentRunning?: boolean;
  initialIsCancellingAgent?: boolean;
  initialIsConnected?: boolean;
  initialActiveSendBehavior?: SendBehavior;
  submitMessage: (input: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
}

function useHarness(input: HarnessInput) {
  const [queuedMessages, setQueuedMessages] = useState<QueuedComposerMessage[]>(
    input.initialQueue ?? [],
  );
  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;

  const queue = useMemo<QueueWriter>(
    () => ({
      read: () => queuedMessagesRef.current,
      write: (updater) => {
        setQueuedMessages((prev) => {
          const next = updater(new Map([[AGENT_ID, prev]]));
          return next.get(AGENT_ID) ?? [];
        });
      },
    }),
    [],
  );

  const [isAgentRunning, setIsAgentRunning] = useState(input.initialIsAgentRunning ?? false);
  const [isCancellingAgent, setIsCancellingAgent] = useState(
    input.initialIsCancellingAgent ?? false,
  );
  const [isConnected, setIsConnected] = useState(input.initialIsConnected ?? true);
  const [activeSendBehavior, setActiveSendBehavior] = useState<SendBehavior>(
    input.initialActiveSendBehavior ?? "queue",
  );

  const { autoDrainState, resumeAutoDrain } = useComposerAutoDrainQueue({
    agentId: AGENT_ID,
    activeSendBehavior,
    isCancellingAgent,
    isConnected,
    isAgentRunning,
    queuedMessages,
    queue,
    submitMessage: input.submitMessage,
    failedToSendMessage: "failed to send",
  });

  return {
    autoDrainState,
    resumeAutoDrain,
    queuedMessages,
    setQueuedMessages,
    setIsAgentRunning,
    setIsCancellingAgent,
    setIsConnected,
    setActiveSendBehavior,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useComposerAutoDrainQueue", () => {
  it("submits exactly one queued message once the turn is idle", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await vi.waitFor(() => {
      expect(submitMessage).toHaveBeenCalledTimes(1);
    });
    expect(submitMessage).toHaveBeenCalledWith({ text: "hello", attachments: [] });
    await vi.waitFor(() => {
      expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");
    });
  });

  it("does not dispatch a second queued message until the turn becomes active", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");
    });

    act(() => {
      result.current.setQueuedMessages(appendQueuedMessage("msg-2"));
    });
    // Still awaiting the first message's turn to become active: no second dispatch yet.
    expect(submitMessage).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setIsAgentRunning(true);
    });
    await vi.waitFor(() => {
      expect(result.current.autoDrainState.phase).toBe("idle");
    });

    act(() => {
      result.current.setIsAgentRunning(false);
    });
    await vi.waitFor(() => {
      expect(submitMessage).toHaveBeenCalledTimes(2);
    });
  });

  it("does not send while a permission prompt overrides the queue behavior", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useHarness({
        initialQueue: [queuedMessage("msg-1")],
        initialActiveSendBehavior: "interrupt",
        submitMessage,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it("halts and stops auto-sending after a failed send", async () => {
    const submitMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "send-failed", message: "network down" },
      });
    });

    act(() => {
      result.current.setQueuedMessages(appendQueuedMessage("msg-2"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
  });

  it("halts after the awaitingTurnActive retry also times out", async () => {
    vi.useFakeTimers();
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AWAIT_TURN_ACTIVE_TIMEOUT_MS);
    });
    expect(result.current.autoDrainState).toEqual(
      expect.objectContaining({ phase: "awaitingTurnActive", retriedOnce: true }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AWAIT_TURN_ACTIVE_TIMEOUT_MS);
    });
    expect(result.current.autoDrainState).toEqual({
      phase: "halted",
      reason: { code: "turn-activation-timeout" },
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
  });

  it("halts when the user cancels the agent", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({
        initialQueue: [queuedMessage("msg-1")],
        initialIsCancellingAgent: true,
        submitMessage,
      }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "cancelled" },
      });
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it("does not halt when the queue is empty even if the agent is being cancelled", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({
        initialQueue: [],
        initialIsCancellingAgent: true,
        submitMessage,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.autoDrainState.phase).toBe("idle");
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it("halts mid-send when the agent is cancelled while a dispatch is in flight", async () => {
    let resolveSubmit: (() => void) | undefined;
    const submitMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState.phase).toBe("dispatching");
    });

    act(() => {
      result.current.setIsCancellingAgent(true);
    });

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "cancelled" },
      });
    });

    // The in-flight send resolving afterwards must not overwrite the cancellation halt.
    await act(async () => {
      resolveSubmit?.();
      await Promise.resolve();
    });
    expect(result.current.autoDrainState).toEqual({
      phase: "halted",
      reason: { code: "cancelled" },
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
  });

  it("returns to idle instead of halting on a single missing result", async () => {
    // A missing queue item is not always a bug: it also happens on the legitimate path where the
    // user hits "send now" (or edits the queued item) just before auto-drain's own dispatch runs.
    // That removal is reflected into `queuedMessages` here exactly as it would be in production
    // (`queue.read` and `queuedMessages` share the same underlying source there), so once the
    // dispatch effect discovers the item missing and drops back to idle, there is nothing left to
    // retry and it rests there instead of halting.
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => {
      const [queuedMessages, setQueuedMessages] = useState<QueuedComposerMessage[]>([
        queuedMessage("msg-1"),
      ]);
      const queueRef = useRef<QueueWriter | undefined>(undefined);
      queueRef.current ??= createReadsAsMissingQueue(setQueuedMessages);
      const queue = queueRef.current;
      return useComposerAutoDrainQueue({
        agentId: AGENT_ID,
        activeSendBehavior: "queue",
        isCancellingAgent: false,
        isConnected: true,
        isAgentRunning: false,
        queuedMessages,
        queue,
        submitMessage,
        failedToSendMessage: "failed to send",
      });
    });

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({ phase: "idle" });
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it("escalates to halted after two consecutive missing results for the same message", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const queuedMessagesRef = { current: [] as QueuedComposerMessage[] };
    const queue: QueueWriter = {
      // Unlike the "single missing result" test above, `queuedMessages` (used to pick the next
      // candidate) never shrinks here, so auto-drain keeps retrying the same messageId. A second
      // consecutive miss on that same id is the signature of something genuinely broken (e.g. a
      // queue store that always reads empty), not a one-off race, so it halts instead of retrying
      // forever.
      read: () => queuedMessagesRef.current,
      write: (updater) => {
        queuedMessagesRef.current =
          updater(new Map([[AGENT_ID, queuedMessagesRef.current]])).get(AGENT_ID) ?? [];
      },
    };

    const { result } = renderHook(() =>
      useComposerAutoDrainQueue({
        agentId: AGENT_ID,
        activeSendBehavior: "queue",
        isCancellingAgent: false,
        isConnected: true,
        isAgentRunning: false,
        queuedMessages: [queuedMessage("msg-1")],
        queue,
        submitMessage,
        failedToSendMessage: "failed to send",
      }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "queue-item-missing" },
      });
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it("dispatches normally once a message that first came up missing is genuinely back in the queue", async () => {
    // The consecutive-miss counter must not falsely trip when the *next* attempt for the same
    // messageId actually succeeds: only two misses in a row for the same id should ever halt.
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    let readCount = 0;
    const queue: QueueWriter = {
      read: () => {
        readCount += 1;
        return readCount === 1 ? [] : [queuedMessage("msg-1")];
      },
      write: () => {},
    };

    const { result } = renderHook(() =>
      useComposerAutoDrainQueue({
        agentId: AGENT_ID,
        activeSendBehavior: "queue",
        isCancellingAgent: false,
        isConnected: true,
        isAgentRunning: false,
        queuedMessages: [queuedMessage("msg-1")],
        queue,
        submitMessage,
        failedToSendMessage: "failed to send",
      }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(submitMessage).toHaveBeenCalledWith({ text: "hello", attachments: [] });
  });

  it("does not let a late-resolving send overwrite a dispatch-timeout halt", async () => {
    vi.useFakeTimers();
    let resolveSubmit: (() => void) | undefined;
    const submitMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState.phase).toBe("dispatching");

    // The watchdog fires before the send ever resolves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AWAIT_TURN_ACTIVE_TIMEOUT_MS);
    });
    expect(result.current.autoDrainState).toEqual({
      phase: "halted",
      reason: { code: "dispatch-timeout" },
    });

    // The send that was in flight resolves after the halt: it must not resurrect auto-drain
    // into awaitingTurnActive and silently override the halted state the user is looking at.
    await act(async () => {
      resolveSubmit?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState).toEqual({
      phase: "halted",
      reason: { code: "dispatch-timeout" },
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
  });

  it("does not resend the same message or dispatch a new one during the first retry window", async () => {
    vi.useFakeTimers();
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");

    // First timeout: rescued into a retry on the same messageId, not re-dispatched.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AWAIT_TURN_ACTIVE_TIMEOUT_MS);
    });
    expect(result.current.autoDrainState).toEqual(
      expect.objectContaining({
        phase: "awaitingTurnActive",
        messageId: "msg-1",
        retriedOnce: true,
      }),
    );
    expect(submitMessage).toHaveBeenCalledTimes(1);

    // A newly queued message must not be dispatched while still retrying the first one.
    act(() => {
      result.current.setQueuedMessages(appendQueuedMessage("msg-2"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");
  });

  it("halts when the agent is cancelled while awaitingTurnActive after a successful dispatch", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState.phase).toBe("awaitingTurnActive");
    });

    act(() => {
      result.current.setIsCancellingAgent(true);
    });

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "cancelled" },
      });
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
  });

  it("halts with unexpected-error when sendQueuedComposerMessageNow's returned promise rejects", async () => {
    // `sendQueuedComposerMessageNow` (in actions.ts) internally try/catches `submitMessage` and
    // resolves with `{status: "failed"}` rather than rejecting, so a submitMessage rejection alone
    // never reaches the dispatch effect's `.catch`. The `.catch` path is reachable in production
    // when restoring the queued item after a failed send (the second `queue.write` call in
    // `sendQueuedComposerMessageNow`) itself throws -- e.g. a storage write failure -- which is not
    // guarded by try/catch and so propagates out of the async function. This test exercises that
    // genuine path rather than mocking `sendQueuedComposerMessageNow` itself.
    const submitMessage = vi.fn().mockRejectedValue(new Error("network down"));
    let writeCount = 0;
    const queuedMessagesRef = { current: [queuedMessage("msg-1")] as QueuedComposerMessage[] };
    const queue: QueueWriter = {
      read: () => queuedMessagesRef.current,
      write: (updater) => {
        writeCount += 1;
        // First write removes the dispatched item (must succeed so submitMessage is attempted).
        // Second write is the post-failure restore in actions.ts, which we simulate as failing.
        if (writeCount === 2) {
          throw new Error("queue storage unavailable");
        }
        queuedMessagesRef.current =
          updater(new Map([[AGENT_ID, queuedMessagesRef.current]])).get(AGENT_ID) ?? [];
      },
    };

    const { result } = renderHook(() =>
      useComposerAutoDrainQueue({
        agentId: AGENT_ID,
        activeSendBehavior: "queue",
        isCancellingAgent: false,
        isConnected: true,
        isAgentRunning: false,
        queuedMessages: queuedMessagesRef.current,
        queue,
        submitMessage,
        failedToSendMessage: "failed to send",
      }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "unexpected-error", message: "Error: queue storage unavailable" },
      });
    });
    expect(submitMessage).toHaveBeenCalledTimes(1);
  });

  it("maps every AutoDrainHaltReason code to a real English i18n key", () => {
    expect(en.composer.autoQueue.halted).toEqual(expect.any(String));
    expect(en.composer.autoQueue.resume).toEqual(expect.any(String));
    for (const code of AUTO_DRAIN_HALT_REASON_CODES) {
      const fullKey = autoDrainHaltReasonKey(code);
      const key = fullKey.replace("composer.autoQueue.haltedReason.", "");
      expect(
        en.composer.autoQueue.haltedReason[key as keyof typeof en.composer.autoQueue.haltedReason],
      ).toEqual(expect.any(String));
    }
  });

  it("does not dispatch while disconnected, then dispatches once connected", async () => {
    const submitMessage = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({
        initialQueue: [queuedMessage("msg-1")],
        initialIsConnected: false,
        submitMessage,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(result.current.autoDrainState.phase).toBe("idle");

    act(() => {
      result.current.setIsConnected(true);
    });
    await vi.waitFor(() => {
      expect(submitMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("resumes dispatching a newly queued item after resumeAutoDrain is called post-halt", async () => {
    const submitMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "send-failed", message: "network down" },
      });
    });

    act(() => {
      result.current.setQueuedMessages(appendQueuedMessage("msg-2"));
    });

    act(() => {
      result.current.resumeAutoDrain();
    });

    await vi.waitFor(() => {
      expect(submitMessage).toHaveBeenCalledTimes(2);
    });
  });

  it("resets a halted state to idle when agentId changes", async () => {
    const submitMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const { result, rerender } = renderHook(
      ({ agentId, queuedMessages }) =>
        useComposerAutoDrainQueue({
          agentId,
          activeSendBehavior: "queue",
          isCancellingAgent: false,
          isConnected: true,
          isAgentRunning: false,
          queuedMessages,
          queue: {
            read: () => queuedMessages,
            write: () => {},
          },
          submitMessage,
          failedToSendMessage: "failed to send",
        }),
      {
        initialProps: {
          agentId: AGENT_ID,
          queuedMessages: [queuedMessage("msg-1")] as QueuedComposerMessage[],
        },
      },
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "send-failed", message: "network down" },
      });
    });

    // No queued messages left for the new agent, so the reset settles on `idle` instead of
    // immediately re-dispatching (which would also transiently pass through `idle`, but this
    // isolates the reset itself from that unrelated re-dispatch behavior).
    rerender({ agentId: "agent-2", queuedMessages: [] });

    expect(result.current.autoDrainState).toEqual({ phase: "idle" });
  });

  it("restores a remembered halt when agentId switches back to a previously halted agent", async () => {
    const submitMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const { result, rerender } = renderHook(
      ({ agentId, queuedMessages }) =>
        useComposerAutoDrainQueue({
          agentId,
          activeSendBehavior: "queue",
          isCancellingAgent: false,
          isConnected: true,
          isAgentRunning: false,
          queuedMessages,
          queue: {
            read: () => queuedMessages,
            write: () => {},
          },
          submitMessage,
          failedToSendMessage: "failed to send",
        }),
      {
        initialProps: {
          agentId: AGENT_ID,
          queuedMessages: [queuedMessage("msg-1")] as QueuedComposerMessage[],
        },
      },
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "send-failed", message: "network down" },
      });
    });

    // Switching away resets to idle, same as the plain agentId-switch test above. The queue is
    // kept empty across both switches (as in that test) so the dispatch effect has nothing to
    // pick up and re-dispatch, which would otherwise race the reset effect's own state update
    // within the same commit and mask what this test is isolating: the restore itself.
    rerender({ agentId: "agent-2", queuedMessages: [] });
    expect(result.current.autoDrainState).toEqual({ phase: "idle" });

    // Switching back to the original agent restores the halt it was left with, rather than
    // silently staying on idle and losing the fact that a message failed to send.
    rerender({ agentId: AGENT_ID, queuedMessages: [] });
    expect(result.current.autoDrainState).toEqual({
      phase: "halted",
      reason: { code: "send-failed", message: "network down" },
    });
  });

  it("does not restore a halt after resumeAutoDrain has been called for that agent", async () => {
    const submitMessage = vi.fn().mockRejectedValue(new Error("network down"));
    const { result, rerender } = renderHook(
      ({ agentId, queuedMessages }) =>
        useComposerAutoDrainQueue({
          agentId,
          activeSendBehavior: "queue",
          isCancellingAgent: false,
          isConnected: true,
          isAgentRunning: false,
          queuedMessages,
          queue: {
            read: () => queuedMessages,
            write: () => {},
          },
          submitMessage,
          failedToSendMessage: "failed to send",
        }),
      {
        initialProps: {
          agentId: AGENT_ID,
          queuedMessages: [queuedMessage("msg-1")] as QueuedComposerMessage[],
        },
      },
    );

    await vi.waitFor(() => {
      expect(result.current.autoDrainState).toEqual({
        phase: "halted",
        reason: { code: "send-failed", message: "network down" },
      });
    });

    // Clear the queue first so that resuming doesn't immediately re-dispatch the same doomed
    // message and re-halt before this test can observe the resumed `idle` state.
    rerender({ agentId: AGENT_ID, queuedMessages: [] });
    act(() => {
      result.current.resumeAutoDrain();
    });
    expect(result.current.autoDrainState).toEqual({ phase: "idle" });

    rerender({ agentId: "agent-2", queuedMessages: [] });
    expect(result.current.autoDrainState).toEqual({ phase: "idle" });

    // The remembered halt was cleared by resumeAutoDrain, so switching back must not resurrect it.
    rerender({ agentId: AGENT_ID, queuedMessages: [] });
    expect(result.current.autoDrainState).toEqual({ phase: "idle" });
  });

  it("does not let a stale resolution from a pre-resume dispatch apply to a later dispatch after resume", async () => {
    vi.useFakeTimers();
    const resolvers: Array<() => void> = [];
    const submitMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result } = renderHook(() =>
      useHarness({ initialQueue: [queuedMessage("msg-1")], submitMessage }),
    );

    // First dispatch of msg-1. `sendQueuedComposerMessageNow` optimistically removes it from the
    // queue as part of dispatching, so once this resolves (or is abandoned) it can never be
    // re-picked by messageId -- a resume after this can only ever dispatch a *different* queued
    // item, never the same messageId again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState.phase).toBe("dispatching");
    expect(submitMessage).toHaveBeenCalledTimes(1);

    // The watchdog times it out before the send resolves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AWAIT_TURN_ACTIVE_TIMEOUT_MS);
    });
    expect(result.current.autoDrainState).toEqual({
      phase: "halted",
      reason: { code: "dispatch-timeout" },
    });

    // The user resumes and queues a new message (msg-1 is already gone from the queue, per the
    // comment above).
    act(() => {
      result.current.resumeAutoDrain();
    });
    act(() => {
      result.current.setQueuedMessages(appendQueuedMessage("msg-2"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState).toMatchObject({
      phase: "dispatching",
      messageId: "msg-2",
    });
    expect(submitMessage).toHaveBeenCalledTimes(2);

    // The *first* (abandoned, pre-resume) send now resolves. It must be discarded as stale rather
    // than being applied to the unrelated in-flight dispatch of msg-2.
    await act(async () => {
      resolvers[0]?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState).toMatchObject({
      phase: "dispatching",
      messageId: "msg-2",
    });

    // The second (current) send resolving is what should actually advance the state.
    await act(async () => {
      resolvers[1]?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.autoDrainState).toMatchObject({
      phase: "awaitingTurnActive",
      messageId: "msg-2",
    });
  });
});
