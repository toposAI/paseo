import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";

/**
 * Agent-to-agent messages that arrive while the target is mid-turn wait here and are delivered at
 * the turn boundary, instead of interrupting the turn (Topos 2026-11-01). Human input and explicit
 * `interrupt` sends never pass through this queue.
 */
const MAX_QUEUED_PER_AGENT = 50;
const RECHECK_INTERVAL_MS = 3000;

interface QueuedMessage {
  sourceAgentId: string | undefined;
  enqueuedAt: number;
  deliver: () => Promise<void>;
}

type QueueManager = Pick<AgentManager, "subscribe" | "hasBlockingRun" | "getAgent">;

export class AgentMessageQueue {
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly draining = new Set<string>();
  private readonly recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly manager: QueueManager,
    private readonly logger: Logger,
  ) {}

  enqueue(agentId: string, message: Omit<QueuedMessage, "enqueuedAt">): number {
    const queue = this.queues.get(agentId) ?? [];
    if (queue.length >= MAX_QUEUED_PER_AGENT) {
      throw new Error(
        `Too many queued messages for agent ${agentId} (max ${MAX_QUEUED_PER_AGENT})`,
      );
    }
    queue.push({ ...message, enqueuedAt: Date.now() });
    this.queues.set(agentId, queue);
    this.ensureSubscribed();
    this.logger.info(
      { agentId, sourceAgentId: message.sourceAgentId, depth: queue.length },
      "agent.message_queue.enqueued",
    );
    // The turn may have ended between the caller's busy check and now.
    void this.drain(agentId);
    return queue.length;
  }

  depth(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  private ensureSubscribed(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.manager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const agentId = event.agent.id;
        if (this.queues.has(agentId)) void this.drain(agentId);
      },
      { replayState: false, includeInternal: true },
    );
  }

  /** Safety net: if a run is cleared without a further agent_state event, still deliver. */
  private scheduleRecheck(agentId: string): void {
    if (this.recheckTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.recheckTimers.delete(agentId);
      if (this.queues.has(agentId)) void this.drain(agentId);
    }, RECHECK_INTERVAL_MS);
    timer.unref?.();
    this.recheckTimers.set(agentId, timer);
  }

  private async drain(agentId: string): Promise<void> {
    if (this.draining.has(agentId)) return;
    this.draining.add(agentId);
    try {
      // Hand over the head only; delivering it starts a turn, and the next waits for that turn's end.
      for (;;) {
        const queue = this.queues.get(agentId);
        if (!queue || queue.length === 0 || this.manager.hasBlockingRun(agentId)) break;
        const head = queue.shift()!;
        try {
          await head.deliver();
          this.logger.info(
            {
              agentId,
              sourceAgentId: head.sourceAgentId,
              waitedMs: Date.now() - head.enqueuedAt,
              remaining: queue.length,
            },
            "agent.message_queue.delivered",
          );
        } catch (error) {
          if (this.manager.hasBlockingRun(agentId)) {
            // Lost a race with another turn start: keep the message and wait for the next boundary.
            queue.unshift(head);
            break;
          }
          this.logger.error(
            { err: error, agentId, sourceAgentId: head.sourceAgentId },
            "agent.message_queue.deliver_failed",
          );
        }
      }
      const rest = this.queues.get(agentId);
      if (rest && rest.length === 0) this.queues.delete(agentId);
      else if (rest) this.scheduleRecheck(agentId);
    } finally {
      this.draining.delete(agentId);
    }
  }
}

const queuesByManager = new WeakMap<object, AgentMessageQueue>();

export function getAgentMessageQueue(manager: QueueManager, logger: Logger): AgentMessageQueue {
  let queue = queuesByManager.get(manager);
  if (!queue) {
    queue = new AgentMessageQueue(manager, logger);
    queuesByManager.set(manager, queue);
  }
  return queue;
}
