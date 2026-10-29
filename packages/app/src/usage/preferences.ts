import { UsageReportSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { displayPercent } from "./model";
import type { AvailableUsageReport, UsageReportEntry, UsageWindow } from "./types";

/** Whether percentages read as the share used or the share left. */
export type UsageDisplayAs = "used" | "remaining";

/** A window the user pinned to the sidebar Usage item. It matches every account of the source. */
export interface UsagePin {
  sourceId: string;
  windowId: string;
}

/**
 * A report as one account last answered, kept on the device. The sidebar shows it dimmed while the
 * account cannot answer, so a lapsed login leaves the last numbers in place instead of nothing.
 */
export interface UsageLastGood {
  id: string;
  sourceId: string;
  fetchedAt: string;
  report: AvailableUsageReport;
}

/** Past this, the last numbers are too old to stand in for the current ones. */
export const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60_000;
// The same limit holds where the server keeps its own stand-in for a transient failure; see
// LAST_GOOD_MAX_AGE_MS in packages/server/src/server/plugins/usage-sources/index.ts.

/** Device-local. `pins` is in selection order. */
export interface UsagePreferences {
  displayAs: UsageDisplayAs;
  /** null follows source defaults; an array is the user's selection, including none. */
  pins: UsagePin[] | null;
  /** The host the user picked to show usage for; null until they pick one. */
  serverId: string | null;
  /** Report IDs in the order the user arranged them; reports not listed follow, sorted. */
  order?: string[];
  /** The latest report each account answered with, per host; see `rememberLastGood`. */
  lastGoodByHost: Record<string, UsageLastGood[]>;
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  displayAs: "used",
  pins: null,
  serverId: null,
  lastGoodByHost: {},
};

const pinsSchema = z.array(z.object({ sourceId: z.string(), windowId: z.string() }));

const lastGoodEntrySchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  fetchedAt: z.string(),
  report: UsageReportSchema,
});

/**
 * Read leniently and check here: an entry the schema cannot read is dropped rather than taking the
 * whole preferences with it.
 */
const lastGoodSchema = z
  .array(z.unknown())
  .nullable()
  .catch(null)
  .transform((entries): UsageLastGood[] | undefined => {
    const kept = (entries ?? []).flatMap((raw) => {
      const parsed = lastGoodEntrySchema.safeParse(raw);
      const entry = parsed.success ? parsed.data : undefined;
      return entry && entry.report.status === "available"
        ? [
            {
              id: entry.id,
              sourceId: entry.sourceId,
              fetchedAt: entry.fetchedAt,
              report: entry.report,
            },
          ]
        : [];
    });
    return kept.length > 0 ? kept : undefined;
  });

/** Each host's list read the same lenient way; a host whose list cannot be read keeps no copies. */
const lastGoodByHostSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .catch(undefined)
  .transform((hosts): Record<string, UsageLastGood[]> => {
    const kept: Record<string, UsageLastGood[]> = {};
    for (const [serverId, raw] of Object.entries(hosts ?? {})) {
      const parsed = lastGoodSchema.safeParse(raw);
      const entries = parsed.success ? parsed.data : undefined;
      if (entries) kept[serverId] = entries;
    }
    return kept;
  });

export const UsagePreferencesSchema = z
  .object({
    displayAs: z.enum(["used", "remaining"]).catch("used"),
    pins: pinsSchema.nullable().optional().catch(null),
    // COMPAT(usagePinSelection): added in v0.11, remove after 2027-04-02.
    // Old [] meant defaults. Read it only when the new selection is absent.
    pinned: pinsSchema.optional().catch([]),
    serverId: z.string().nullable().catch(null),
    order: z.array(z.string()).optional().catch(undefined),
    lastGoodByHost: lastGoodByHostSchema,
  })
  .transform(({ displayAs, pins, pinned, serverId, order, lastGoodByHost }): UsagePreferences => {
    const legacyPins = pinned && pinned.length > 0 ? pinned : null;
    const base: UsagePreferences = {
      displayAs,
      pins: pins === undefined ? legacyPins : pins,
      serverId,
      lastGoodByHost,
    };
    return {
      ...base,
      ...(order ? { order } : {}),
    };
  })
  .catch(DEFAULT_USAGE_PREFERENCES);

