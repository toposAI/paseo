/**
 * Topos 側の確認箱を読む(読み取り専用)。ディスク上のデータ契約は
 * `packages/server/src/server/confirm-box/store.ts` と `antigravity/utils/notify_box.py`
 * が共有している。ここはその**読み手の写し**。
 *
 * 読むファイルは2つあり、役割が違う:
 *
 * 1. `events-YYYYMM.jsonl` … **箱の正本**。`{"t":"item"|"ack"|"ackall"|"push"|"chat"}` を
 *    追記で畳む。投函済みの項目と、既読/承認の状態を持つ。
 * 2. `pending_user_decisions.jsonl` … **中間形式**。投函側が書く `t` を持たない行で、
 *    `ingest-pending` が箱へ流し込む。**2026-10-21 時点で ingest は一度も走っていない**
 *    (同ディレクトリに `ingested_keys.json` が無い)ため、ここを見ないと
 *    「投函済みだがユーザーから見えない」項目が残る。だから両方を読んで、
 *    箱に入った項目(`key` が一致)は箱側だけを残して重複を落とす。
 *
 * 壊れた行・未知の `t` の行は無視する(契約)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfirmBoxItem, ConfirmBoxSourceStatus } from "../shared/contract.js";
import { compareConfirmBoxItems, KIND_LABEL } from "../shared/contract.js";
import {
  BACKGROUND_MAX,
  SUMMARY_MAX,
  SUBJECT_MAX,
  normalizeGroup,
  normalizeKey,
  normalizeOptions,
  normalizePriority,
  normalizeRecommended,
  normalizeStoppedCount,
  normalizeSubrank,
  normalizeThreadRef,
  parseJsonl,
  str,
} from "./normalize.js";

const EVENTS_FILE = /^events-\d{6}\.jsonl$/;
export const PENDING_FILE = "pending_user_decisions.jsonl";

/** `TOPOS_CONFIRM_BOX_DIR` があればそれ、無ければ `~/.local/state/toposai/confirm_box`。
 *  store.ts の `resolveConfirmBoxDir()` と同じ規則(`~` 展開つき)。 */
export function resolveConfirmBoxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOPOS_CONFIRM_BOX_DIR;
  if (override && override.trim().length > 0) {
    return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  }
  return path.join(os.homedir(), ".local", "state", "toposai", "confirm_box");
}

// ---------------------------------------------------------------- 箱(events-*.jsonl)

/** `events-*.jsonl` の行を1つの Map へ畳む(store.ts `ConfirmBoxStore` と同じ規則)。 */
export function foldBoxEvents(
  records: readonly Record<string, unknown>[],
): Map<string, ConfirmBoxItem> {
  const items = new Map<string, ConfirmBoxItem>();
  for (const e of records) {
    switch (e.t) {
      case "item":
        applyItem(items, e);
        break;
      case "ack":
        applyAck(items, e);
        break;
      case "ackall":
        applyAckAll(items, e);
        break;
      // "push" は表示に関係しない、"chat" は項目ではなく質問なので、この版では畳まない。
      // 未知の `t` も同じく無視する(契約)。
      default:
        break;
    }
  }
  return items;
}

function applyItem(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  // 同じ id の2件目以降は捨てる(store.ts と同じ。先着を正とする)
  if (typeof e.id !== "string" || !e.id || items.has(e.id)) return;
  if (typeof e.ts !== "number") return;
  const options = normalizeOptions(e.options);
  items.set(e.id, {
    id: e.id,
    kind: "box",
    priority: normalizePriority(e.priority),
    subrank: normalizeSubrank(e.subrank),
    group: normalizeGroup(e.group),
    subject: str(e.subject).slice(0, SUBJECT_MAX),
    summary: str(e.summary).slice(0, SUMMARY_MAX),
    background: str(e.background).slice(0, BACKGROUND_MAX),
    source: str(e.source, "unknown"),
    threadRef: normalizeThreadRef(e.thread_ref),
    stoppedCount: normalizeStoppedCount(e.stopped_count),
    options,
    recommended: normalizeRecommended(e.recommended, options),
    state: "new",
    urgency: e.urgency === "urgent" ? "urgent" : "normal",
    key: normalizeKey(e.key),
    agentId: null,
    workspaceId: null,
    ts: e.ts,
  });
}

