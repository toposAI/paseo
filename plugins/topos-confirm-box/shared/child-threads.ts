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
  summaryState: z.string().nullable(),
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

/**
 * 手動で並べ替えた順序の保存。**既存の `child_threads.json` には触らず**、
 * 同じ箱ディレクトリの別ファイル(`child_threads_order.json`)に置く。
 * 書き手(Python のレジストリ)と読み手(Node)が別プロセスで、`child_threads.json` は
 * Python 側が排他ロック付きで更新するため、同じファイルに書き込むと更新を失わせる恐れがある。
 * 保存が無ければ一覧は従来どおり `compareChildThreads` の既定順。
 */
export const CHILD_THREAD_ORDER_FILE = "child_threads_order.json";
/** 保存する順序の上限(壊れた/巨大な入力でファイルを膨らませない)。 */
export const CHILD_THREAD_ORDER_LIMIT = 2000;
/** 1件のIDの上限(`child_threads.json` 側の切り詰めと同じ)。 */
export const CHILD_THREAD_ID_LIMIT = 200;

export const childThreadsSetOrderRpc = defineRpc({
  name: "topos.childthreads.set-order",
  input: z.object({
    /** 画面上の上から順。表示中の全件を渡す(未知のIDは保存時に落とさない)。 */
    order: z.array(z.string().max(CHILD_THREAD_ID_LIMIT)).max(CHILD_THREAD_ORDER_LIMIT),
  }),
  output: z.object({
    ok: z.boolean(),
    /** 実際に保存した(正規化後の)順序。 */
    order: z.array(z.string()),
    message: z.string().optional(),
  }),
});
export type ChildThreadsSetOrderOutput = z.infer<typeof childThreadsSetOrderRpc.output>;

export const STATUS_RANK: Record<ChildThreadStatus, number> = {
  ユーザー判断待ち: 0,
  実装中: 1,
  完了: 2,
};

/** 表示順: ユーザー判断待ち → 実装中 → 完了、同じ状態の中は更新の新しい順。 */
export function compareChildThreads(a: ChildThread, b: ChildThread): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt - a.updatedAt;
}
