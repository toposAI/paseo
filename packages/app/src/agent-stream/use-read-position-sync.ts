import { useCallback, useEffect, useRef, useState } from "react";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { nextHighWater, pickRestoreSeq, type StoredReadPosition } from "./read-position-sync";

// The daemon-side store lives in the topos-confirm-box plugin (plugins/topos-confirm-box/shared/read-position.ts).
// Any failure (plugin missing or disabled, offline) leaves the chat exactly as it was without the sync.
const PLUGIN_ID = "topos-confirm-box";
const REPORT_DEBOUNCE_MS = 1500;
// After jumping back to the stored row, rows shown on the way must not count as "seen".
const POST_RESTORE_QUIET_MS = 2500;

interface Input {
  serverId: string;
  agentId: string;
  title: string | null;
  timelineEpoch: string | null;
  loadedSeqs: readonly number[];
  jumpToSeq: (seq: number) => void;
}

async function invoke(serverId: string, method: string, input: unknown): Promise<unknown> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("no client");
  return client.invokePluginRpc(PLUGIN_ID, method, input);
}

function parseStored(v: unknown): StoredReadPosition | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    seq: typeof o.seq === "number" ? o.seq : null,
    epoch: typeof o.epoch === "string" ? o.epoch : null,
  };
}

/** Returns the callback the viewport feeds with the seq of the last fully visible row. */
export function useReadPositionSync(input: Input): (viewedSeq: number | null) => void {
  const { serverId, agentId, title, timelineEpoch, loadedSeqs, jumpToSeq } = input;
  const [stored, setStored] = useState<StoredReadPosition | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const quietUntilRef = useRef(0);
  const highWaterRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = `${serverId}\u0000${agentId}`;

  useEffect(() => {
    restoredRef.current = false;
    quietUntilRef.current = 0;
    highWaterRef.current = null;
    pendingRef.current = null;
    setStored(null);
    setFetchedFor(null);
    if (!isWeb) return;
    let alive = true;
    invoke(serverId, "topos.readpos.get", {
      agentId,
      title: title ?? undefined,
    })
      .then((out) => {
        if (!alive) return;
        setStored(parseStored(out));
        setFetchedFor(key);
      })
      .catch(() => {
        if (alive) setFetchedFor(key);
      });
    return () => {
      alive = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // The default-on rule reads the title, which can arrive after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, title !== null]);

  const jump = useStableEvent(jumpToSeq);

  useEffect(() => {
    if (!isWeb || fetchedFor !== key || restoredRef.current) return;
    if (loadedSeqs.length === 0 || timelineEpoch === null) return;
    restoredRef.current = true;
    if (stored?.enabled && stored.epoch === timelineEpoch && stored.seq !== null) {
      highWaterRef.current = stored.seq;
    }
    const seq = pickRestoreSeq({ stored, timelineEpoch, loadedSeqs });
    if (seq === null) return;
    quietUntilRef.current = Date.now() + POST_RESTORE_QUIET_MS;
    jump(seq);
  }, [fetchedFor, key, loadedSeqs, stored, timelineEpoch, jump]);

  const flush = useStableEvent(() => {
    timerRef.current = null;
    const seq = pendingRef.current;
    pendingRef.current = null;
    if (seq === null || timelineEpoch === null) return;
    void invoke(serverId, "topos.readpos.set", {
      agentId,
      title: title ?? undefined,
      seq,
      epoch: timelineEpoch,
    }).catch(() => undefined);
  });

  return useCallback(
    (viewedSeq: number | null) => {
      // Until the stored record has been applied, the bottom of the chat would overwrite it.
      if (!isWeb || !restoredRef.current || !stored?.enabled) return;
      if (Date.now() < quietUntilRef.current) return;
      const next = nextHighWater(highWaterRef.current, viewedSeq);
      if (next === null) return;
      highWaterRef.current = next;
      pendingRef.current = next;
      if (!timerRef.current) timerRef.current = setTimeout(flush, REPORT_DEBOUNCE_MS);
    },
    [flush, stored],
  );
}
