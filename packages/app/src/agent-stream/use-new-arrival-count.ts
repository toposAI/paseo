import { useEffect, useMemo, useRef } from "react";
import type { StreamItem } from "@/types/stream";
import { countArrivalsAfter, newestSeqOf } from "./new-arrivals";

/**
 * How many rows arrived since the reader was last at the bottom. While `holding` is false the
 * baseline follows the newest row, so the count is 0; once the reader is away from the bottom the
 * baseline stays put and the count grows with each new row.
 */
export function useNewArrivalCount(input: {
  items: readonly StreamItem[];
  epoch: string | null;
  isNearBottom: boolean;
  isTimelineDetached: boolean;
  resetKey: string;
}): number {
  const { items, epoch, isNearBottom, isTimelineDetached, resetKey } = input;
  const holding = !isNearBottom || isTimelineDetached;
  const baselineRef = useRef<{ key: string; epoch: string | null; seq: number | null } | null>(
    null,
  );
  const current = baselineRef.current;
  const baselineSeq =
    current !== null && current.key === resetKey && current.epoch === epoch ? current.seq : null;
  const count = useMemo(
    () => (holding ? countArrivalsAfter(items, epoch, baselineSeq) : 0),
    [baselineSeq, epoch, holding, items],
  );
  useEffect(() => {
    if (holding) return;
    baselineRef.current = { key: resetKey, epoch, seq: newestSeqOf(items, epoch) };
  }, [epoch, holding, items, resetKey]);
  return count;
}
