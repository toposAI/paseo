import type express from "express";
import type pino from "pino";

import { registerConfirmBoxRoutes } from "./routes.js";
import { ConfirmBoxService, type ConfirmBoxPushSender } from "./service.js";
import { ConfirmBoxStore, resolveConfirmBoxDir } from "./store.js";

export type { ConfirmBoxPushSender };

/**
 * 確認箱をデーモンへ組み込む唯一の入口(bootstrap.ts からはこれだけ呼ぶ)。
 * TOPOS_CONFIRM_BOX=0 で丸ごと無効化できる。
 */
export function setupConfirmBox(options: {
  app: express.Express;
  logger: pino.Logger;
  version: string;
  getPushSender: () => ConfirmBoxPushSender | undefined;
}): { start(): void; stop(): void } {
  // テスト中のデーモン起動が本番の確認箱ディレクトリへheartbeatを書かないよう、
  // vitest実行時は TOPOS_CONFIRM_BOX_DIR の明示が無ければ無効化する。
  const underTestWithoutDir = Boolean(process.env.VITEST) && !process.env.TOPOS_CONFIRM_BOX_DIR;
  if (process.env.TOPOS_CONFIRM_BOX === "0" || underTestWithoutDir) {
    return { start() {}, stop() {} };
  }
  const store = new ConfirmBoxStore(resolveConfirmBoxDir());
  store.refresh();
  const service = new ConfirmBoxService({
    store,
    logger: options.logger,
    version: options.version,
    getPushSender: options.getPushSender,
  });
  registerConfirmBoxRoutes({
    app: options.app,
    store,
    getHeartbeatAgeMs: () => service.heartbeatAgeMs(),
  });
  return { start: () => service.start(), stop: () => service.stop() };
}
