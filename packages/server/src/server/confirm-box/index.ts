import type express from "express";
import type pino from "pino";

import type { ConfirmBoxThreadGateway } from "./chat.js";
import { registerConfirmBoxRoutes } from "./routes.js";
import { ConfirmBoxService, type ConfirmBoxPushSender } from "./service.js";
import { ConfirmBoxStore, resolveConfirmBoxDir } from "./store.js";

export type { ConfirmBoxPushSender, ConfirmBoxThreadGateway };

/**
 * 確認箱をデーモンへ組み込む唯一の入口(bootstrap.ts からはこれだけ呼ぶ)。
 * TOPOS_CONFIRM_BOX=0 で丸ごと無効化できる。
 */
export function setupConfirmBox(options: {
  app: express.Express;
  logger: pino.Logger;
  version: string;
  getPushSender: () => ConfirmBoxPushSender | undefined;
  /** 元スレを開くリンク(`/h/<serverId>/agent/<id>`)に要る。 */
  getServerId?: () => string;
  /** チャット欄(A案)の送信と返答取り込み。bootstrap.ts が
   * `sendPromptToAgent()` と `AgentManager` を包んで渡す(どちらも setupConfirmBox より
   * 後に生成されるため遅延getter)。 */
  getThreadGateway?: () => ConfirmBoxThreadGateway | undefined;
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
    getServerId: options.getServerId,
    getThreadGateway: options.getThreadGateway,
  });
  return { start: () => service.start(), stop: () => service.stop() };
}
