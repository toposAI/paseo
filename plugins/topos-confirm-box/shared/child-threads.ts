/**
 * 子スレ一覧の RPC 契約と並び順。確認箱本体(`contract.ts`)と同じプラグインに同居させ、
 * **同じ箱ディレクトリの `child_threads.json`** を読む(書き手は
 * `antigravity/utils/child_thread_registry.py`)。完了まとめは箱の項目(`summaryItemId` =
 * 箱の item id)なので、確認箱の画面と同じデータを指す。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const CHILD_THREAD_STATUSES = ["実装中", "ユーザー判断待ち", "完了"] as const;
export type ChildThreadStatus = (typeof CHILD_THREAD_STATUSES)[number];

export const ChildThreadSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  status: z.enum(CHILD_THREAD_STATUSES),
  /** Paseo の機械状態(busy/idle/承認待ち)。意味のある状態(status)とは混ぜない。 */
  machineState: z.string().nullable(),
  request: z.string(),
  /** 完了まとめを投函した確認箱 item の id。未完了なら null。 */
  summaryItemId: z.string().nullable(),
  /** 完了まとめの本文(箱の item の background)。箱から引けなければ null。 */
  summary: z.string().nullable(),
  /** 完了まとめの確認状態(箱の state)。確認済み=read/approved。 */
  summaryState: z.enum(["new", "read", "approved"]).nullable(),
  updatedAt: z.number(),
});
export type ChildThread = z.infer<typeof ChildThreadSchema>;

export const childThreadsListRpc = defineRpc({
  name: "topos.childthreads.list",
  input: z.object({}),
  output: z.object({
    threads: z.array(ChildThreadSchema),
    /** 読み出し先(画面に出す。どこを見ているか分かるように)。 */
    dir: z.string(),
    generatedAt: z.number(),
  }),
});
export type ChildThreadsListOutput = z.infer<typeof childThreadsListRpc.output>;

export const STATUS_RANK: Record<ChildThreadStatus, number> = {
  ユーザー判断待ち: 0,
  実装中: 1,
  完了: 2,
};

/** 表示順: ユーザー判断待ち → 実装中 → 完了、同じ状態の中は更新の新しい順。 */
export function compareChildThreads(a: ChildThread, b: ChildThread): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt - a.updatedAt;
}
