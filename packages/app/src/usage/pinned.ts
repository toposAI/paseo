import { formatCompactTimeAgo, formatCompactTimeAgoAsProse } from "@/utils/time";
import { usageCopy } from "./copy";
import { formatPct } from "./format";
import { displayPercent } from "./model";
import {
  DEFAULT_USAGE_PREFERENCES,
  effectiveUsagePins,
  resolveLastGood,
  type UsagePin,
  type UsagePreferences,
} from "./preferences";
import { windowTone } from "./tone";
import type { AvailableUsageReport, UsageReportEntry, UsageTone, UsageWindow } from "./types";

/** One summary window of one account, as the sidebar Usage item shows it. */
export interface PinnedUsageWindow {
  key: string;
  /** Accessible description, including the source, account, window and percent meaning. */
  label: string;
  /** The window's short name ("5h"), empty for none, or its label when the source sends none. */
  shortLabel: string;
  /** The share shown, under the user's used/remaining preference. */
  percent: number;
  percentText: string;
  tone: UsageTone;
  /** True for the last good numbers shown while the account cannot answer. */
  stale?: boolean;
}

/** One account's summary windows, under its source's icon. */
export interface PinnedUsageSource {
  key: string;
  /** The provider the account belongs to; the report ID alone cannot say once it is gone. */
  sourceId?: string;
  icon: string | null;
  windows: PinnedUsageWindow[];
  /** Set when every window here is the account's last good copy, fetched this long ago. */
  staleAgo?: string;
}

/**
 * Past this, numbers the host still calls current are marked as old. The host re-reads upstream
 * about every four minutes, and its own stand-in for a transient failure is served as "available"
 * under an old `fetchedAt`, so anything much older than a few re-reads is not live.
 */
export const STALE_REPORT_AGE_MS = 15 * 60_000;

/** How much of each window the one-line summary has room for. */
/** Same short names on every provider row: "5 hour" / "Session" -> "5h", "Weekly" -> "wk". */ export function normalizeShortLabel(
  label: string,
): string {
  const trimmed = label.trim();
  if (/^(5\s*h(ours?)?|session)$/i.test(trimmed)) return "5h";
  if (/^(wk|week(ly)?)$/i.test(trimmed)) return "wk";
  return trimmed;
}

export type PinnedUsageLayout = "meters" | "labels" | "percents";

// A meter narrower than this is a sliver that reads as noise rather than a share.
export const MIN_METER_WIDTH = 16;
/** The space between a meter and its text. */
export const METER_GAP = 4;

/**
 * The richest layout that fits on one line: every window's meter, else its short label, else its
 * percent alone. Meters are all or none; a line never mixes them. Until the widths are known it
 * shows labels, which never flashes meters that turn out not to fit.
 */
export function choosePinnedUsageLayout(input: {
  available: number | null;
  labelsWidth: number | null;
  percentsWidth: number | null;
  windowCount: number;
}): PinnedUsageLayout {
  const { available, labelsWidth, percentsWidth, windowCount } = input;
  if (available === null || labelsWidth === null || percentsWidth === null) return "labels";
  if (labelsWidth + windowCount * (MIN_METER_WIDTH + METER_GAP) <= available) return "meters";
  if (labelsWidth <= available) return "labels";
  return percentsWidth < labelsWidth ? "percents" : "labels";
}

function describe(entry: UsageReportEntry, windowLabel: string): string {
  const account = entry.account.label ? ` (${entry.account.label})` : "";
  return `${entry.sourceLabel}${account} ${windowLabel}`;
}

/** Reports with every account of a source together, sources in the order they first appear. */
function groupBySource(reports: readonly UsageReportEntry[]): UsageReportEntry[] {
  const sourceIds = [...new Set(reports.map((entry) => entry.sourceId))];
  return sourceIds.flatMap((sourceId) => reports.filter((entry) => entry.sourceId === sourceId));
}

/**
 * One line of the sidebar summary. Every provider gets its own line so a slow or failing source
 * never blanks the others: Claude first, then OpenCode Go.
 */
export interface PinnedUsageRow {
  key: "claude" | "opencode-go";
  title: string;
  sources: PinnedUsageSource[];
  /** Why the line has numbers missing or kept from before; null while everything is current. */
  problem?: string | null;
}

