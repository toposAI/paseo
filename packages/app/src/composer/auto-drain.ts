import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerAttachment } from "@/attachments/types";
import {
  pickNextQueuedMessage,
  sendQueuedComposerMessageNow,
  type QueueWriter,
  type QueuedComposerMessage,
} from "@/composer/actions";
import type { SendBehavior } from "@/composer/input/state";

export const AWAIT_TURN_ACTIVE_TIMEOUT_MS = 30_000;

export type AutoDrainHaltReason =
  | { code: "dispatch-timeout" }
  | { code: "turn-activation-timeout" }
  | { code: "cancelled" }
  | { code: "queue-item-missing" }
  | { code: "send-failed"; message: string }
  | { code: "unexpected-error"; message: string };

export type AutoDrainState =
  | { phase: "idle" }
  | { phase: "dispatching"; messageId: string; since: number }
  | { phase: "awaitingTurnActive"; messageId: string; since: number; retriedOnce: boolean }
  | { phase: "halted"; reason: AutoDrainHaltReason };

// Maps `AutoDrainHaltReason.code` to the corresponding `composer.autoQueue.haltedReason.*` i18n
// key. i18n resource files use camelCase keys, so this is the single place that translates the
// hyphenated internal codes into that naming convention.
const AUTO_DRAIN_HALT_REASON_I18N_KEYS: Record<AutoDrainHaltReason["code"], string> = {
  "dispatch-timeout": "dispatchTimeout",
  "turn-activation-timeout": "turnActivationTimeout",
  cancelled: "cancelled",
  "queue-item-missing": "queueItemMissing",
  "send-failed": "sendFailed",
  "unexpected-error": "unexpectedError",
};

export function autoDrainHaltReasonKey(code: AutoDrainHaltReason["code"]): string {
  return `composer.autoQueue.haltedReason.${AUTO_DRAIN_HALT_REASON_I18N_KEYS[code]}`;
}

// Exposed for tests that verify every code maps to a real i18n key without hardcoding the code
// list a second time (which would drift from `AutoDrainHaltReason["code"]` silently).
export const AUTO_DRAIN_HALT_REASON_CODES = Object.keys(
  AUTO_DRAIN_HALT_REASON_I18N_KEYS,
) as AutoDrainHaltReason["code"][];

