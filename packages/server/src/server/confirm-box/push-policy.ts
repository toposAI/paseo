import type { ConfirmBoxItem } from "./store.js";

/**
 * 緊急項目のpush通知方針。メール洪水と同じ失敗(通知疲れ)に戻らないよう、保守的に絞る。
 *  - 対象は「緊急・未読・未push」だけ。通常はバッジのみでpushしない。
 *  - 古い項目(既定6時間超)はpushしない(デーモン停止中に溜まった分を再起動直後に連打しない)。
 *  - push間隔は最短5分、1時間あたり最大6回。該当が複数なら1通にまとめる。
 *  - 本文は件名のみ(box本文の詳細や秘密がロック画面に出ないように)。
 */
export interface PushPolicyConfig {
  maxAgeMs: number;
  minIntervalMs: number;
  maxPerHour: number;
  maxSubjectsInBody: number;
}

export const DEFAULT_PUSH_POLICY: PushPolicyConfig = {
  maxAgeMs: 6 * 60 * 60 * 1000,
  minIntervalMs: 5 * 60 * 1000,
  maxPerHour: 6,
  maxSubjectsInBody: 3,
};

export interface PushDecision {
  ids: string[];
  payload: { title: string; body: string; data: Record<string, unknown> };
}

export function decidePush(input: {
  items: ConfirmBoxItem[];
  now: number;
  pushTimes: number[];
  config?: PushPolicyConfig;
}): PushDecision | null {
  const config = input.config ?? DEFAULT_PUSH_POLICY;
  const recent = input.pushTimes.filter((t) => input.now - t < 60 * 60 * 1000);
  if (recent.length >= config.maxPerHour) return null;
  const last = recent.length > 0 ? Math.max(...recent) : null;
  if (last !== null && input.now - last < config.minIntervalMs) return null;

  const candidates = input.items.filter(
    (item) =>
      item.urgency === "urgent" &&
      item.state === "new" &&
      item.pushedAt === null &&
      input.now - item.ts <= config.maxAgeMs,
  );
  if (candidates.length === 0) return null;

  const subjects = candidates.slice(-config.maxSubjectsInBody).map((c) => c.subject);
  const more = candidates.length - subjects.length;
  const body = more > 0 ? `${subjects.join(" / ")} 他${more}件` : subjects.join(" / ");
  return {
    ids: candidates.map((c) => c.id),
    payload: {
      title: `確認箱: 緊急 ${candidates.length}件`,
      body,
      data: { type: "confirm-box", url: "/api/confirm-box/" },
    },
  };
}