function applyAck(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  const item = typeof e.id === "string" ? items.get(e.id) : undefined;
  if (!item) return;
  if (e.action === "approve") item.state = "approved";
  else if (item.state === "new") item.state = "read";
}

function applyAckAll(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  const before = typeof e.before === "number" ? e.before : 0;
  for (const item of items.values()) {
    if (item.state === "new" && item.ts <= before) item.state = "read";
  }
}

/** 箱のファイル一覧(古い順)。読めなければ空。 */
export function listEventFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => EVENTS_FILE.test(n))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 中間形式(pending_user_decisions.jsonl)

/**
 * `t` を持たない行 = 未決の判断項目。`t:"decision"` は決定済みなので `key` で突き合わせて外す。
 * `t:"chat"` と未知の `t` は、この版では表示しない。
 *
 * **`ts` を持たない**ので行番号を代理に使う(後ろの行ほど新しい)。
 * 並び順の最後の軸(ts降順)だけに効くので、値そのものは表示しない。
 */
export function parsePendingRecords(records: readonly Record<string, unknown>[]): {
  items: ConfirmBoxItem[];
  decidedKeys: Set<string>;
  problems: number;
} {
  const items: ConfirmBoxItem[] = [];
  const decidedKeys = new Set<string>();
  let problems = 0;

  records.forEach((r, index) => {
    const t = r.t;
    if (typeof t === "string" && t.length > 0) {
      if (t === "decision") {
        const key = normalizeKey(r.key);
        if (key) decidedKeys.add(key);
      }
      return; // chat / 未知の t は無視
    }
    const key = normalizeKey(r.key);
    if (!key) {
      problems += 1; // key が無いと決定を書き戻せないので、この項目は出さない
      return;
    }
    const options = normalizeOptions(r.options);
    items.push({
      id: `pending:${key}`,
      kind: "pending",
      priority: normalizePriority(r.priority),
      subrank: normalizeSubrank(r.subrank),
      group: normalizeGroup(r.group),
      subject: str(r.subject).slice(0, SUBJECT_MAX),
      summary: str(r.summary).slice(0, SUMMARY_MAX),
      background: str(r.background).slice(0, BACKGROUND_MAX),
      source: str(r.source, "unknown"),
      threadRef: normalizeThreadRef(r.thread_ref),
      stoppedCount: normalizeStoppedCount(r.stopped_count),
      options,
      recommended: normalizeRecommended(r.recommended, options),
      state: "new",
      urgency: "normal",
      key,
      agentId: null,
      workspaceId: null,
      ts: index,
    });
  });

  return { items, decidedKeys, problems };
}

// ---------------------------------------------------------------- 統合

/**
 * 箱と中間形式を1つにする。**同じ `key` が両方にあれば箱側だけ残す**
 * (箱側は既読/承認の状態を持つため。中間形式は ingest 前の控えにすぎない)。
 */
export function mergeBoxAndPending(
  boxItems: readonly ConfirmBoxItem[],
  pendingItems: readonly ConfirmBoxItem[],
): ConfirmBoxItem[] {
  const boxKeys = new Set<string>();
  for (const item of boxItems) if (item.key) boxKeys.add(item.key);
  const merged = [...boxItems];
  for (const item of pendingItems) {
    if (item.key && boxKeys.has(item.key)) continue;
    merged.push(item);
  }
  return merged.sort(compareConfirmBoxItems);
}

export interface ReadConfirmBoxResult {
  items: ConfirmBoxItem[];
  sources: ConfirmBoxSourceStatus[];
  dir: string;
}

