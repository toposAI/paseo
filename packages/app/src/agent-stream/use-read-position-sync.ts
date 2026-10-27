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
// A restore with no rows attached yet cannot scroll anywhere: it asks again once rows are in.
const RESTORE_JUMP_ROUNDS = 1;
// Opening a thread before the daemon connection is up makes the first fetch fail: ask again.
const FETCH_RETRIES = 3;
const FETCH_RETRY_MS = 1000;
// Jumps per restore: the first jump, then one more for the older history it missed.
const MAX_RESTORE_JUMPS = 2;
// Rows attached by the time the restore asks for its jump: fewer means the chat is still empty.
// Landing is the view being scrolled around the restored row close to when it was asked for; the
// fetch for a row that is not loaded yet usually takes longer than this.
const LANDING_GRACE_MS = 1000;
const READER_SCROLL_INPUTS = ["wheel", "touchmove", "pointerdown"] as const;
// Keys that move the view (a mouse click or a focus move does not); typing in a box is not reading
// the chat either.
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);
const EDITABLE_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** The chat's own scrolling box, or null when the page is still loading (or is not a page at all). */
function scrollBox(): Element | null {
  if (typeof document === "undefined") return null;
  return document.querySelector('[data-testid="agent-chat-scroll"]');
}

interface Input {
  serverId: string;
  agentId: string;
  timelineEpoch: string | null;
  items: readonly StreamItem[];
  jumpToSeq: (seq: number) => void;
}

