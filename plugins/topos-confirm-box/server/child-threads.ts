/**
 * 子スレ一覧を読む。置き場は確認箱ディレクトリ直下の `child_threads.json`。
 * 壊れた/無いファイルは空配列(読み手は止まらない)。アーカイブ済みは出さない。
 * 完了まとめ本文は箱の項目(`summary_item_id` と item id が一致)から引く。
 *
 * 並び順は `child_threads_order.json`(加算ファイル)があればそれを優先し、
 * 無ければ既定順(`compareChildThreads`)。既存の `child_threads.json` は書き換えない。
 */
import fs from "node:fs";
import path from "node:path";
import {
  CHILD_THREAD_ID_LIMIT,
  CHILD_THREAD_ORDER_FILE,
  CHILD_THREAD_ORDER_LIMIT,
  CHILD_THREAD_STATUSES,
  sortChildThreadsGrouped,
} from "../shared/child-threads.js";
import type { ChildThread, ChildThreadStatus } from "../shared/child-threads.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { parseJsonl } from "./normalize.js";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const CHILD_THREADS_FILE = "child_threads.json";

export function normalizeChildThreads(
  raw: unknown,
  boxItems: readonly Pick<ConfirmBoxItem, "id" | "background" | "state">[] = [],
  /** 個別 ack 済みの item id(`t:"ack"` の行だけ。ackall は含めない)。 */
  ackedIds: ReadonlySet<string> = new Set(),
): ChildThread[] {
  const list = raw && typeof raw === "object" ? (raw as { threads?: unknown }).threads : undefined;
  if (!Array.isArray(list)) return [];
  const byId = new Map(boxItems.map((i) => [i.id, i]));
  const out = list
    .filter(
      (r): r is Record<string, unknown> => !!r && typeof r === "object" && r.archived !== true,
    )
    .flatMap((o) => {
      const agentId = str(o.agent_id).slice(0, 200);
      if (!agentId) return [];
      const status = (CHILD_THREAD_STATUSES as readonly string[]).includes(o.status as string)
        ? (o.status as ChildThreadStatus)
        : "実装中";
      const summaryItemId = str(o.summary_item_id).slice(0, 64) || null;
      const item = summaryItemId ? byId.get(summaryItemId) : undefined;
      return [
        {
          agentId,
          title: str(o.title).slice(0, 120) || agentId.slice(0, 8),
          status,
          machineState: str(o.machine_state).slice(0, 40) || null,
          request: str(o.request).slice(0, 300),
          summaryItemId,
          summary: item ? item.background : null,
          summaryState: item ? item.state : null,
          summaryAcked: summaryItemId !== null && ackedIds.has(summaryItemId),
          updatedAt: typeof o.updated_at === "number" ? o.updated_at : 0,
          parentAgentId: str(o.parent_agent_id).slice(0, 200) || null,
          parentTitle: str(o.parent_title).slice(0, 120) || null,
        },
      ];
    });
  // 子を持つ行(司令塔)はグループ見出しになるので行としては出さない(固定済みと二重に出ない)。
  const parents = new Set(out.map((t) => t.parentAgentId).filter((id) => id !== null));
  return sortChildThreadsGrouped(out.filter((t) => !parents.has(t.agentId)));
}

/**
 * 箱の `events-*.jsonl` から**個別** ack(`t:"ack"`)された item id だけを集める。
 * `ackall` は入れない(Python 側 `child_thread_registry._directly_acked_ids` と同じ判定)。
 * ファイルが読めなければ空集合(一覧は止まらない)。
 */
export function readDirectlyAckedIds(dir: string): Set<string> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^events-\d{6}\.jsonl$/.test(n));
  } catch {
    return ids;
  }
  for (const name of names) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const e of parseJsonl(text)) {
      if (e.t === "ack" && typeof e.id === "string" && e.id) ids.add(e.id);
    }
  }
  return ids;
}

export function readChildThreads(
  dir: string,
  boxItems: readonly Pick<ConfirmBoxItem, "id" | "background" | "state">[] = [],
  ackedIds: ReadonlySet<string> = readDirectlyAckedIds(dir),
): ChildThread[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CHILD_THREADS_FILE), "utf8"));
    return applyChildThreadOrder(
      normalizeChildThreads(raw, boxItems, ackedIds),
      readChildThreadOrder(dir),
    );
  } catch {
    return [];
  }
}

/**
 * 保存順を正規化する(文字列だけ・trim・空除外・重複除去・上限)。
 * 入力はクライアント由来なので、そのままファイルへ書かない。
 */
export function normalizeChildThreadOrder(input: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") continue;
    const agentId = value.trim().slice(0, CHILD_THREAD_ID_LIMIT);
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    out.push(agentId);
    if (out.length >= CHILD_THREAD_ORDER_LIMIT) break;
  }
  return out;
}

/** 保存済みの並び順。ファイルが無い/壊れている/形式違いは空(=既定順)。 */
export function readChildThreadOrder(dir: string): string[] {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, CHILD_THREAD_ORDER_FILE), "utf8"),
    );
    // 素の配列でも `{ order: [...] }` でも受ける(手で書いた場合の取りこぼしを減らす)。
    let order: unknown = raw;
    if (!Array.isArray(raw) && raw && typeof raw === "object") {
      order = (raw as { order?: unknown }).order;
    }
    return Array.isArray(order) ? normalizeChildThreadOrder(order) : [];
  } catch {
    return [];
  }
}

/**
 * 保存順を一覧へ適用する。保存に無いID(新規スレ)は既定順のまま後ろに置くので、
 * 既存の並びを壊さず、次に誰かが並べ替えるまで位置が安定する。
 */
export function applyChildThreadOrder(
  threads: readonly ChildThread[],
  order: readonly string[],
): ChildThread[] {
  if (order.length === 0) return [...threads];
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (!rank.has(id)) rank.set(id, i);
  }
  const placed: ChildThread[] = [];
  const rest: ChildThread[] = [];
  for (const thread of threads) {
    if (rank.has(thread.agentId)) placed.push(thread);
    else rest.push(thread);
  }
  placed.sort((a, b) => (rank.get(a.agentId) ?? 0) - (rank.get(b.agentId) ?? 0));
  return [...placed, ...rest];
}

/** 並び順を保存する(原子的に置換。既存の `child_threads.json` には触らない)。 */
export function writeChildThreadOrder(dir: string, input: readonly unknown[]): string[] {
  const order = normalizeChildThreadOrder(input);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, CHILD_THREAD_ORDER_FILE);
  const tmp = path.join(dir, `.${CHILD_THREAD_ORDER_FILE}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ version: 1, updated_at: Date.now(), order }, null, 2);
  try {
    fs.writeFileSync(tmp, `${body}\n`, "utf8");
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 後始末の失敗で元のエラーを隠さない
    }
    throw error;
  }
  return order;
}
