/**
 * 読んだ位置の保存先。箱ディレクトリの `read_positions.json` 1ファイルに
 * `{ version, overrides: {agentId: boolean}, positions: {agentId: {seq, epoch, updated_at}} }` を置く。
 * 保存は一時ファイルへ書いて置換(読み手が途中の内容を見ない)。壊れたファイルは空として扱い、
 * 次の保存で作り直す(画面を止めない=fail-open)。
 */
import fs from "node:fs";
import path from "node:path";
import { isReadPositionDefaultOn } from "../shared/read-position.js";

export const READ_POSITIONS_FILE = "read_positions.json";

export interface StoredPosition {
  seq: number;
  epoch: string;
  updated_at: number;
}

interface Store {
  overrides: Record<string, boolean>;
  positions: Record<string, StoredPosition>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readStore(dir: string): Store {
  const empty: Store = { overrides: {}, positions: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, READ_POSITIONS_FILE), "utf8"));
  } catch {
    return empty;
  }
  if (!isRecord(raw)) return empty;
  const overrides: Record<string, boolean> = {};
  if (isRecord(raw.overrides)) {
    for (const [k, v] of Object.entries(raw.overrides))
      if (typeof v === "boolean") overrides[k] = v;
  }
  const positions: Record<string, StoredPosition> = {};
  if (isRecord(raw.positions)) {
    for (const [k, v] of Object.entries(raw.positions)) {
      if (
        isRecord(v) &&
        typeof v.seq === "number" &&
        Number.isFinite(v.seq) &&
        typeof v.epoch === "string"
      ) {
        positions[k] = {
          seq: v.seq,
          epoch: v.epoch,
          updated_at: typeof v.updated_at === "number" ? v.updated_at : 0,
        };
      }
    }
  }
  return { overrides, positions };
}

function writeStore(dir: string, store: Store): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, READ_POSITIONS_FILE);
  const tmp = path.join(dir, `.${READ_POSITIONS_FILE}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ version: 1, ...store }, null, 2);
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
}

export function isEnabled(store: Store, agentId: string, title: string | undefined): boolean {
  const o = store.overrides[agentId];
  return typeof o === "boolean" ? o : isReadPositionDefaultOn(title);
}

export function getPosition(dir: string, agentId: string, title?: string) {
  const store = readStore(dir);
  const p = store.positions[agentId];
  return {
    enabled: isEnabled(store, agentId, title),
    seq: p?.seq ?? null,
    epoch: p?.epoch ?? null,
    updatedAt: p?.updated_at ?? null,
  };
}

/**
 * 位置を進める。同じ世代では大きい値だけを採る(古い端末が遅れて送った小さい値で戻さない)。
 * 世代が違えば新しい方で置き換える。記録対象でないスレには書かない。
 */
export function setPosition(
  dir: string,
  agentId: string,
  title: string | undefined,
  seq: number,
  epoch: string,
  now: number = Date.now(),
): { ok: boolean; seq: number | null; message?: string } {
  if (!agentId.trim() || !epoch || !Number.isFinite(seq)) {
    return { ok: false, seq: null, message: "agentId・epoch・seq が不正です" };
  }
  const store = readStore(dir);
  if (!isEnabled(store, agentId, title))
    return { ok: true, seq: store.positions[agentId]?.seq ?? null };
  // 題名の目印で初めて記録対象になったら固定する(あとで題名が変わっても記録が止まらない)。
  if (typeof store.overrides[agentId] !== "boolean") store.overrides[agentId] = true;
  const cur = store.positions[agentId];
  if (cur && cur.epoch === epoch && cur.seq >= seq) return { ok: true, seq: cur.seq };
  store.positions[agentId] = { seq, epoch, updated_at: now };
  writeStore(dir, store);
  return { ok: true, seq };
}

export function setEnabled(dir: string, agentId: string, enabled: boolean | null): void {
  if (!agentId.trim()) throw new Error("agentId が空です");
  const store = readStore(dir);
  if (enabled === null) delete store.overrides[agentId];
  else store.overrides[agentId] = enabled;
  writeStore(dir, store);
}
