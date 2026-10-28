/**
 * 共有プロジェクト画面から Topos を呼ぶ入口。許可リストの汎用 RPC(`topos.projects.api`)を1本使い、
 * 失敗は例外にせず理由の種類つきで返す(画面が文言を出し分ける)。
 */
import { useCallback } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  failureText,
  sharedProjectApiRpc,
  type ApiOp,
  type SharedProjectApiInput,
} from "../../shared/shared-projects-api.js";

export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string; message: string; httpStatus?: number };

export type CallApi = (op: ApiOp, params?: Omit<SharedProjectApiInput, "op">) => Promise<ApiResult>;

/** 接続の問題(設定なし・繋がらない)はサーバーの文言、それ以外は理由の種類から作った文言。 */
const SERVER_MESSAGE_REASONS = new Set(["unconfigured", "config", "network"]);

export function useApi(): CallApi {
  const rpc = useRpc(sharedProjectApiRpc);
  return useCallback(
    async (op, params) => {
      try {
        const r = await rpc({ op, ...params });
        if (r.ok) return { ok: true, data: r.data };
        const reason = r.reason ?? "network";
        return {
          ok: false,
          reason,
          message:
            SERVER_MESSAGE_REASONS.has(reason) && r.message
              ? r.message
              : failureText(reason, r.detail ?? ""),
          ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
        };
      } catch (e) {
        return {
          ok: false,
          reason: "network",
          message: e instanceof Error ? e.message : "Topos に繋がりません",
        };
      }
    },
    [rpc],
  );
}

// ── 一覧の再取得の合図(作成・名前変更・アーカイブ・並べ替え・既読の後にサイドバーを更新する) ──

const listeners = new Set<() => void>();

export function onProjectsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitProjectsChanged(): void {
  for (const fn of listeners) fn();
}
