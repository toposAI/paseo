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
  CHILD_THREAD_PINS_FILE,
  CHILD_THREAD_STATUSES,
  STANDBY_THREAD_STATUS,
  isNocardSummaryId,
  sortChildThreadsGrouped,
} from "../shared/child-threads.js";
import type { ChildThread, ChildThreadStatus } from "../shared/child-threads.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { parseJsonl } from "./normalize.js";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 台帳の status を行の語彙へ寄せる。常駐の窓口が書く `待機` は `待機中` にする(2026-10-26)。
 * ここを素通しすると schema の enum で落ちるか、既定の「実装中」に化けて一覧が動き続けて見える。
 */
function toThreadStatus(value: unknown): ChildThread["status"] {
  const text = str(value);
  if (text === STANDBY_THREAD_STATUS) return "待機中";
  if ((CHILD_THREAD_STATUSES as readonly string[]).includes(text)) return text as ChildThreadStatus;
  return "実装中";
}

export const CHILD_THREADS_FILE = "child_threads.json";

export function normalizeChildThreads(
  raw: unknown,
  boxItems: readonly Pick<ConfirmBoxItem, "id" | "background" | "state">[] = [],
  /** 個別 ack 済みの item id(`t:"ack"` の行だけ。ackall は含めない)。 */
  ackedIds: ReadonlySet<string> = new Set(),
  /** ピン止め済みの agent id(未指定は全部ピン無し)。 */
  pinnedIds: ReadonlySet<string> = new Set(),
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
      const status = toThreadStatus(o.status);
      const rawSummaryItemId = str(o.summary_item_id).slice(0, 64);
      // 目印 `nocard:<key>` は箱に実在しない id。`summaryItemId` に載せると、箱を引けない行が
      // 「確認待ち」として出て件数まで水増しされる(2026-10-26)。印だけ別に立てて null にする。
      const nocard = isNocardSummaryId(rawSummaryItemId);
      const summaryItemId = nocard ? null : rawSummaryItemId || null;
      const item = summaryItemId ? byId.get(summaryItemId) : undefined;
      return [
        {
          agentId,
          title: str(o.title).slice(0, 120) || agentId.slice(0, 8),
          status,
          machineState: str(o.machine_state).slice(0, 40) || null,
          request: str(o.request).slice(0, 300),
          summaryItemId,
          nocard,
          summary: item ? item.background : null,
          summaryState: item ? item.state : null,
          summaryAcked: summaryItemId !== null && ackedIds.has(summaryItemId),
          updatedAt: typeof o.updated_at === "number" ? o.updated_at : 0,
          parentAgentId: str(o.parent_agent_id).slice(0, 200) || null,
          parentTitle: str(o.parent_title).slice(0, 120) || null,
          pinned: pinnedIds.has(agentId),
          // 登録簿の行は子スレ。司令塔そのものの行は `coordinator-threads.ts` が作る。
          coordinator: false,
          parentOpenable: false,
          groupingParent: false,
          // 開けるかは Paseo に聞いてから付ける(`thread-liveness.ts`)。ここでは未判定。
          access: null,
        },
      ];
    });
  // 子を持つ行(子司令塔)はグループ見出しになる。行としては消さず、`groupingParent` の印を付けて
  // 残す(2026-10-27、通し検証B 指摘1)。消すと `mergeUnregisteredThreads` が「行に無い=未登録」と
  // 読んで機械状態だけの行を足し、登録簿の状態(判断待ち等)がチップから消える(二重表示の原因)。
  // 画面は印の行を子の見出しとして出し、未完の行(ノートの無いスレ)は子の行の後ろに置く。
  const parents = new Set(out.map((t) => t.parentAgentId).filter((id) => id !== null));
  const marked = out.map((t) => {
    if (!parents.has(t.agentId)) return t;
    // 親(子司令塔)は捨てずに印だけ付ける(見出しとして1行だけ出す)。
    return Object.assign({}, t, { groupingParent: true });
  });
  const rows = sortChildThreadsGrouped(marked.filter((t) => !t.groupingParent));
  // ピン止めした行は先頭に集める(出現順のまま。画面では「ピン止め」グループとして司令塔の外に出る)。
  // 残りは親(グループ)単位の出現順を保つ。クライアントの挿入処理(`pinFirstGrouped`)と同義。
  const pinned = rows.filter((t) => t.pinned);
  const rest = rows.filter((t) => !t.pinned);
  const byParent = new Map<string, ChildThread[]>();
  for (const t of rest) {
    const key = t.parentAgentId ?? "";
    const g = byParent.get(key);
    if (g) g.push(t);
    else byParent.set(key, [t]);
  }
  // 見出しになる親は、未完の行(ノートの無いスレとして上段に残るもの)だけ後ろへ置く。
  // 完了・アーカイブ側へ進んだ親は上段に出ない(見出しは子の行が担う)ので、並びに足さない。
  // ピン止めした親は見出しにせず普通の行として残す(見出しから外すと一覧から消える。
  // 出口レビュー round1 R1-6)。
  const headings = marked.filter(
    (t) => t.groupingParent && !t.coordinator && (t.pinned || t.status !== "完了"),
  );
  return [...pinned, ...[...byParent.values()].flat(), ...headings];
}

