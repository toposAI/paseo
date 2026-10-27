import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  nextHighWater,
  pickResume,
  shouldDismissUnreadDivider,
  type StoredReadPosition,
} from "./read-position-sync";

// The daemon-side store lives in the topos-confirm-box plugin (plugins/topos-confirm-box/shared/read-position.ts).
// Any failure (plugin missing or disabled, offline) leaves the chat exactly as it was without the sync.
const PLUGIN_ID = "topos-confirm-box";
const REPORT_DEBOUNCE_MS = 1500;
// After jumping back to the stored row, rows shown on the way must not count as "seen".
const POST_RESTORE_QUIET_MS = 2500;
// History may need more than one fetch to reach a row that was seen long ago; stop asking after this.
const MAX_HISTORY_FETCHES = 8;

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

export interface ReadPositionSync {
  /** Feed from the viewport: the seq of the last fully visible row. */
  reportViewedSeq: (viewedSeq: number | null) => void;
  /** The seq of the first row the reader had not seen when the chat opened; the divider goes above it. */
  unreadFromSeq: number | null;
}

/** Resumes the chat where the reader stopped, and keeps the daemon-side record up to date. */
export function useReadPositionSync(input: Input): ReadPositionSync {
  const { serverId, agentId, timelineEpoch, items, jumpToSeq } = input;
  const title = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.title ?? null,
  );
  // Rows from another history epoch carry a seq that means nothing here: keep only this epoch's.
  const loadedSeqs = useMemo(
    () =>
      items.flatMap((item) =>
        item.timelineCursor && item.timelineCursor.epoch === timelineEpoch
          ? [item.timelineCursor.seq]
          : [],
      ),
    [items, timelineEpoch],
  );
  const newestLoadedSeq = useMemo(
    () => loadedSeqs.reduce<number | null>((m, s) => (m === null || s > m ? s : m), null),
    [loadedSeqs],
  );
  const [stored, setStored] = useState<StoredReadPosition | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  // The "ここから未読" divider: dropped once the reader has seen everything that existed at open.
  const [unreadFrom, setUnreadFrom] = useState<{ key: string; seq: number } | null>(null);
  const dismissAtRef = useRef<number | null>(null);
  // While the unread stretch below the divider is still on screen, the reader may not move their
  // record into it by scrolling (a long line grows as it streams and drops out of view). Cleared by
  // reaching the divider or the newest row.
  const blockedUntilRef = useRef<{ key: string; markerSeq: number; readSeq: number } | null>(null);
  const restoredRef = useRef(false);
  const awaitingLandingRef = useRef(false);
  const quietUntilRef = useRef(0);
  const highWaterRef = useRef<number | null>(null);
  // The row is captured with the chat and history epoch it was seen under, so a send that happens
  // after the reader has switched chats still carries the old chat's epoch and title.
  const pendingRef = useRef<{
    seq: number;
    epoch: string | null;
    title: string | null;
    serverId: string;
    agentId: string;
    atKey: string;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastViewedRef = useRef<number | null>(null);
  const historyFetchCountRef = useRef(0);
  const fetchStartedForRef = useRef<string | null>(null);
  const currentKeyRef = useRef("");
  const latestRef = useRef({ epoch: timelineEpoch, title, newest: -1 });
  latestRef.current = {
    epoch: timelineEpoch,
    title,
    newest: newestLoadedSeq ?? -1,
  };
  const key = `${serverId}\u0000${agentId}`;
  currentKeyRef.current = key;
  const titleReady = title !== null;

  /** The chat the position was asked for; a late answer must not land on the next chat. */
  const keyRef = useRef("");
  keyRef.current = key;

  // Sends the not-yet-sent position of the epoch it was seen under; also used when leaving.
  const sendPending = useStableEvent(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null || pending.epoch === null) return;
    // Lines that kept streaming while the reader was still below them are not read yet.
    const blocked = blockedUntilRef.current;
    let seq = pending.seq;
    if (blocked && blocked.key === pending.atKey) {
      // Keep the blocked position instead of the unread rows (never report "read" a row they may not have seen).
      if (seq >= blocked.markerSeq) seq = blocked.readSeq;
      blockedUntilRef.current = null;
    }
    void invoke(pending.serverId, "topos.readpos.set", {
      agentId: pending.agentId,
      title: pending.title ?? undefined,
      seq,
      epoch: pending.epoch,
    }).catch(() => undefined);
  });

  // New chat: forget everything. Leaving a chat (or the page going hidden) must not lose the last seen row.
  // The pending row carries its own chat and epoch, so sending it here is safe.
  useEffect(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    restoredRef.current = false;
    awaitingLandingRef.current = false;
    quietUntilRef.current = 0;
    highWaterRef.current = null;
    pendingRef.current = null;
    lastViewedRef.current = null;
    historyFetchCountRef.current = 0;
    fetchStartedForRef.current = null;
    dismissAtRef.current = null;
    blockedUntilRef.current = null;
    setStored(null);
    setFetchedFor(null);
    setUnreadFrom(null);
    if (!isWeb) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") sendPending();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      sendPending();
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    };
  }, [key, sendPending]);

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

  // The reader stopped before the oldest loaded row: the rows in between are missing, so a divider
  // here would sit under a gap and silently skip them. Pull that part of the history and decide
  // again once it is here (bounded, in case the row no longer exists).
  const restoreAfterHistory = useCallback(
    (storedSeq: number) => {
      if (historyFetchCountRef.current >= MAX_HISTORY_FETCHES) return;
      historyFetchCountRef.current += 1;
      jump(storedSeq);
    },
    [jump],
  );

  useEffect(() => {
    if (!isWeb || fetchedFor !== key || restoredRef.current) return;
    if (loadedSeqs.length === 0 || timelineEpoch === null) return;
    const storedSeq =
      stored?.enabled === true && stored.epoch === timelineEpoch ? stored.seq : null;
    if (storedSeq !== null && storedSeq < Math.min(...loadedSeqs)) {
      restoreAfterHistory(storedSeq);
      return;
    }
    restoredRef.current = true;
    if (stored?.enabled && stored.epoch === timelineEpoch && stored.seq !== null) {
      highWaterRef.current = stored.seq;
    }
    const pick = pickResume({ stored, timelineEpoch, loadedSeqs });
    if (pick === null) return;
    awaitingLandingRef.current = true;
    quietUntilRef.current = Date.now() + POST_RESTORE_QUIET_MS;
    dismissAtRef.current = pick.newestSeq;
    if (stored?.seq !== null && stored?.seq !== undefined) {
      blockedUntilRef.current = {
        key,
        markerSeq: pick.firstUnreadSeq,
        readSeq: stored.seq,
      };
    }
    setUnreadFrom({ key, seq: pick.firstUnreadSeq });
    jump(pick.restoreSeq);
  }, [fetchedFor, key, loadedSeqs, stored, timelineEpoch, jump, restoreAfterHistory]);

  const unreadFromSeqRef = useRef<number | null>(null);

  /** Records the last row the reader has fully seen; `epoch`/`title` are the ones it was seen under. */
  const record = useCallback(
    (viewedSeq: number | null, epoch: string | null, seenUnder: string | null) => {
      if (Date.now() < quietUntilRef.current) return;
      if (viewedSeq !== null && viewedSeq >= (dismissAtRef.current ?? Number.POSITIVE_INFINITY)) {
        // Everything that existed at open has been seen: nothing left to protect.
        blockedUntilRef.current = null;
      } else if (
        viewedSeq !== null &&
        viewedSeq >= (unreadFromSeqRef.current ?? Number.POSITIVE_INFINITY)
      ) {
        // The reader reached the divider; from here on the rows they pass are read.
        blockedUntilRef.current = null;
      }
      const next = nextHighWater(highWaterRef.current, viewedSeq);
      if (next === null) return;
      highWaterRef.current = next;
      if (shouldDismissUnreadDivider(next, dismissAtRef.current)) {
        setUnreadFrom((current) => (current?.key === key ? null : current));
      }
      pendingRef.current = { seq: next, epoch, title: seenUnder, serverId, agentId, atKey: key };
      if (!timerRef.current) timerRef.current = setTimeout(sendPending, REPORT_DEBOUNCE_MS);
    },
    [agentId, key, sendPending, serverId],
  );

  const reportViewedSeq = useCallback(
    (viewedSeq: number | null) => {
      // Until the stored record has been applied, the bottom of the chat would overwrite it.
      if (!isWeb || !restoredRef.current || !stored?.enabled) return;
      lastViewedRef.current = viewedSeq;
      if (Date.now() < quietUntilRef.current) return;
      if (awaitingLandingRef.current) {
        // A jump that has not landed leaves the view at the bottom, which is exactly where the newest
        // rows are: the report only proves a landing once the view has left that spot. Rows arriving
        // afterwards load at the bottom too, so the first report in the quiet moment decides.
        if (viewedSeq === null || viewedSeq >= latestRef.current.newest) return;
        awaitingLandingRef.current = false;
      }
      record(viewedSeq, latestRef.current.epoch, latestRef.current.title);
    },
    [record, stored],
  );

  // A jump the view cannot tell apart from the bottom (every unread row fits on one screen) still
  // counts as landed once the quiet moment is over: nothing on the way can have been skipped then.
  useEffect(() => {
    if (!isWeb) return;
    const epoch = timelineEpoch;
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      if (!restoredRef.current || !awaitingLandingRef.current) return;
      if (currentKeyRef.current !== key || latestRef.current.epoch !== epoch) return;
      awaitingLandingRef.current = false;
      record(lastViewedRef.current, epoch, latestRef.current.title);
    }, POST_RESTORE_QUIET_MS + 100);
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    };
  }, [key, timelineEpoch, record]);

  // Only the active chat's divider counts; a divider remembered from a previous chat must not show.
  const unreadFromSeq = unreadFrom?.key === key ? unreadFrom.seq : null;
  unreadFromSeqRef.current = unreadFromSeq;

  return useMemo(() => ({ reportViewedSeq, unreadFromSeq }), [reportViewedSeq, unreadFromSeq]);
}
