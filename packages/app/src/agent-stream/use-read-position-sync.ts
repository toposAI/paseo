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
// Landing is the view being scrolled around the restored row close to when it was asked for; the
// fetch for a row that is not loaded yet usually takes longer than this.
const LANDING_GRACE_MS = 1000;

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
  /** Feed from the viewport: the seqs of the top row and of the last fully visible row. */
  reportViewedSeq: (viewedSeq: number | null, topSeq?: number | null) => void;
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
  // It belongs to the history it was picked from, so a new epoch neither shows nor reuses it.
  const [unreadFrom, setUnreadFrom] = useState<{ key: string; epoch: string; seq: number } | null>(
    null,
  );
  const dismissAtRef = useRef<number | null>(null);
  // While the unread stretch below the divider is still on screen, the reader may not move their
  // record into it by scrolling (a long line grows as it streams and drops out of view). Cleared by
  // reaching the divider or the newest row.
  const blockedUntilRef = useRef<{ key: string; markerSeq: number; readSeq: number } | null>(null);
  const restoredRef = useRef(false);
  const awaitingLandingRef = useRef(false);
  const landedRef = useRef(false);
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
  const [settleAt, setSettleAt] = useState<number | null>(null);
  const lastViewedRef = useRef<number | null>(null);
  const lastTopRef = useRef<number | null>(null);
  const firstUnreadRef = useRef<number | null>(null);
  const estimateRef = useRef<number | null>(null);
  const estimateStampRef = useRef<"jump" | "load" | null>(null);
  const requestAtRef = useRef<number | null>(null);
  const historyFetchCountRef = useRef(0);
  const oldestRequestedRef = useRef<number | null>(null);
  const fetchedForRef = useRef<string | null>(null);
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
    void invoke(pending.serverId, "topos.readpos.set", {
      agentId: pending.agentId,
      title: pending.title ?? undefined,
      seq: pending.seq,
      epoch: pending.epoch,
    }).catch(() => undefined);
  });

  // New chat or new history: forget everything. Leaving a chat (or the page going hidden) must not
  // lose the last seen row; the pending row carries its own chat and epoch, so sending it here is safe.
  useEffect(() => {
    setSettleAt(null);
    restoredRef.current = false;
    awaitingLandingRef.current = false;
    landedRef.current = false;
    quietUntilRef.current = 0;
    highWaterRef.current = null;
    pendingRef.current = null;
    lastViewedRef.current = null;
    lastTopRef.current = null;
    firstUnreadRef.current = null;
    estimateRef.current = null;
    estimateStampRef.current = null;
    requestAtRef.current = null;
    historyFetchCountRef.current = 0;
    oldestRequestedRef.current = null;
    fetchedForRef.current = null;
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
    };
  }, [key, timelineEpoch, sendPending]);

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
  // again once it is here. A fetch that brings nothing older, or too many fetches, ends the waiting
  // with the restored row unknown (opened as if everything were read) rather than never restoring.
  const restoreAfterHistory = useCallback(
    (storedSeq: number) => {
      const oldest = oldestRequestedRef.current;
      if (
        historyFetchCountRef.current >= MAX_HISTORY_FETCHES ||
        (oldest !== null && storedSeq >= oldest)
      ) {
        restoredRef.current = true;
        return;
      }
      if (oldest === null) requestAtRef.current = Date.now();
      oldestRequestedRef.current = storedSeq;
      historyFetchCountRef.current += 1;
      jump(storedSeq);
    },
    [jump],
  );

  useEffect(() => {
    if (!isWeb || fetchedFor !== key || restoredRef.current) return;
    if (loadedSeqs.length === 0 || timelineEpoch === null) return;
    const oldestLoaded = loadedSeqs.reduce((m, s) => (s < m ? s : m), Number.POSITIVE_INFINITY);
    const storedSeq =
      stored?.enabled === true && stored.epoch === timelineEpoch ? stored.seq : null;
    if (storedSeq !== null && storedSeq < oldestLoaded) {
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
    setSettleAt(quietUntilRef.current);
    dismissAtRef.current = pick.newestSeq;
    firstUnreadRef.current = pick.firstUnreadSeq;
    if (stored?.seq !== null && stored?.seq !== undefined) {
      blockedUntilRef.current = {
        key,
        markerSeq: pick.firstUnreadSeq,
        readSeq: stored.seq,
      };
    }
    setUnreadFrom({ key, epoch: timelineEpoch, seq: pick.firstUnreadSeq });
    requestAtRef.current = Date.now();
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
      // A scrolling view is already showing what it moves past: drop the not-yet-read mark as soon
      // as the reader has moved it (the rows below the divider that were on screen still are not
      // read; the report sent for this landing keeps the old position, see `sendPending`).
      if (blockedUntilRef.current !== null) blockedUntilRef.current = null;
      pendingRef.current = { seq: next, epoch, title: seenUnder, serverId, agentId, atKey: key };
      if (!timerRef.current) timerRef.current = setTimeout(sendPending, REPORT_DEBOUNCE_MS);
    },
    [agentId, key, sendPending, serverId],
  );

  const reportViewedSeq = useCallback(
    (viewedSeq: number | null, topSeq: number | null = null) => {
      // Until the stored record has been applied, the bottom of the chat would overwrite it.
      if (!isWeb || !restoredRef.current || !stored?.enabled) return;
      lastViewedRef.current = viewedSeq;
      lastTopRef.current = topSeq;
      const estimate = estimateRef.current;
      if (awaitingLandingRef.current) {
        const atOrAboveUnread =
          topSeq !== null && firstUnreadRef.current !== null && topSeq <= firstUnreadRef.current;
        if (atOrAboveUnread) {
          // The view sits at or above the first unread row: the jump landed, whatever the newest row
          // is. The landing is only remembered here; recording still waits for the quiet moment.
          landedRef.current = true;
        } else if (estimateStampRef.current === "load") {
          // Rows still being loaded can move the view without the reader: not a landing.
          estimateStampRef.current = null;
        } else if (estimate !== null && topSeq !== null && topSeq !== estimate) {
          // A scroll reaching above where the view was left once the request settled is the reader
          // moving (the rows loaded on the way can be taller than the ones replaced).
          landedRef.current = true;
        }
      }
      if (Date.now() < quietUntilRef.current) return;
      if (awaitingLandingRef.current) {
        // Without a landing, the report is the bottom of the chat (where the newest rows are) and
        // would mark every unread row as read; skip it until the reader moves.
        if (!landedRef.current && (viewedSeq === null || viewedSeq >= latestRef.current.newest))
          return;
        awaitingLandingRef.current = false;
      }
      landedRef.current = false;
      record(viewedSeq, latestRef.current.epoch, latestRef.current.title);
    },
    [record, stored],
  );

  // The jump request is measured once the view has had time to apply it (history fetched for a row
  // that is not loaded arrives later). Nothing is recorded until then, so an estimate taken late
  // cannot be mistaken for the reader scrolling.
  useEffect(() => {
    if (!isWeb) return;
    const request = requestAtRef.current;
    if (request === null) return;
    const timer = setTimeout(
      () => {
        if (requestAtRef.current !== request) return;
        estimateRef.current = lastTopRef.current;
        estimateStampRef.current = "jump";
      },
      Math.max(0, request + LANDING_GRACE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [fetchedFor, stored]);

  // A jump the view cannot tell apart from the bottom (every unread row fits on one screen) still
  // counts as landed once the quiet moment is over. The timer is scheduled from the restore itself:
  // counting from when the chat was opened would fire it inside the quiet window, where the report
  // is dropped and nothing else would ever wake the record up.
  useEffect(() => {
    if (!isWeb || settleAt === null) return;
    const epoch = timelineEpoch;
    const timer = setTimeout(
      () => {
        if (!restoredRef.current || !awaitingLandingRef.current) return;
        if (currentKeyRef.current !== key || latestRef.current.epoch !== epoch) return;
        const top = lastTopRef.current;
        const estimate = estimateRef.current;
        const firstUnread = firstUnreadRef.current;
        const landed =
          landedRef.current ||
          (top !== null &&
            (firstUnread !== null && top <= firstUnread
              ? true
              : estimate !== null && top !== estimate));
        // Never take "still at the bottom" for a landing: a jump that failed leaves the view there,
        // and recording it would mark every unread row as read.
        if (!landed) return;
        awaitingLandingRef.current = false;
        landedRef.current = false;
        record(lastViewedRef.current, epoch, latestRef.current.title);
      },
      Math.max(0, settleAt + 100 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [settleAt, key, timelineEpoch, record]);

  // Only the current chat and history's divider counts; one remembered from before must not show.
  const unreadFromSeq =
    unreadFrom !== null && unreadFrom.key === key && unreadFrom.epoch === timelineEpoch
      ? unreadFrom.seq
      : null;
  unreadFromSeqRef.current = unreadFromSeq;

  // Rows loaded while the view is at the bottom move it there, not the reader: remember that the
  // next report may be caused by loading.
  const loadedForEstimate = loadedSeqs.length;
  useEffect(() => {
    if (estimateStampRef.current === "jump") estimateStampRef.current = "load";
    // Only loading more rows matters here, not which row is the newest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedForEstimate]);

  return useMemo(() => ({ reportViewedSeq, unreadFromSeq }), [reportViewedSeq, unreadFromSeq]);
}
