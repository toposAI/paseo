import type pino from "pino";

import { decidePush, DEFAULT_PUSH_POLICY, type PushPolicyConfig } from "./push-policy.js";
import { ConfirmBoxStore } from "./store.js";

export interface ConfirmBoxPushSender {
  send(payload: { title: string; body: string; data?: Record<string, unknown> }): Promise<void>;
}

export interface ConfirmBoxServiceOptions {
  store: ConfirmBoxStore;
  logger: pino.Logger;
  version: string;
  /** wsServer 生成後に解決されるため遅延取得。未解決(undefined)の間はpushしない。 */
  getPushSender: () => ConfirmBoxPushSender | undefined;
  scanIntervalMs?: number;
  policy?: PushPolicyConfig;
  now?: () => number;
}

/**
 * 約15秒毎に: ディスクの追記(Python watchdog群の投函)を取り込み → 緊急をpush →
 * heartbeat.json を更新する。heartbeat は Python 側の日次死活検査(confirm_box_liveness_watchdog)が読む。
 */
export class ConfirmBoxService {
  private timer: NodeJS.Timeout | null = null;
  private readonly pushTimes: number[] = [];
  private lastPushAt: number | null = null;
  private lastScanAt = 0;
  private lastHeartbeatAt: number | null = null;
  private readonly logger: pino.Logger;
  private readonly now: () => number;

  constructor(private readonly options: ConfirmBoxServiceOptions) {
    this.logger = options.logger.child({ component: "confirm-box" });
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.scanIntervalMs ?? 15_000);
    this.timer.unref();
  }

  heartbeatAgeMs(): number | null {
    return this.lastHeartbeatAt === null ? null : this.now() - this.lastHeartbeatAt;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const { store } = this.options;
    try {
      store.refresh();
      const now = this.now();
      this.lastScanAt = now;
      const sender = this.options.getPushSender();
      if (sender) {
        const decision = decidePush({
          items: store.allItems(),
          now,
          pushTimes: this.pushTimes,
          config: this.options.policy ?? DEFAULT_PUSH_POLICY,
        });
        if (decision) {
          // 送信失敗でも二重送信ループを避けるため、先にpush済みとして記録する。
          store.markPushed(decision.ids);
          this.pushTimes.push(now);
          this.lastPushAt = now;
          await sender.send(decision.payload).catch((err) => {
            this.logger.warn({ err }, "confirm-box push failed");
          });
        }
      }
      const unpushedUrgent = store
        .allItems()
        .filter((i) => i.urgency === "urgent" && i.state === "new" && i.pushedAt === null).length;
      store.writeHeartbeat({
        ts: this.now(),
        pid: process.pid,
        version: this.options.version,
        lastScanAt: this.lastScanAt,
        lastPushAt: this.lastPushAt,
        unpushedUrgent,
      });
      this.lastHeartbeatAt = this.now();
    } catch (err) {
      this.logger.warn({ err }, "confirm-box tick failed");
    }
  }
}
