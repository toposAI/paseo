import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
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
  timelineEpoch: string | null;
  items: readonly StreamItem[];
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
  const { serverId, agentId, timelineEpoch, items, jumpToSeq } = input;
  const title = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.title ?? null,
  );
  const loadedSeqs = useMemo(
    () => items.flatMap((item) => (item.timelineCursor ? [item.timelineCursor.seq] : [])),
    [items],
  );
  const [stored, setStored] = useState<StoredReadPosition | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const awaitingLandingRef = useRef(false);
  const quietUntilRef = useRef(0);
  const highWaterRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchStartedForRef = useRef<string | null>(null);
  const currentKeyRef = useRef("");
  const latestRef = useRef({ epoch: timelineEpoch, title, newest: -1 });
  latestRef.current = {
    epoch: timelineEpoch,
    title,
    newest: loadedSeqs.length > 0 ? Math.max(...loadedSeqs) : -1,
  };
  const key = `${serverId}\u0000${agentId}`;
  currentKeyRef.current = key;
  const titleReady = title !== null;

  // Sends the not-yet-sent position of the epoch it was seen under; also used when leaving.
  const sendPending = useStableEvent(
    (target: { serverId: string; agentId: string; epoch: string | null }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const seq = pendingRef.current;
      pendingRef.current = null;
      if (seq === null || target.epoch === null) return;
      void invoke(target.serverId, "topos.readpos.set", {
        agentId: target.agentId,
        title: latestRef.current.title ?? undefined,
        seq,
        epoch: target.epoch,
      }).catch(() => undefined);
    },
  );

  // New chat: forget everything. Leaving a chat (or the page going hidden) must not lose the last seen row.
  useEffect(() => {
    restoredRef.current = false;
    awaitingLandingRef.current = false;
    quietUntilRef.current = 0;
    highWaterRef.current = null;
    pendingRef.current = null;
    fetchStartedForRef.current = null;
    setStored(null);
    setFetchedFor(null);
    if (!isWeb) return;
    const target = { serverId, agentId, epoch: latestRef.current.epoch };
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        sendPending({ ...target, epoch: latestRef.current.epoch });
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      sendPending({ ...target, epoch: latestRef.current.epoch });
    };
  }, [key, serverId, agentId, sendPending]);

  // A new history epoch makes every earlier seq meaningless: flush the old one, restart the record.
  useEffect(() => {
    const epochAtRender = timelineEpoch;
    return () => {
      sendPending({ serverId, agentId, epoch: epochAtRender });
      highWaterRef.current = null;
      restoredRef.current = false;
    };
  }, [timelineEpoch, serverId, agentId, sendPending]);

  // The default-on rule reads the title, so ask once it is known (and only once per chat).
  useEffect(() => {
    if (!isWeb || !titleReady || fetchStartedForRef.current === key) return;
    fetchStartedForRef.current = key;
    invoke(serverId, "topos.readpos.get", {
      agentId,
      title: latestRef.current.title ?? undefined,
    })
      .then((out) => {
        if (currentKeyRef.current !== key) return false;
        setStored(parseStored(out));
        setFetchedFor(key);
        return true;
      })
      .catch(() => {
        if (currentKeyRef.current === key) setFetchedFor(key);
      });
  }, [key, titleReady, serverId, agentId]);

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
    awaitingLandingRef.current = true;
    quietUntilRef.current = Date.now() + POST_RESTORE_QUIET_MS;
    jump(seq);
  }, [fetchedFor, key, loadedSeqs, stored, timelineEpoch, jump]);

  const flush = useStableEvent(() => {
    sendPending({ serverId, agentId, epoch: latestRef.current.epoch });
  });

  return useCallback(
    (viewedSeq: number | null) => {
      // Until the stored record has been applied, the bottom of the chat would overwrite it.
      if (!isWeb || !restoredRef.current || !stored?.enabled) return;
      if (Date.now() < quietUntilRef.current) return;
      if (awaitingLandingRef.current) {
        // A jump that has not landed (not loaded yet, not mounted) leaves the view at the bottom:
        // that must not count as "seen". Landing = some later row is still unseen.
        if (viewedSeq === null || viewedSeq >= latestRef.current.newest) return;
        awaitingLandingRef.current = false;
      }
      const next = nextHighWater(highWaterRef.current, viewedSeq);
      if (next === null) return;
      highWaterRef.current = next;
      pendingRef.current = next;
      if (!timerRef.current) timerRef.current = setTimeout(flush, REPORT_DEBOUNCE_MS);
    },
    [flush, stored],
  );
}