function samePin(a: UsagePin, b: UsagePin): boolean {
  return a.sourceId === b.sourceId && a.windowId === b.windowId;
}

function fetchedTime(entry: { fetchedAt: string }): number {
  return Date.parse(entry.fetchedAt);
}

/** Whether an entry was fetched at or after the cutoff. */
function isFresh(entry: { fetchedAt: string }, now: Date): boolean {
  const fetchedAt = fetchedTime(entry);
  return Number.isFinite(fetchedAt) && fetchedAt > now.getTime() - LAST_GOOD_MAX_AGE_MS;
}

/** Entries with one per id: the later fetched wins, ties keeping the incoming copy. */
function mergeById(
  existing: readonly UsageLastGood[],
  incoming: readonly UsageLastGood[],
): UsageLastGood[] {
  const merged = [...existing];
  for (const entry of incoming) {
    const index = merged.findIndex((current) => current.id === entry.id);
    if (index === -1) {
      merged.push(entry);
    } else if (fetchedTime(entry) >= fetchedTime(merged[index]!)) {
      merged[index] = entry;
    }
  }
  return merged;
}

/** JSON with object keys in a fixed order, so two copies compare by value rather than by shape. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withHostLastGood(
  preferences: UsagePreferences,
  serverId: string,
  entries: UsageLastGood[] | undefined,
): UsagePreferences {
  const hosts = { ...preferences.lastGoodByHost };
  if (entries) hosts[serverId] = entries;
  else delete hosts[serverId];
  return { ...preferences, lastGoodByHost: hosts };
}

/**
 * The preferences with each available report of one host kept as its account's last good copy.
 * Copies older than `LAST_GOOD_MAX_AGE_MS` are dropped, and other hosts' copies are left alone.
 * Nothing changes (the same object comes back) when the kept copies already match, so saving the
 * result can never loop.
 */
export function rememberLastGood(
  preferences: UsagePreferences,
  serverId: string,
  reports: readonly UsageReportEntry[],
  now: Date = new Date(),
): UsagePreferences {
  const available: UsageLastGood[] = reports.flatMap((entry) =>
    entry.report.status === "available"
      ? [
          {
            id: entry.id,
            sourceId: entry.sourceId,
            fetchedAt: entry.fetchedAt,
            report: entry.report,
          },
        ]
      : [],
  );
  // Each host keeps its own list, so a host that stops reporting keeps its numbers and other
  // hosts' copies survive a lapse here. Copies older than a day are dropped everywhere they are
  // met, so a host the user never opens again does not keep them for good.
  const pruned = pruneLastGood(preferences, now);
  const after = mergeById(
    (pruned.lastGoodByHost[serverId] ?? []).filter((entry) => isFresh(entry, now)),
    available,
  );
  // Compare as stored: a copy read back from settings lacks the fields the schema drops, and the
  // same numbers are not worth a write.
  const settled = (entries: readonly UsageLastGood[]) =>
    canonical(
      [...entries]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, sourceId, fetchedAt, report }) => [
          id,
          sourceId,
          fetchedAt,
          report.planLabel,
          report.windows,
          report.balances,
          report.details,
        ]),
    );
  const before = preferences.lastGoodByHost[serverId] ?? [];
  if (settled(before) === settled(after) && pruned === preferences) return preferences;
  return withHostLastGood(pruned, serverId, after.length > 0 ? after : undefined);
}

