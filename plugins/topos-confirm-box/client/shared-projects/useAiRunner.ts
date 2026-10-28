/**
 * AI生成(Paseo側)の実行役。Topos の応答に `ai_pending` が付いたとき、サーバーのジョブ(aiStart)を始め、
 * 2秒間隔で結果(aiPoll)を待つ。プロジェクトを切り替えたり画面を閉じたら待つのをやめ、古い結果は採用しない
 * (生成と保存はサーバー側で最後まで進むので、戻ったときはスレッドの取り直しで見える)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  aiFailureText,
  sharedProjectAiPollRpc,
  sharedProjectAiStartRpc,
  type AiKind,
  type AiPending,
  type AiStartInput,
} from "../../shared/shared-projects-api.js";

export const AI_POLL_MS = 2_000;
/** 待つ上限(サーバーの生成上限120秒+保存の余裕)。 */
export const AI_WAIT_MAX_MS = 150_000;

export type AiExtra = Pick<AiStartInput, "question" | "since_seq" | "chat">;

export type AiRunResult =
  /** 画面が切り替わった・閉じた・同じ処理がすでに走っている。何もしない。 */
  | { ok: false; stale: true }
  | { ok: true; stale?: false; kind: AiKind; result: unknown }
  | {
      ok: false;
      stale?: false;
      kind: AiKind;
      reason: string;
      /** 画面に出す日本語(すでにAIが処理済みのときは空=黙ってスレッドを取り直す)。 */
      message: string;
      retryAfter?: number;
    };

const STALE: AiRunResult = { ok: false, stale: true };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Waited =
  | { state: "stale" }
  | { state: "done"; result: unknown }
  | { state: "failed"; reason: string; error: string; retryAfter?: number };

/** 2秒おきに結果を見に行く。上限(150秒)を超えたら timeout 扱い。古くなったら(stale)すぐやめる。 */
async function waitForJob(
  poll: (input: { jobId: string }) => Promise<{
    status: "running" | "done" | "failed";
    result?: unknown;
    error?: string;
    reason?: string;
    retryAfter?: number;
  }>,
  jobId: string,
  isStale: () => boolean,
): Promise<Waited> {
  const deadline = Date.now() + AI_WAIT_MAX_MS;
  for (;;) {
    await sleep(AI_POLL_MS);
    if (isStale()) return { state: "stale" };
    const r = await poll({ jobId });
    if (isStale()) return { state: "stale" };
    if (r.status === "done") return { state: "done", result: r.result };
    if (r.status === "failed")
      return {
        state: "failed",
        reason: r.reason ?? "server",
        error: r.error ?? "",
        ...(r.retryAfter !== undefined ? { retryAfter: r.retryAfter } : {}),
      };
    if (Date.now() > deadline) return { state: "failed", reason: "timeout", error: "" };
  }
}

export interface AiRunner {
  /** 1件以上のAI生成を待っている間 true(「AIが考え中…」の表示用)。 */
  thinking: boolean;
  run: (pending: AiPending, extra?: AiExtra) => Promise<AiRunResult>;
}

export function useAiRunner(projectId: string): AiRunner {
  const start = useRpc(sharedProjectAiStartRpc);
  const poll = useRpc(sharedProjectAiPollRpc);
  const gen = useRef(0);
  const active = useRef(new Set<string>());
  const [count, setCount] = useState(0);

  // プロジェクトが変わる/画面が閉じる: 待っている処理を古い扱いにする
  useEffect(() => {
    gen.current += 1;
    active.current.clear();
    setCount(0);
    return () => {
      gen.current += 1;
    };
  }, [projectId]);

  const run = useCallback(
    async (pending: AiPending, extra?: AiExtra): Promise<AiRunResult> => {
      const kind = pending.kind;
      const key = `${kind}:${pending.seq ?? 0}`;
      if (active.current.has(key)) return STALE; // 二重起動しない
      const my = gen.current;
      active.current.add(key);
      setCount((c) => c + 1);
      const fail = (reason: string, message: string, retryAfter?: number): AiRunResult => ({
        ok: false,
        kind,
        reason,
        message: aiFailureText(kind, reason, message, retryAfter),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      });
      try {
        const started = await start({
          id: projectId,
          kind,
          ...(pending.seq !== undefined ? { seq: pending.seq } : {}),
          ...extra,
        });
        if (my !== gen.current) return STALE;
        if (!started.ok || !started.jobId)
          return fail(started.reason ?? "server", started.message ?? "", started.retryAfter);
        const waited = await waitForJob(poll, started.jobId, () => my !== gen.current);
        if (waited.state === "stale") return STALE;
        if (waited.state === "done") return { ok: true, kind, result: waited.result };
        return fail(waited.reason, waited.error, waited.retryAfter);
      } catch (e) {
        if (my !== gen.current) return STALE;
        return fail("network", e instanceof Error ? e.message : "");
      } finally {
        if (my === gen.current) {
          active.current.delete(key);
          setCount((c) => Math.max(0, c - 1));
        }
      }
    },
    [start, poll, projectId],
  );

  const thinking = count > 0;
  return useMemo(() => ({ thinking, run }), [thinking, run]);
}
