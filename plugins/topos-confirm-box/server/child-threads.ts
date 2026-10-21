/**
 * 子スレ一覧を読む(読み取り専用)。置き場は確認箱ディレクトリ直下の `child_threads.json`。
 * 壊れた/無いファイルは空配列(読み手は止まらない)。アーカイブ済みは出さない。
 * 完了まとめ本文は箱の項目(`summary_item_id` と item id が一致)から引く。
 */
import fs from "node:fs";
import path from "node:path";
import { CHILD_THREAD_STATUSES, compareChildThreads } from "../shared/child-threads.js";
import type { ChildThread, ChildThreadStatus } from "../shared/child-threads.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const CHILD_THREADS_FILE = "child_threads.json";

export function normalizeChildThreads(
  raw: unknown,
  boxItems: readonly Pick<ConfirmBoxItem, "id" | "background" | "state">[] = [],
): ChildThread[] {
  const list = raw && typeof raw === "object" ? (raw as { threads?: unknown }).threads : undefined;
  if (!Array.isArray(list)) return [];
  const byId = new Map(boxItems.map((i) => [i.id, i]));
  const out: ChildThread[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (o.archived === true) continue;
    const agentId = str(o.agent_id).slice(0, 200);
    if (!agentId) continue;
    const status = (CHILD_THREAD_STATUSES as readonly string[]).includes(o.status as string)
      ? (o.status as ChildThreadStatus)
      : "実装中";
    const summaryItemId = str(o.summary_item_id).slice(0, 64) || null;
    const item = summaryItemId ? byId.get(summaryItemId) : undefined;
    out.push({
      agentId,
      title: str(o.title).slice(0, 120) || agentId.slice(0, 8),
      status,
      machineState: str(o.machine_state).slice(0, 40) || null,
      request: str(o.request).slice(0, 300),
      summaryItemId,
      summary: item ? item.background : null,
      summaryState: item ? item.state : null,
      updatedAt: typeof o.updated_at === "number" ? o.updated_at : 0,
    });
  }
  return out.sort(compareChildThreads);
}

export function readChildThreads(
  dir: string,
  boxItems: readonly Pick<ConfirmBoxItem, "id" | "background" | "state">[] = [],
): ChildThread[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CHILD_THREADS_FILE), "utf8"));
    return normalizeChildThreads(raw, boxItems);
  } catch {
    return [];
  }
}