/** Which line an account belongs to, by the provider its report is under. */
const USAGE_ROWS: readonly {
  key: PinnedUsageRow["key"];
  title: string;
  matches: (id: string) => boolean;
}[] = [
  { key: "claude", title: "Claude", matches: (id) => id === "claude" },
  { key: "opencode-go", title: "OpenCode Go", matches: (id) => id.startsWith("opencode") },
];

/**
 * Splits the summary into provider lines. Each line keeps the order `resolvePinnedUsage` gave it;
 * lines with nothing pinned are dropped rather than shown empty, and so is a line that has never
 * reported at all. A line whose accounts cannot answer keeps its place with `problem`, so a lapsed
 * login never makes it vanish.
 *
 * A line with no numbers at all only carries `problem` for a provider the user has pins for, so
 * unpinning a provider hides it even while it fails.
 */
export function splitPinnedUsageRows(
  sources: readonly PinnedUsageSource[],
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences = DEFAULT_USAGE_PREFERENCES,
): PinnedUsageRow[] {
  const sourceIdByReportId = new Map(reports.map((entry) => [entry.id, entry.sourceId]));
  const reportedIds = new Set(reports.map((entry) => entry.id));
  return USAGE_ROWS.flatMap((row) => {
    const rowSources = sources
      .filter((source) => {
        const sourceId = source.sourceId ?? sourceIdByReportId.get(source.key);
        return sourceId !== undefined && row.matches(sourceId);
      })
      // The sidebar shows the 5h and weekly windows; other windows stay in the modal. A source that
      // pins only another one (OpenCode Go pins its monthly budget) keeps what it pinned, so it
      // still gets a line instead of dropping out of the summary entirely.
      .map((source) => {
        const brief = source.windows.filter((w) => w.shortLabel === "5h" || w.shortLabel === "wk");
        return {
          key: source.key,
          sourceId: source.sourceId,
          icon: source.icon,
          windows: brief.length > 0 ? brief : source.windows,
          staleAgo: source.staleAgo,
        };
      })
      .filter((source) => source.windows.length > 0);
    const problem =
      firstProblem(reports, row, preferences) ??
      // A line kept only from the last good copies: the host no longer lists the account, so its
      // numbers cannot be current.
      (rowSources.some((source) => !reportedIds.has(source.key)) ? usageCopy.noReport : null);
    if (rowSources.length === 0) {
      if (problem === null) return [];
      // Nothing pinned for this provider: its reason belongs in the modal, not in the footer.
      if (preferences.pins !== null && !preferences.pins.some((pin) => row.matches(pin.sourceId))) {
        return [];
      }
    }
    return [{ key: row.key, title: row.title, sources: rowSources, problem }];
  });
}

/** Why an account cannot answer, in the words the Usage surfaces use; null when it can. */
function reportProblem(entry: UsageReportEntry): string | null {
  const report = entry.report;
  if (report.status === "available") return null;
  if (report.status === "error") return report.error;
  return usageCopy.problem(report.problem);
}

/** The first of a row's pinned accounts that cannot answer; null while every one of them does. */
function firstProblem(
  reports: readonly UsageReportEntry[],
  row: (typeof USAGE_ROWS)[number],
  preferences: UsagePreferences,
): string | null {
  const pinned =
    preferences.pins === null ? null : preferences.pins.filter((pin) => row.matches(pin.sourceId));
  for (const entry of reports) {
    if (!row.matches(entry.sourceId)) continue;
    if (pinned !== null && !pinned.some((pin) => pin.sourceId === entry.sourceId)) continue;
    const problem = reportProblem(entry);
    if (problem !== null) return problem;
  }
  return null;
}

function percentFor(
  preference: UsagePreferences,
  window: UsageWindow,
): { percent: number; percentText: string } | null {
  const percent = displayPercent(window, preference.displayAs);
  return percent === null ? null : { percent, percentText: formatPct(percent) };
}

/**
 * The windows of a report that the user pins, in the report's order, with their percents. A kept
 * window whose reset time has passed says nothing about the limit now, so it is left out.
 */