export interface ComposerAutoDrainQueueInput {
  agentId: string;
  activeSendBehavior: SendBehavior;
  isCancellingAgent: boolean;
  isConnected: boolean;
  isAgentRunning: boolean;
  queuedMessages: readonly QueuedComposerMessage[];
  queue: QueueWriter;
  submitMessage: (input: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
  failedToSendMessage: string;
}

export interface ComposerAutoDrainQueueResult {
  autoDrainState: AutoDrainState;
  resumeAutoDrain: () => void;
}

// Per-agent memory kept for the lifetime of this hook instance (i.e. across `agentId` changes,
// but not across the Composer component itself unmounting). Both fields live in the same map
// entry -- rather than two separate refs keyed differently -- so a halt reason and its
// missing-streak tracker can never drift to different granularities of "which agent this is
// about" (see the fable-review note on this file for the incident that motivated merging them).
interface PerAgentAutoDrainMemory {
  haltReason?: AutoDrainHaltReason;
  lastMissingMessageId?: string;
}

/**
 * Automatically drains the send-behavior "queue" while a turn is active: once the active turn
 * ends, the oldest queued message is dispatched without requiring the user to press "Send now".
 * See `handleSendQueuedNow` for the manual equivalent, which this deliberately does not touch.
 *
 * Assumes a single instance of this hook per agent. Mounting it more than once for the same
 * agent lets the instances race over the same queue, which can surface as a spurious
 * `queue-item-missing` halt.
 *
 * Per-agent memory (used to restore a halt, and to track missing-streaks, when `agentId`
 * switches back to a previously seen agent) is only kept for the lifetime of this hook instance
 * -- i.e. across `agentId` changes, but not across the Composer component itself unmounting.
 */
export function useComposerAutoDrainQueue(
  input: ComposerAutoDrainQueueInput,
): ComposerAutoDrainQueueResult {
  const {
    agentId,
    activeSendBehavior,
    isCancellingAgent,
    isConnected,
    isAgentRunning,
    queuedMessages,
    queue,
    submitMessage,
    failedToSendMessage,
  } = input;

  const [autoDrainState, setAutoDrainState] = useState<AutoDrainState>({ phase: "idle" });

  // Single source of truth for "which dispatch (if any) is still allowed to apply its result."
  // Incremented on every dispatch start, every agentId switch, and every resumeAutoDrain call.
  // A dispatch's `.then`/`.catch` handler captures the seq value at dispatch time and only
  // applies its outcome if that value still matches `dispatchSeqRef.current` when the promise
  // settles -- this replaces comparing `prev.phase`/`prev.messageId` against the resolved state,
  // which could not distinguish "a newer dispatch of the same messageId is in flight" (e.g. a
  // Resume re-picking the same still-queued item) from "this is still the original dispatch."
  const dispatchSeqRef = useRef(0);

  const agentMemoryRef = useRef<Map<string, PerAgentAutoDrainMemory>>(new Map());

  const getAgentMemory = useCallback((forAgentId: string): PerAgentAutoDrainMemory => {
    let memory = agentMemoryRef.current.get(forAgentId);
    if (!memory) {
      memory = {};
      agentMemoryRef.current.set(forAgentId, memory);
    }
    return memory;
  }, []);

  // Halts, recording the reason in `agentMemoryRef` so it can be restored if `agentId` later
  // switches away and back. Centralizes every `phase: "halted"` transition so none of them forget
  // to record it.
  const haltWithReason = useCallback(
    (reason: AutoDrainHaltReason): AutoDrainState => {
      getAgentMemory(agentId).haltReason = reason;
      return { phase: "halted", reason };
    },
    [agentId, getAgentMemory],
  );

  // Repoint the composer at a different agent: restore that agent's remembered halt (if any),
  // otherwise fall back to idle. This deliberately does not carry over a previous agent's
  // dispatch/halt state -- only a halt remembered for the *new* agentId is restored.
  //
  // Done as a render-time state adjustment (React's documented "adjusting state when a prop
  // changes" pattern: https://react.dev/learn/you-might-not-need-an-effect) rather than an
  // `agentId`-keyed useEffect. An effect-based reset lands in a *separate* commit from the watcher
  // and dispatch effects below, so on the render where `agentId` switches, those effects would
  // still see the *previous* agent's `autoDrainState` alongside the *new* `agentId` -- an
  // inconsistent pairing that let a same-commit race clobber a remembered halt with a fresh
  // dispatch (or attribute a cancellation/timeout to the wrong agent). Adjusting state during
  // render instead means React re-renders immediately with the corrected state before any effect
  // for this commit runs, so no effect ever observes that inconsistent pairing.
  const [renderedAgentId, setRenderedAgentId] = useState(agentId);
  if (renderedAgentId !== agentId) {
    setRenderedAgentId(agentId);
    // Invalidate any in-flight dispatch from the agent being switched away from: without this,
    // a dispatch started on the old agent could still resolve after the switch and apply its
    // outcome (halt reason, missing-streak) to the now-current agentId via the `agentId` closures
    // in the dispatch effect below.
    dispatchSeqRef.current += 1;
    const rememberedReason = agentMemoryRef.current.get(agentId)?.haltReason;
    setAutoDrainState(
      rememberedReason ? { phase: "halted", reason: rememberedReason } : { phase: "idle" },
    );
  }

  // Watcher effect: only responsible for getting `dispatching`/`awaitingTurnActive` unstuck
  // (success, timeout, retry, or cancellation). Connection/behavior/permission gating lives in
  // the dispatch effect below.
  useEffect(() => {
    if (autoDrainState.phase !== "dispatching" && autoDrainState.phase !== "awaitingTurnActive") {
      return undefined;
    }
    // Cancellation can happen mid-send or mid-wait, not just before a send starts, so it's
    // checked here rather than only in the dispatch effect. Bumps `dispatchSeqRef` (see its
    // declaration above) so a since-abandoned dispatch/send can't apply a late result on top of
    // this halt.
    if (isCancellingAgent) {
      dispatchSeqRef.current += 1;
      setAutoDrainState(haltWithReason({ code: "cancelled" }));
      return undefined;
    }
    if (autoDrainState.phase === "dispatching") {
      const remaining = AWAIT_TURN_ACTIVE_TIMEOUT_MS - (Date.now() - autoDrainState.since);
      const timer = setTimeout(
        () => {
          // The dispatch this watchdog is timing out may still resolve later (e.g. a slow
          // `submitMessage`); bump the seq first so that late resolution is discarded as stale
          // instead of overwriting this halt.
          dispatchSeqRef.current += 1;
          setAutoDrainState(haltWithReason({ code: "dispatch-timeout" }));
        },
        Math.max(remaining, 0),
      );
      return () => clearTimeout(timer);
    }
    if (isAgentRunning) {
      setAutoDrainState({ phase: "idle" });
      return undefined;
    }
    const remaining = AWAIT_TURN_ACTIVE_TIMEOUT_MS - (Date.now() - autoDrainState.since);
    const timer = setTimeout(
      () => {
        if (autoDrainState.retriedOnce) {
          dispatchSeqRef.current += 1;
          setAutoDrainState(haltWithReason({ code: "turn-activation-timeout" }));
        } else {
          // Rather than fall back to `idle` (which would let the dispatch effect below pick up a
          // newer queued message instead of retrying this one), stay on the same messageId and
          // give it a single retry window.
          setAutoDrainState({
            phase: "awaitingTurnActive",
            messageId: autoDrainState.messageId,
            since: Date.now(),
            retriedOnce: true,
          });
        }
      },
      Math.max(remaining, 0),
    );
    return () => clearTimeout(timer);
    // `haltWithReason` is bound to this render's `agentId` (see its declaration above), and is
    // in this deps list specifically so an agentId switch cancels any pending timer here before
    // it can fire `haltWithReason` bound to the *old* agentId against the *new* agentId's state.
    // Do not drop `haltWithReason` from this list (e.g. via a lint suppression) without keeping
    // that guarantee some other way.
  }, [autoDrainState, isAgentRunning, isCancellingAgent, haltWithReason]);

  // Dispatch effect: only responsible for kicking off a new send. Connection/behavior/permission
  // gating is centralized here; cancellation mid-send/mid-wait is handled by the watcher effect
  // above.
  //
  // Double-dispatch is prevented by the `phase !== "idle"` guard above combined with the
  // synchronous `setAutoDrainState` call below, not by any ref-based lock. That guarantee breaks
  // if React StrictMode's double-invocation of effects is ever enabled here; if it is, an
  // in-flight ref guard needs to be added alongside this guard.
  useEffect(() => {
    if (autoDrainState.phase !== "idle") return;

    if (activeSendBehavior !== "queue") return;
    if (!isConnected) return;
    if (isAgentRunning) return;

    const next = pickNextQueuedMessage(queuedMessages);
    if (!next) return;

    // Cancelling an in-progress turn does not, by itself, stop the queue: auto-drain only halts
    // once it has something of its own in flight (dispatching a send or awaiting the turn to
    // become active). A cancellation that lands while the queue is empty is a no-op here --
    // there's nothing in flight to cancel yet.
    if (isCancellingAgent) {
      setAutoDrainState(haltWithReason({ code: "cancelled" }));
      return;
    }

    // Captured at dispatch time: only a `.then`/`.catch` handler that still matches
    // `dispatchSeqRef.current` when it runs is allowed to touch `autoDrainState` or
    // `agentMemoryRef` for `agentId` -- see `dispatchSeqRef`'s declaration above for why this
    // replaces comparing against the resolved `prev` state.
    const seq = (dispatchSeqRef.current += 1);
    setAutoDrainState({ phase: "dispatching", messageId: next.id, since: Date.now() });
    sendQueuedComposerMessageNow({
      agentId,
      messageId: next.id,
      queue,
      submitMessage,
      failedToSendMessage,
    })
      .then((result) => {
        if (seq !== dispatchSeqRef.current) {
          console.warn("[auto-drain] discarding stale result", { messageId: next.id, result });
          return;
        }
        const memory = getAgentMemory(agentId);
        if (result.status === "missing") {
          // A missing queue item is not necessarily a real problem: it also happens on the
          // legitimate path where the user hits "send now" or edits the queued item just before
          // this dispatch runs. Drop back to idle so the next render picks the freshest queued
          // item, but escalate to a halt if the *same* messageId comes up missing twice in a
          // row for *this agent* -- that's a sign the queue snapshot this hook is reading has
          // diverged from the underlying store's state (rather than a one-off race). Keyed
          // per-agent (via `memory`, not a hook-wide ref) so a streak started on one agent can't
          // be silently reset by switching to another agent and back, or by resuming a different
          // agent's halt.
          if (memory.lastMissingMessageId === next.id) {
            memory.lastMissingMessageId = undefined;
            setAutoDrainState(haltWithReason({ code: "queue-item-missing" }));
            return;
          }
          console.warn("[auto-drain] queue item missing, retrying", { messageId: next.id });
          memory.lastMissingMessageId = next.id;
          setAutoDrainState({ phase: "idle" });
          return;
        }
        // Any non-missing outcome means this messageId is no longer at risk of a spurious
        // second "missing" hit, so the streak tracker is cleared.
        memory.lastMissingMessageId = undefined;
        if (result.status === "failed") {
          setAutoDrainState(haltWithReason({ code: "send-failed", message: result.errorMessage }));
          return;
        }
        if (result.status === "submitted") {
          agentMemoryRef.current.delete(agentId);
          setAutoDrainState({
            phase: "awaitingTurnActive",
            messageId: next.id,
            since: Date.now(),
            retriedOnce: false,
          });
          return;
        }
        // Exhaustiveness check: if `SendQueuedComposerMessageNowResult` grows a new status, this
        // fails to compile instead of silently falling through to the "submitted" branch above.
        const _exhaustive: never = result;
        setAutoDrainState(
          haltWithReason({
            code: "unexpected-error",
            message: `unknown send result: ${JSON.stringify(result)}`,
          }),
        );
        return undefined;
      })
      .catch((error) => {
        if (seq !== dispatchSeqRef.current) {
          console.warn("[auto-drain] discarding stale error", { messageId: next.id, error });
          return;
        }
        getAgentMemory(agentId).lastMissingMessageId = undefined;
        console.error("[Composer] Auto-drain send failed, message may be lost", {
          messageId: next.id,
          text: next.text,
          error,
        });
        setAutoDrainState(haltWithReason({ code: "unexpected-error", message: String(error) }));
      });
  }, [
    autoDrainState.phase,
    isAgentRunning,
    queuedMessages,
    activeSendBehavior,
    isCancellingAgent,
    isConnected,
    agentId,
    queue,
    submitMessage,
    failedToSendMessage,
    haltWithReason,
    getAgentMemory,
  ]);

  const resumeAutoDrain = useCallback(() => {
    // Invalidate any dispatch that was in flight before the halt this resumes from (relevant if
    // a halt was reached via the watcher effect's timeout/cancellation paths rather than by a
    // dispatch's own `.then`/`.catch` -- in those cases the original dispatch's promise may still
    // be pending).
    dispatchSeqRef.current += 1;
    agentMemoryRef.current.delete(agentId);
    setAutoDrainState({ phase: "idle" });
  }, [agentId]);

  return {
    autoDrainState,
    resumeAutoDrain,
  };
}
