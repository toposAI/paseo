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
  /** 完了まとめの確認状態(箱の state)。表示用(既読=read を含む)。 */
  summaryState: z.string().nullable(),
  /**
   * 完了まとめを**個別に** ack 済みか(`t:"ack"` イベントがあるか)。`ackall`(すべて既読)では真にならない。
   * アーカイブ条件(`child_thread_registry._directly_acked_ids`)と同じ定義。確認済みの判定はこちらを使う。
   */
  summaryAcked: z.boolean().default(false),
  updatedAt: z.number(),
  /** 親(子司令塔)のagent id。親が無い/不明は null(「その他」グループ)。 */
  parentAgentId: z.string().nullable().default(null),
  /** 親の題名(グループ見出し用)。 */
  parentTitle: z.string().nullable().default(null),
  /** ピン止め(そのグループの先頭に固定)。 */
  pinned: z.boolean().default(false),
  /**
   * 司令塔スレそのもの(登録簿ではなく起こしデーモンの `coordinator_id` から出した行)。
   * 一覧の先頭に「司令塔」グループとして並べる。
   */
  coordinator: z.boolean().default(false),
  /**
   * いま開けるか(`server/thread-liveness.ts` が判定)。null=不明(取得に失敗した)。
   * `workspace-archived` は行を押しても会話に着かない(Paseo がアーカイブ済みワークスペースの画面を出す)。
   */
  access: z.enum(["open", "workspace-archived", "thread-archived"]).nullable().default(null),
});
export type ChildThread = z.infer<typeof ChildThreadSchema>;

/** 開けるかの印。 */
export type ThreadAccess = NonNullable<ChildThread["access"]>;

/**
 * 開けない行を押したときに画面へ出す理由。開ける/不明なら null。
 * **クライアントから import するので shared に置く**(`server/` はプラグインのクライアント束へ入れられない)。
 */
export function blockedMessage(access: ChildThread["access"] | undefined): string | null {
  if (access === "workspace-archived")
    return "このスレのワークスペースはアーカイブ済みのため開けません(アプリでワークスペースのアーカイブを解除してください)";
  if (access === "thread-archived") return "このスレはアーカイブ済みです(開けません)";
  return null;
}

export const childThreadsListRpc = defineRpc({
  name: "topos.childthreads.list",
  input: z.object({}),
  output: z.object({
    threads: z.array(ChildThreadSchema),
    /** 読み出し先(画面に出す。どこを見ているか分かるように)。 */
    dir: z.string(),
    generatedAt: z.number(),
    /** 手動の並び順が保存されているか(「自動に戻す」を出す判断用)。 */
    orderIsManual: z.boolean().default(false),
    /** ピン止め(この箱ディレクトリの設定ファイルに保存)の読み出し失敗。画面には出さずログ用。 */
    pinReadError: z.string().nullish(),
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

/** 行のアーカイブ(スレ + そのスレのワークスペース)。 */
export const childThreadsArchiveRpc = defineRpc({
  name: "topos.childthreads.archive",
  input: z.object({ agentId: z.string().min(1).max(CHILD_THREAD_ID_LIMIT) }),
  output: z.object({
    ok: z.boolean(),
    /** 実行できなかった理由(画面に出す。無言で閉じない)。 */
    message: z.string().optional(),
  }),
});
export type ChildThreadsArchiveOutput = z.infer<typeof childThreadsArchiveRpc.output>;

/** ピン止めの切り替え。 */
export const childThreadsPinRpc = defineRpc({
  name: "topos.childthreads.pin",
  input: z.object({
    agentId: z.string().min(1).max(CHILD_THREAD_ID_LIMIT),
    pinned: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
    pins: z.array(z.string()),
    message: z.string().optional(),
  }),
});
export type ChildThreadsPinOutput = z.infer<typeof childThreadsPinRpc.output>;

export const STATUS_RANK: Record<ChildThreadStatus, number> = {
  ユーザー判断待ち: 0,
  実装中: 1,
  完了: 2,
};

/**
 * サイドバー行に固定(ピン止め)するスレの id。並び替えの保存と同じ理由で
 * `child_threads.json` には触らず、同じ箱ディレクトリの別ファイルに置く。
 */
export const CHILD_THREAD_PINS_FILE = "child_threads_pins.json";

/** 表示順: ユーザー判断待ち → 実装中 → 完了、同じ状態の中は更新の新しい順。 */
export function compareChildThreads(a: ChildThread, b: ChildThread): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt - a.updatedAt;
}

/**
 * 既定の並び: 子司令塔(親)ごとにまとめ、グループは「最も急ぐ状態 → 更新の新しい順」、
 * 親の無い「その他」は最後。グループ内は `compareChildThreads`。
 * 確認箱の優先順位台帳はプロジェクト単位でスレに紐づかないため使わない(推測で優先度を作らない)。
 */
export function sortChildThreadsGrouped(threads: readonly ChildThread[]): ChildThread[] {
  const groups = new Map<string, ChildThread[]>();
  for (const t of threads) {
    const key = t.parentAgentId ?? "";
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const meta = (g: ChildThread[]) => ({
    rank: Math.min(...g.map((t) => STATUS_RANK[t.status])),
    latest: Math.max(...g.map((t) => t.updatedAt)),
  });
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    if ((ka === "") !== (kb === "")) return ka === "" ? 1 : -1;
    const ma = meta(a);
    const mb = meta(b);
    return ma.rank - mb.rank || mb.latest - ma.latest;
  });
  return ordered.flatMap(([, g]) => [...g].sort(compareChildThreads));
}