function pinnedWindows(
  entry: UsageReportEntry,
  report: AvailableUsageReport,
  pins: readonly UsagePin[],
  preference: UsagePreferences,
  agedAgo: string | null,
  now: Date,
): PinnedUsageWindow[] {
  const meaning = preference.displayAs === "remaining" ? "left" : "used";
  const staleNote = agedAgo ? ` ${usageCopy.staleNote(agedAgo)}` : "";
  return report.windows
    .filter((window) =>
      pins.some((pin) => pin.sourceId === entry.sourceId && pin.windowId === window.id),
    )
    .filter((window) => !(agedAgo && hasReset(window.resetsAt, now)))
    .flatMap((window) => {
      const shown = percentFor(preference, window);
      if (!shown) return [];
      return [
        {
          key: `${entry.id}/${window.id}`,
          label: `${describe(entry, window.label)} ${shown.percentText} ${meaning}${staleNote}`,
          shortLabel: normalizeShortLabel(window.shortLabel ?? window.label),
          ...shown,
          tone: windowTone(window),
          ...(agedAgo ? { stale: true } : {}),
        },
      ];
    });
}

/**
 * The sidebar Usage item's summary: one group per account, grouped by source, each with its
 * windows in its report's order. An account that cannot answer, or whose host has not re-read it
 * for a while, shows the numbers it last had, dimmed and dated; with none of those it is left out
 * and the row says why.
 *
 * `serverId` names the host the reports came from: only that host's kept numbers stand in, so one
 * machine's last numbers never pass for another's. Without it, the host picked on the device is used.
 */
export function resolvePinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
  now: Date = new Date(),
  serverId: string | null = null,
): PinnedUsageSource[] {
  const lastGood = resolveLastGood(preferences, serverId ?? preferences.serverId, now);
  const pins = effectiveUsagePins(preferences, reports, lastGood);
  // Accounts the host has no report for at all yet keep the place they last had.
  const reportedIds = new Set(reports.map((entry) => entry.id));
  const accounts = [
    ...reports,
    ...lastGood
      .filter((entry) => !reportedIds.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        sourceId: entry.sourceId,
        // The report ID alone cannot name the provider once the host stopped listing it.
        sourceLabel: USAGE_ROWS.find((row) => row.matches(entry.sourceId))?.title ?? entry.sourceId,
        account: {},
        fetchedAt: entry.fetchedAt,
        report: entry.report,
      })),
  ];
  const groups = groupBySource(accounts).flatMap((entry) => {
    const kept = lastGood.find((candidate) => candidate.id === entry.id);
    const report = entry.report.status === "available" ? entry.report : kept?.report;
    if (!report) return [];
    // Both outcomes say why: the numbers are the last good ones, or there are none to show.
    const problem = reportProblem(entry);
    // Numbers stand in for an answer that did not come, or for an account the host stopped
    // listing, so they are dated however recent; numbers the host still sends under an old
    // `fetchedAt` (its own stand-in after a failure) are dated once they fall behind.
    const standsIn = problem !== null || !reportedIds.has(entry.id);
    const asOf = standsIn ? kept!.fetchedAt : entry.fetchedAt;
    const ago =
      standsIn || Date.parse(asOf) < now.getTime() - STALE_REPORT_AGE_MS
        ? staleAgo(asOf, now)
        : null;
    const windows = pinnedWindows(entry, report, pins, preferences, ago, now);
    // An account with nothing to show is left out; its row keeps the reason instead.
    if (windows.length === 0) return [];
    return [
      {
        key: entry.id,
        sourceId: entry.sourceId,
        icon: entry.icon ?? null,
        windows,
        ...(ago ? { staleAgo: ago } : {}),
      },
    ];
  });
  // A provider with no line of its own still gets one named line from `splitPinnedUsageRows`,
  // carrying the reason it has no numbers; nothing is added here for it.
  return groups;
}

/** When a kept report was fetched, in the short form the note shows: "3h ago". */
function staleAgo(fetchedAt: string, now: Date): string {
  return formatCompactTimeAgoAsProse(formatCompactTimeAgo(new Date(fetchedAt), now));
}

/** Whether the window's reset time is already behind us, so its kept share no longer applies. */
function hasReset(resetsAt: string | null | undefined, now: Date): boolean {
  if (!resetsAt) return false;
  const reset = Date.parse(resetsAt);
  return Number.isFinite(reset) && reset <= now.getTime();
}