/** Drops every host's copies older than `LAST_GOOD_MAX_AGE_MS`, so they do not pile up. */
function pruneLastGood(preferences: UsagePreferences, now: Date): UsagePreferences {
  let next = preferences;
  for (const [serverId, entries] of Object.entries(preferences.lastGoodByHost)) {
    const fresh = entries.filter((entry) => isFresh(entry, now));
    if (fresh.length !== entries.length)
      next = withHostLastGood(next, serverId, fresh.length > 0 ? fresh : undefined);
  }
  return next;
}

/** The preferences with every stale kept copy dropped, as saving them should leave them. */
export function withoutStaleLastGood(
  preferences: UsagePreferences,
  now: Date = new Date(),
): UsagePreferences {
  return pruneLastGood(preferences, now);
}

/** The last good copies one host's reports left, newest first. */
export function resolveLastGood(
  preferences: UsagePreferences,
  serverId: string | null,
  now: Date = new Date(),
): UsageLastGood[] {
  const entries = serverId === null ? [] : (preferences.lastGoodByHost[serverId] ?? []);
  return entries
    .filter((entry) => isFresh(entry, now))
    .sort((a, b) => fetchedTime(b) - fetchedTime(a));
}

/** The default pins of one source: its marked summary windows, else its first one with a percent. */
function defaultPins(
  sourceId: string,
  windows: readonly UsageWindow[],
  displayAs: UsageDisplayAs,
  pins: UsagePin[],
): void {
  const withPercent = windows.filter((window) => displayPercent(window, displayAs) !== null);
  const marked = withPercent.filter((window) => window.summary);
  for (const window of marked.length > 0 ? marked : withPercent.slice(0, 1)) {
    const pin = { sourceId, windowId: window.id };
    if (!pins.some((existing) => samePin(existing, pin))) pins.push(pin);
  }
}

/**
 * The only owner of default and customized pin selection, shared by every usage surface. A source
 * that cannot answer keeps the windows it pinned when it last answered.
 */
export function effectiveUsagePins(
  preferences: UsagePreferences,
  reports: readonly UsageReportEntry[],
  lastGood: readonly UsageLastGood[] = [],
): UsagePin[] {
  if (preferences.pins !== null) return preferences.pins;
  const pins: UsagePin[] = [];
  const answering = new Set<string>();
  for (const entry of reports) {
    if (entry.report.status !== "available") continue;
    answering.add(entry.sourceId);
    defaultPins(entry.sourceId, entry.report.windows, preferences.displayAs, pins);
  }
  for (const entry of lastGood) {
    if (answering.has(entry.sourceId)) continue;
    defaultPins(entry.sourceId, entry.report.windows, preferences.displayAs, pins);
  }
  return pins;
}

export function isUsagePinned(
  preferences: UsagePreferences,
  pin: UsagePin,
  reports: readonly UsageReportEntry[],
  lastGood: readonly UsageLastGood[] = [],
): boolean {
  return effectiveUsagePins(preferences, reports, lastGood).some((pinned) => samePin(pinned, pin));
}

/** The first edit snapshots the displayed defaults before toggling one window. */
export function toggleUsagePin({
  preferences,
  pin,
  reports,
  lastGood = [],
}: {
  preferences: UsagePreferences;
  pin: UsagePin;
  reports: readonly UsageReportEntry[];
  lastGood?: readonly UsageLastGood[];
}): UsagePreferences {
  const selected = effectiveUsagePins(preferences, reports, lastGood);
  const pins = selected.some((existing) => samePin(existing, pin))
    ? selected.filter((existing) => !samePin(existing, pin))
    : [...selected, { sourceId: pin.sourceId, windowId: pin.windowId }];
  return { ...preferences, pins };
}

export function setUsageDisplayAs(
  preferences: UsagePreferences,
  displayAs: UsageDisplayAs,
): UsagePreferences {
  return { ...preferences, displayAs };
}

export function setUsageHost(preferences: UsagePreferences, serverId: string): UsagePreferences {
  return { ...preferences, serverId };
}

export function setUsageOrder(preferences: UsagePreferences, order: string[]): UsagePreferences {
  return { ...preferences, order };
}