/** ディレクトリを読んで統合した一覧を返す。**例外を投げない**(読めない出所は status に出す)。 */
export function readConfirmBox(dir: string = resolveConfirmBoxDir()): ReadConfirmBoxResult {
  const sources: ConfirmBoxSourceStatus[] = [];

  // --- 箱
  let boxItems: ConfirmBoxItem[] = [];
  let boxDetail = "";
  let boxOk = true;
  const files = listEventFiles(dir);
  if (files.length === 0) {
    boxOk = true;
    boxDetail = "events-*.jsonl なし(まだ投函されていない)";
  } else {
    try {
      const records = files.flatMap((name) =>
        parseJsonl(fs.readFileSync(path.join(dir, name), "utf8")),
      );
      boxItems = [...foldBoxEvents(records).values()];
      boxDetail = `${files.join(", ")}`;
    } catch (error) {
      boxOk = false;
      boxDetail = `読めません: ${(error as Error).message}`;
    }
  }

  // --- 中間形式
  let pendingItems: ConfirmBoxItem[] = [];
  let pendingDetail = "";
  let pendingOk = true;
  const pendingPath = path.join(dir, PENDING_FILE);
  if (!fs.existsSync(pendingPath)) {
    pendingDetail = `${PENDING_FILE} なし`;
  } else {
    try {
      const parsed = parsePendingRecords(parseJsonl(fs.readFileSync(pendingPath, "utf8")));
      // 決定済みの key を外す(投函側が箱へ流す前でも、決めたものが残らないように)
      pendingItems = parsed.items.filter((i) => !(i.key && parsed.decidedKeys.has(i.key)));
      pendingDetail =
        `${PENDING_FILE}(決定済み ${parsed.decidedKeys.size} 件を除外` +
        (parsed.problems > 0 ? `・key 無し ${parsed.problems} 件を除外` : "") +
        ")";
    } catch (error) {
      pendingOk = false;
      pendingDetail = `読めません: ${(error as Error).message}`;
    }
  }

  // 決定行(decision)が1つでもある key は、箱側の項目も決定済みとして外す
  // (ingest 済みの項目は箱に入っているため、中間形式の除外だけでは未決一覧に残る)。
  let decidedKeys = new Set<string>();
  try {
    if (fs.existsSync(pendingPath)) {
      decidedKeys = parsePendingRecords(
        parseJsonl(fs.readFileSync(pendingPath, "utf8")),
      ).decidedKeys;
    }
  } catch {
    // 読めない場合は上の pendingDetail に出ているのでここでは何もしない
  }
  for (const item of boxItems) {
    if (item.key && decidedKeys.has(item.key)) item.state = "approved";
  }

  sources.push({
    id: "box",
    label: KIND_LABEL.box,
    ok: boxOk,
    detail: boxDetail,
    count: boxItems.length,
  });
  sources.push({
    id: "pending",
    label: KIND_LABEL.pending,
    ok: pendingOk,
    detail: pendingDetail,
    count: pendingItems.length,
  });

  return { items: mergeBoxAndPending(boxItems, pendingItems), sources, dir };
}

// ---------------------------------------------------------------- 決定の書き戻し

/**
 * `{"t":"decision",...}` を `pending_user_decisions.jsonl` へ追記する。
 * 契約は `handoff_confirm_box_recommendation_feedback_kickoff.md` で固定。
 * `matched` は**投函側(ここ)が機械計算**する(読み手ごとに解釈が揺れないように)。
 *
 * 追記は O_APPEND の単一 write(箱と同じ流儀。書き手が複数プロセスでも行が混ざらない)。
 */
export function appendDecision(
  dir: string,
  decision: {
    key: string;
    chosen: string | null;
    recommended: string | null;
    depth: string;
    reason: string;
    source: string;
  },
  now: number = Date.now(),
): void {
  const record = {
    t: "decision",
    key: decision.key,
    ts: now,
    chosen: decision.chosen,
    recommended: decision.recommended,
    matched:
      decision.chosen !== null &&
      decision.recommended !== null &&
      decision.chosen === decision.recommended,
    depth: decision.depth,
    decided_by: "user",
    reason: decision.reason,
    source: decision.source,
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dir, PENDING_FILE), "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