/** The page is open but not connected yet: not the daemon's answer, so worth asking again. */
function clientUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === "no client";
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
  // Null until the daemon has answered. Without that answer there is no stored row to have landed at
  // yet, and the bottom of the chat (where it opens) would otherwise count as where the reader is.
  const [storedLoaded, setStoredLoaded] = useState(false);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [fetchAttempt, setFetchAttempt] = useState(0);
  // Clears the once-per-chat guard so the effect below asks for the record again.
  const askAgain = useCallback(() => {
    fetchStartedForRef.current = null;
    setFetchAttempt((attempt) => attempt + 1);
  }, []);
  // The "ここから未読" divider: dropped once the reader has seen everything that existed at open.
  // It belongs to the history it was picked from, so a new epoch neither shows nor reuses it.
  const [unreadFrom, setUnreadFrom] = useState<{ key: string; epoch: string; seq: number } | null>(
    null,
  );
  const dismissAtRef = useRef<number | null>(null);
  const restoredRef = useRef(false);

  const awaitingLandingRef = useRef(false);
  const landedRef = useRef(false);
  // A chat that opens where it was last left (the bottom) shows its newest row without the reader
  // having read it: the first record waits until the view actually moves.
  const mustMoveRef = useRef(false);
  // The rows on top and at the bottom where the chat opened.
  const restTopRef = useRef<number | null>(null);
  const restViewedRef = useRef<number | null>(null);
  // The reader's own scrolling, as input rather than rows moving: rows also move from a resize, a
  // rotation, loading, and the chat following new messages while nobody is at the screen.
  const readerMovedRef = useRef(false);
  // Whether the reader has scrolled since the chat opened: no re-jump for the restore after that.
  const readerTookOverRef = useRef(false);
  // What the chat had loaded when the reader last scrolled: rows that arrived after that were never
  // on screen while the reader was there, so a report taken later (a resize, coming back to the page)
  // must not carry them into the record.
  const inputBaseRef = useRef<number | null>(null);
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
  const [jumpRequest, setJumpRequest] = useState(0);
  const historyFetchCountRef = useRef(0);
  // Whether the jump to the stored row has been asked for with the rows already in place, and which
  // row it goes to.
  const restoredJumpsRef = useRef(0);
  const pendingRestoreRef = useRef<number | null>(null);
  const lastOldestSeenRef = useRef<number | null>(null);
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
  // A new history keeps the fetched record (it is per chat, and the epoch it was written under is
  // checked when it is used), so only the state that belongs to the old history goes.
  useEffect(() => {
    setSettleAt(null);
    restoredRef.current = false;
    awaitingLandingRef.current = false;
    landedRef.current = false;
    mustMoveRef.current = false;
    restTopRef.current = null;
    restViewedRef.current = null;
    readerMovedRef.current = false;
    readerTookOverRef.current = false;
    inputBaseRef.current = null;
    quietUntilRef.current = 0;
    highWaterRef.current = null;
    pendingRef.current = null;
    lastViewedRef.current = null;
    lastTopRef.current = null;
    firstUnreadRef.current = null;
    estimateRef.current = null;
    estimateStampRef.current = null;
    requestAtRef.current = null;
    setJumpRequest(0);
    historyFetchCountRef.current = 0;
    restoredJumpsRef.current = 0;
    pendingRestoreRef.current = null;
    lastOldestSeenRef.current = null;
    dismissAtRef.current = null;
    setUnreadFrom(null);
    if (!isWeb) return;
    const markReader = () => {
      readerMovedRef.current = true;
      readerTookOverRef.current = true;
      // What was loaded at this moment is what the reader can have seen; anything newer is out.
      inputBaseRef.current = latestRef.current.newest >= 0 ? latestRef.current.newest : null;
    };
    const onReaderScroll = (event: Event) => {
      const box = scrollBox();
      const target = event.target;
      if (
        event.type === "pointerdown" &&
        !(box !== null && target instanceof Node && box.contains(target))
      ) {
        return;
      }
      markReader();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      const target = event.target;
      if (target instanceof Element && target.closest(EDITABLE_SELECTOR)) return;
      markReader();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        sendPending();
        return;
      }
      // Back looking at the page: the chat may have followed rows on its own while it was away, and
      // the view is not the reader's until it moves again. But coming back is not moving the view, so
      // a restore still waiting for its rows keeps waiting for them.
      readerMovedRef.current = false;
      mustMoveRef.current = true;
      restTopRef.current = null;
      restViewedRef.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    // The page is a web app, so these are the reader's own moving. A resize or a rotation fires none of
    // them, and neither does the chat following new rows. Registered before the record is fetched, so
    // a scroll made while it is on its way still counts.
    for (const type of READER_SCROLL_INPUTS) {
      document.addEventListener(type, onReaderScroll, { capture: true, passive: true });
    }
    document.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of READER_SCROLL_INPUTS) {
        document.removeEventListener(type, onReaderScroll, { capture: true });
      }
      document.removeEventListener("keydown", onKeyDown, { capture: true });
      sendPending();
    };
  }, [key, timelineEpoch, sendPending]);

  // A new chat (not a new history) also drops the fetched record so it is asked for again.
  useEffect(() => {
    fetchStartedForRef.current = null;
    setFetchAttempt(0);
    setStored(null);
    setStoredLoaded(false);
    setFetchedFor(null);
  }, [key]);

  // The default-on rule reads the title, so ask once it is known (and only once per chat).
  useEffect(() => {
    if (!isWeb || !titleReady || fetchStartedForRef.current === key) return;
    fetchStartedForRef.current = key;
    const retries = fetchAttempt;
    invoke(serverId, "topos.readpos.get", {
      agentId,
      title: latestRef.current.title ?? undefined,
    })
      .then((out) => {
        if (currentKeyRef.current !== key) return false;
        setStored(parseStored(out));
        setStoredLoaded(true);
        setFetchedFor(key);
        return true;
      })
      .catch((error: unknown) => {
        if (currentKeyRef.current !== key) return;
        // A page that has just opened may not be connected yet: a failure that was not the daemon's
        // answer is asked for again. Treating it as "nothing to resume" would open the chat at the
        // bottom and record that as read.
        if (clientUnavailable(error) && retries < FETCH_RETRIES) {
          setTimeout(
            () => {
              if (currentKeyRef.current === key) askAgain();
            },
            FETCH_RETRY_MS * (retries + 1),
          );
          return;
        }
        // No record could be fetched: treat it as "nothing to resume", so reading is still recorded.
        setStoredLoaded(true);
        setFetchedFor(key);
      });
    // The attempt number only re-runs the request; a new chat is caught by the guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, titleReady, serverId, agentId, fetchAttempt]);

  const jump = useStableEvent(jumpToSeq);

  // The reader stopped before the oldest loaded row: the rows in between are missing, so a divider
  // here would sit under a gap and silently skip them. Pull that part of the history and decide
  // again once it is here. Progress means the oldest loaded row moved down; rows arriving at the
  // bottom are not progress. With no progress (the row is gone) or after too many fetches, the
  // jump is not trusted: the record waits for the reader to move instead of marking everything read.
  const restoreAfterHistory = useCallback(
    (storedSeq: number, oldestLoaded: number) => {
      const seen = lastOldestSeenRef.current;
      if (historyFetchCountRef.current >= MAX_HISTORY_FETCHES || seen === oldestLoaded) {
        // No progress: the stored row is gone. Leave the chat as it is (no divider) and keep reading
        // from where the record already is; recording from here would start over from the bottom.
        awaitingLandingRef.current = false;
        restoredRef.current = true;
        highWaterRef.current = storedSeq;
        mustMoveRef.current = true;
        return;
      }
      lastOldestSeenRef.current = oldestLoaded;
      historyFetchCountRef.current += 1;
      jump(storedSeq);
    },
    [jump],
  );

  useEffect(() => {
    if (!isWeb || !storedLoaded || fetchedFor !== key || restoredRef.current) return;
    if (loadedSeqs.length === 0 || timelineEpoch === null) return;
    const oldestLoaded = loadedSeqs.reduce((m, s) => (s < m ? s : m), Number.POSITIVE_INFINITY);
    const storedSeq =
      stored?.enabled === true && stored.epoch === timelineEpoch ? stored.seq : null;
    if (storedSeq !== null && storedSeq < oldestLoaded) {
      restoreAfterHistory(storedSeq, oldestLoaded);
      return;
    }
    restoredRef.current = true;
    if (stored?.enabled && stored.epoch === timelineEpoch && stored.seq !== null) {
      highWaterRef.current = stored.seq;
    }
    const pick = pickResume({ stored, timelineEpoch, loadedSeqs });
    if (pick === null) {
      // Nothing to resume: the chat stays at the bottom. Its newest row is on screen, but the reader
      // has not been there yet — the record waits until the view moves.
      mustMoveRef.current = true;
      return;
    }
    awaitingLandingRef.current = true;
    quietUntilRef.current = Date.now() + POST_RESTORE_QUIET_MS;
    setSettleAt(quietUntilRef.current);
    dismissAtRef.current = pick.newestSeq;
    firstUnreadRef.current = pick.firstUnreadSeq;
    setUnreadFrom({ key, epoch: timelineEpoch, seq: pick.firstUnreadSeq });
    requestAtRef.current = Date.now();
    // A fresh page attaches the chat before its rows are in: with nothing to scroll to, the jump
    // below finds no row. Remember it, and ask again once the rows are there (see the effect under
    // it) — the chat would otherwise open at the bottom.
    pendingRestoreRef.current = pick.restoreSeq;
    restoredJumpsRef.current = loadedSeqs.length >= RESTORE_JUMP_ROUNDS ? 1 : 0;
    // Each restore gets a fresh number, so the measuring timer below is armed again (even when the
    // new history restores at the same row as the old one).
    setJumpRequest((request) => request + 1);
    jump(pick.restoreSeq);
  }, [fetchedFor, key, loadedSeqs, stored, storedLoaded, timelineEpoch, jump, restoreAfterHistory]);
  // The record is the last row the view showed in full (see read-position-sync.ts); `epoch`/`title`
  // are the ones it was shown under.
  const record = useCallback(
    (viewedSeq: number | null, epoch: string | null, seenUnder: string | null) => {
      if (Date.now() < quietUntilRef.current) return;
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

  // Whether this report shows the view at (or above) the row the stored position was restored to.
  const looksLanded = useCallback((topSeq: number | null) => {
    const estimate = estimateRef.current;
    if (topSeq === null) return false;
    if (firstUnreadRef.current !== null && topSeq <= firstUnreadRef.current) {
      // The view sits at or above the first unread row: the jump landed, whatever the newest row is.
      return true;
    }
    if (estimateStampRef.current === "load") {
      // Rows still being loaded can move the view without the reader: not a landing.
      estimateStampRef.current = null;
      return false;
    }
    // The view moved up, away from the bottom the chat starts at: the reader scrolled, or the jump
    // took effect. Moving down is what a chat left at the bottom does on its own.
    return estimate !== null && topSeq < estimate;
  }, []);

  // Whether the view has left the row the chat opened at, by the reader: rows moving on their own
  // (a resize, a rotation, news arriving) leave the opening rule in place. Once the reader has moved
  // the view, it stays off for the rest of this chat unless the page is left and come back to.
  const leftOpeningSpot = useCallback(
    (
      viewedSeq: number | null,
      topSeq: number | null,
      prevTop: number | null,
      readerHere: boolean,
    ): boolean => {
      if (!mustMoveRef.current) return true;
      if (restTopRef.current === null) {
        // The view had not been measured when the chat opened (or has not been measured yet).
        restTopRef.current = topSeq;
        restViewedRef.current = viewedSeq;
        return false;
      }
      const moved =
        topSeq !== null && topSeq !== restTopRef.current && viewedSeq !== restViewedRef.current;
      // The view is off the opening spot, or arrived at the edge of it from the newest row: either
      // way the reader brought it there with the input just made.
      if (
        !moved &&
        !(prevTop === restTopRef.current && topSeq !== null && topSeq < restTopRef.current)
      ) {
        return false;
      }
      if (!readerHere) return false;
      mustMoveRef.current = false;
      restTopRef.current = null;
      restViewedRef.current = null;
      return true;
    },
    [],
  );

  // Settling means the view stopped where it started: the opening spot (older rows are not loaded
  // yet, so they must not count as read) or a jump that put the reader at or above the first unread
  // row. Rows that loaded under the reader are not read by being on screen.
  const settledWithoutReading = useCallback(
    (viewed: number | null) => {
      const stamp = estimateStampRef.current;
      estimateStampRef.current = null;
      const estimate = estimateRef.current;
      if (leftOpeningSpot(viewed, null, null, true)) return true;
      if (stamp !== "jump" || estimate === null || viewed === null) return false;
      return (
        viewed <= estimate && (firstUnreadRef.current === null || viewed <= firstUnreadRef.current)
      );
    },
    [leftOpeningSpot],
  );

  const reportViewedSeq = useCallback(
    (viewedSeq: number | null, topSeq: number | null = null) => {
      // Until the stored record has been applied, the bottom of the chat would overwrite it.
      if (!isWeb || !storedLoaded || !restoredRef.current || !stored?.enabled) return;
      // A page that is not being looked at cannot be read (a phone left in a pocket, a tab in the
      // background); its rows keep arriving and keep moving the view.
      if (document.visibilityState === "hidden") return;
      const prevViewed = lastViewedRef.current;
      const prevTop = lastTopRef.current;
      lastViewedRef.current = viewedSeq;
      lastTopRef.current = topSeq;
      // The landing is only remembered here; recording still waits for the quiet moment.
      if (awaitingLandingRef.current && looksLanded(topSeq)) landedRef.current = true;
      if (Date.now() < quietUntilRef.current) return;
      // A report that shows the divider (or above it) while the view sat below it was not the bottom
      // at open, whatever its timing: the view can only be there because it moved, so it is the
      // reader's. It lasts as long as the view stays above the divider and lapses once it is back
      // below, so news arriving while nobody is at the screen is not read by it.
      const aboveDivider = (seq: number | null) =>
        seq !== null && firstUnreadRef.current !== null && seq <= firstUnreadRef.current;
      const readerHere =
        readerMovedRef.current || (aboveDivider(viewedSeq) && !aboveDivider(prevViewed));
      // The rows moving is not the reader reading: they also move when the chat follows new messages
      // while nobody is at the screen. Where the chat opened is not where the reader has read to
      // either: the record waits until the view leaves it.
      const leftSpot = leftOpeningSpot(viewedSeq, topSeq, prevTop, readerHere);
      if (awaitingLandingRef.current) {
        // Without a landing, the report is the bottom of the chat (where the newest rows are) and
        // would mark every unread row as read; skip it until the reader moves. When the stored row
        // could not be brought into view at all, every report is this case: the record waits rather
        // than going past rows that were never shown.
        if (!landedRef.current) return;
        awaitingLandingRef.current = false;
      }
      // The divider is about what existed when the chat opened, not about the record: it goes as soon
      // as the reader has been shown that far, even when reading is not recorded yet.
      if (shouldDismissUnreadDivider(viewedSeq, dismissAtRef.current)) {
        setUnreadFrom((current) => (current?.key === key ? null : current));
      }
      if (!readerHere || !leftSpot) return;
      // Rows that arrived after the reader's last scroll were never on screen while the reader was
      // there (the chat follows new rows on its own): they are not read by the report that sees them.
      const base = inputBaseRef.current;
      landedRef.current = false;
      record(
        viewedSeq !== null && base !== null ? Math.min(viewedSeq, base) : viewedSeq,
        latestRef.current.epoch,
        latestRef.current.title,
      );
    },
    [key, leftOpeningSpot, looksLanded, record, stored, storedLoaded],
  );

  // The first jump runs against rows already on screen, but those may be only the tail: a direct
  // link mounts the thread before its older history arrives. So the next rows to show up get one
  // more jump, even when the first one did something — a page that is rebuilt later (direct link,
  // then the workspace tab) starts from the bottom again.
  const hasRows = loadedSeqs.length >= RESTORE_JUMP_ROUNDS;
  const rowsBefore = useRef<{ key: string | null; count: number } | null>(null);
  useEffect(() => {
    if (!isWeb || !restoredRef.current || !hasRows) return;
    const seq = pendingRestoreRef.current;
    if (seq === null) return;
    // The reader has scrolled since the last jump: rows arriving now (older history, or the
    // rebuilt page's tail) must not yank the view back to the record.
    if (readerTookOverRef.current) {
      pendingRestoreRef.current = null;
      return;
    }
    const before = rowsBefore.current;
    const grew = before !== null && before.key === key && loadedSeqs.length > before.count;
    rowsBefore.current = { key, count: loadedSeqs.length };
    if (restoredJumpsRef.current > 0 && !grew) return;
    restoredJumpsRef.current += 1;
    if (restoredJumpsRef.current >= MAX_RESTORE_JUMPS) pendingRestoreRef.current = null;
    jump(seq);
  }, [hasRows, loadedSeqs.length, key, jump]);

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
    // Re-armed per jump request: the record arriving for the chat is not the moment to measure.
  }, [jumpRequest]);

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
              : // Up, away from the bottom; down is what the bottom does on its own when news
                // arrives, and a failed jump leaves the view there.
                estimate !== null && top < estimate));
        if (!landed) return;
        awaitingLandingRef.current = false;
        landedRef.current = false;
        // The rows on screen are not read by being on screen: the record only moves once the reader
        // has scrolled. The divider still goes once the newest row at open has been reached.
        if (shouldDismissUnreadDivider(lastViewedRef.current, dismissAtRef.current)) {
          setUnreadFrom((current) => (current?.key === key ? null : current));
        }
        const base = inputBaseRef.current;
        const viewed = lastViewedRef.current;
        const stoppedAt = settledWithoutReading(viewed);
        if (!stoppedAt) return;
        record(
          viewed !== null && base !== null ? Math.min(viewed, base) : viewed,
          epoch,
          latestRef.current.title,
        );
      },
      Math.max(0, settleAt + 100 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [settleAt, key, timelineEpoch, record, settledWithoutReading]);

  // Only the current chat and history's divider counts; one remembered from before must not show.
  const unreadFromSeq =
    unreadFrom !== null && unreadFrom.key === key && unreadFrom.epoch === timelineEpoch
      ? unreadFrom.seq
      : null;

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
