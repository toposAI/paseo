/**
 * 投函側の typo で箱が壊れないように既定値へ寄せる。
 *
 * **正本は `packages/server/src/server/confirm-box/store.ts` の同名関数**(Python側は
 * `antigravity/utils/notify_box.py`)。ここはその写しで、値を変えるときは3箇所そろえること。
 * プラグインはホストの内部パッケージを import できないため、写しを持つしかない。
 */
import type {
  ConfirmBoxOption,
  ConfirmBoxPriority,
  ConfirmBoxThreadRef,
} from "../shared/contract.js";
import { DEFAULT_PRIORITY, DEPTHS, PRIORITIES } from "../shared/contract.js";

export const OPTION_LABEL_MAX = 120;
export const OPTIONS_MAX = 6;
export const GROUP_MAX = 80;
export const SUMMARY_MAX = 400;
export const BACKGROUND_MAX = 8000;
export const SUBJECT_MAX = 200;
export const KEY_MAX = 200;

export function normalizePriority(value: unknown): ConfirmBoxPriority {
  return PRIORITIES.includes(value as ConfirmBoxPriority)
    ? (value as ConfirmBoxPriority)
    : DEFAULT_PRIORITY;
}

export function normalizeSubrank(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

export function normalizeGroup(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const group = value.trim().slice(0, GROUP_MAX);
  return group.length > 0 ? group : null;
}

export function normalizeOptions(value: unknown): ConfirmBoxOption[] {
  if (!Array.isArray(value)) return [];
  const out: ConfirmBoxOption[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    // id/label が空の要素と id の重複は落とす(タップ結果を一意に記録できなくなるため)
    const id = typeof o.id === "string" ? o.id.trim().slice(0, 40) : "";
    const label = typeof o.label === "string" ? o.label.trim().slice(0, OPTION_LABEL_MAX) : "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label });
    if (out.length >= OPTIONS_MAX) break;
  }
  return out;
}

/** 推奨する選択肢のid。**`options` に無いidは null に落とす**
 * (存在しない選択肢を推奨にすると「推奨どおり決めたか」の判定が壊れる)。 */
export function normalizeRecommended(value: unknown, options: ConfirmBoxOption[]): string | null {
  const id = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return id && options.some((o) => o.id === id) ? id : null;
}

export function normalizeThreadRef(value: unknown): ConfirmBoxThreadRef | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = typeof v.kind === "string" ? v.kind.trim().slice(0, 40) : "";
  const id = typeof v.id === "string" ? v.id.trim().slice(0, KEY_MAX) : "";
  return kind && id ? { kind, id } : null;
}

export function normalizeStoppedCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export function normalizeDepth(value: unknown): (typeof DEPTHS)[number] | null {
  return DEPTHS.includes(value as (typeof DEPTHS)[number])
    ? (value as (typeof DEPTHS)[number])
    : null;
}

export function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().slice(0, KEY_MAX);
  return key.length > 0 ? key : null;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** JSONL を1行ずつ JSON へ。壊れた行・非オブジェクト行は**黙って落とす**(契約)。 */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    out.push(parsed as Record<string, unknown>);
  }
  return out;
}