/** ピン止めの保存(壊れた/無いファイルは空)。 */
export function readChildThreadPins(dir: string): string[] {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, CHILD_THREAD_PINS_FILE), "utf8"),
    );
    const pins = Array.isArray(raw) ? raw : (raw as { pins?: unknown } | null)?.pins;
    return Array.isArray(pins) ? normalizeChildThreadOrder(pins) : [];
  } catch {
    return [];
  }
}

/** ピン止めを1件だけ切り替えた後の一覧を返す(保存は原子的に置換)。 */
export function writeChildThreadPin(dir: string, agentId: string, pinned: boolean): string[] {
  const id = normalizeChildThreadOrder([agentId])[0];
  if (!id) throw new Error("agentId が空です");
  const current = readChildThreadPins(dir);
  // 既にあるピンの位置は動かさない(押し直しても並びが跳ねない)
  let next: string[];
  if (!pinned) next = current.filter((x) => x !== id);
  else if (current.includes(id)) next = current;
  else next = [...current, id];
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, CHILD_THREAD_PINS_FILE);
  const tmp = path.join(dir, `.${CHILD_THREAD_PINS_FILE}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ version: 1, updated_at: Date.now(), pins: next }, null, 2);
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
  return next;
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
  pinnedIds: ReadonlySet<string> = new Set(readChildThreadPins(dir)),
): ChildThread[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CHILD_THREADS_FILE), "utf8"));
    return applyChildThreadOrder(
      normalizeChildThreads(raw, boxItems, ackedIds, pinnedIds),
      readChildThreadOrder(dir),
    );
  } catch {
    return [];
  }
}

/**
 * 登録簿で畳み済み(`archived: true`)の agent id。
 *
 * なぜ要るか(2026-10-27 通し検証B 指摘4): `normalizeChildThreads` は畳んだ行を一覧から外すので、
 * agent のアーカイブに失敗して Paseo 側に残った1本は「新しい未登録スレ」として復活していた。
 * 未登録の取り込みからこの集合を外す(登録簿側は `sync` の `retry_listed_archives` が畳み直す)。
 * 読めなければ空(取り込みを止めない=消す側に倒さない)。
 */
export function readArchivedChildThreadIds(dir: string): Set<string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, CHILD_THREADS_FILE), "utf8"));
    const list =
      raw && typeof raw === "object" ? (raw as { threads?: unknown }).threads : undefined;
    if (!Array.isArray(list)) return new Set();
    const ids = new Set<string>();
    for (const r of list) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const id = str(o.agent_id).slice(0, 200);
      if (o.archived === true && id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/** ピン止めの保存が読めなかったときの理由(存在しないだけなら null)。一覧を止めずに記録だけ返す。 */
export function childThreadPinsReadError(dir: string): string | null {
  const file = path.join(dir, CHILD_THREAD_PINS_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
    return null;
  } catch (error) {
    return `ピン止めを読めません: ${(error as Error).message}`;
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
