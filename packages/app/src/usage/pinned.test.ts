import { describe, expect, it } from "vitest";
import { usageCopy } from "./copy";
import type { UsagePreferences } from "./preferences";
import {
  choosePinnedUsageLayout,
  normalizeShortLabel,
  resolvePinnedUsage,
  splitPinnedUsageRows,
  type PinnedUsageSource,
  type PinnedUsageWindow,
} from "./pinned";
import type { AvailableUsageReport, UsageReportEntry, UsageWindow } from "./types";

/** Fetched when the test runs, so a report is current unless a case dates it otherwise. */
const FETCHED_AT = new Date().toISOString();

function report(input: {
  sourceId: string;
  sourceLabel: string;
  account?: string;
  icon?: string;
  windows: UsageWindow[];
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:${input.account ?? "default"}`,
    account: input.account ? { label: input.account } : {},
    fetchedAt: FETCHED_AT,
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    ...(input.icon ? { icon: input.icon } : {}),
    report: { status: "available", windows: input.windows },
  };
}

const claude = report({
  sourceId: "claude",
  sourceLabel: "Claude",
  icon: "<svg/>",
  windows: [
    { id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 31 },
    { id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 80 },
  ],
});
const codex = report({
  sourceId: "codex",
  sourceLabel: "Codex",
  windows: [{ id: "weekly", label: "Weekly", remainingPct: 88 }],
});

function windows(reports: UsageReportEntry[], prefs: UsagePreferences): PinnedUsageWindow[] {
  return resolvePinnedUsage(reports, prefs).flatMap((source) => source.windows);
}

function preferences(
  pinned: UsagePreferences["pins"],
  displayAs: UsagePreferences["displayAs"] = "used",
): UsagePreferences {
  return { displayAs, pins: pinned, serverId: null, lastGoodByHost: {} };
}

describe("choosePinnedUsageLayout", () => {
  const widths = { labelsWidth: 200, percentsWidth: 120, windowCount: 2 };

  it("shows meters only when every window's meter fits beside the labels", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: 240 })).toBe("meters");
    expect(choosePinnedUsageLayout({ ...widths, available: 239 })).toBe("labels");
  });

  it("drops the labels before it lets the line overflow", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: 199 })).toBe("percents");
  });

  it("shows labels until the widths are measured", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: null })).toBe("labels");
    expect(choosePinnedUsageLayout({ ...widths, available: 999, labelsWidth: null })).toBe(
      "labels",
    );
  });
});

describe("resolvePinnedUsage", () => {
  it("defaults to source-wide pins collected from each account", () => {
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [
        { id: "empty", label: "Empty" },
        { id: "weekly", label: "Weekly", usedPct: 90 },
      ],
    });
    const empty = report({
      sourceId: "empty",
      sourceLabel: "Empty",
      windows: [{ id: "empty", label: "Empty" }],
    });
    expect(
      windows([claude, codex, work, empty], preferences(null)).map((item) => [
        item.key,
        item.percentText,
      ]),
    ).toEqual([
      ["claude:default/five-hour", "31%"],
      ["claude:default/weekly", "80%"],
      ["claude:work/weekly", "90%"],
      ["codex:default/weekly", "12%"],
    ]);
  });

  it("pins replace defaults, and removing all pins restores defaults", () => {
    const reports = [claude, codex];
    expect(
      windows(reports, preferences([{ sourceId: "claude", windowId: "weekly" }])).map(
        (item) => item.key,
      ),
    ).toEqual(["claude:default/weekly"]);
    expect(windows(reports, preferences(null)).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "codex:default/weekly",
    ]);
  });

  it("groups pinned windows by source in report order, not pin order", () => {
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 90 }],
    });
    const sources = resolvePinnedUsage(
      [claude, codex, work],
      preferences([
        { sourceId: "claude", windowId: "weekly" },
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "claude", windowId: "five-hour" },
      ]),
    );

    const windowKeys = (source: PinnedUsageSource) => source.windows.map((window) => window.key);
    expect(sources.map((source) => [source.key, windowKeys(source)])).toEqual([
      ["claude:default", ["claude:default/five-hour", "claude:default/weekly"]],
      ["claude:work", ["claude:work/weekly"]],
      ["codex:default", ["codex:default/weekly"]],
    ]);
    expect(sources[0]).toEqual({
      key: "claude:default",
      sourceId: "claude",
      icon: "<svg/>",
      windows: [
        {
          key: "claude:default/five-hour",
          label: "Claude Session 31% used",
          shortLabel: "5h",
          percent: 31,
          percentText: "31%",
          tone: "default",
        },
        {
          key: "claude:default/weekly",
          label: "Claude Weekly 80% used",
          shortLabel: "wk",
          percent: 80,
          percentText: "80%",
          tone: "warning",
        },
      ],
    });
  });

  it("names a window by its label when the source gives no short label", () => {
    const items = windows([codex], preferences([{ sourceId: "codex", windowId: "weekly" }]));

    expect(items.map((item) => item.shortLabel)).toEqual(["wk"]);
  });

  it("defaults to every window the source marks as summary, when it marks any", () => {
    const marked = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      windows: [
        { id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 31, summary: true },
        { id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 80, summary: true },
        { id: "weekly-fable", label: "Weekly · Fable", usedPct: 8 },
      ],
    });

    expect(windows([marked, codex], preferences(null)).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "claude:default/weekly",
      "codex:default/weekly",
    ]);
  });

  it("keeps an empty short label empty, for a percent that needs no name", () => {
    const opencode = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode Go",
      windows: [{ id: "rolling", label: "Rolling", shortLabel: "", usedPct: 21 }],
    });
    const items = windows([opencode], preferences(null));

    expect(items.map((item) => item.shortLabel)).toEqual([""]);
  });

  it("formats the share left when the user reads usage as remaining", () => {
    const items = windows(
      [claude, codex],
      preferences(
        [
          { sourceId: "claude", windowId: "five-hour" },
          { sourceId: "codex", windowId: "weekly" },
        ],
        "remaining",
      ),
    );

    expect(items.map((item) => item.percentText)).toEqual(["69%", "88%"]);
    expect(items.map((item) => item.label)).toEqual([
      "Claude Session 69% left",
      "Codex Weekly 88% left",
    ]);
  });

  it("leaves out a pinned window that no report has, or that reports no percent", () => {
    const noPercent = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode",
      windows: [{ id: "monthly", label: "Monthly" }],
    });
    const items = windows(
      [claude, noPercent],
      preferences([
        { sourceId: "claude", windowId: "monthly" },
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "opencode", windowId: "monthly" },
      ]),
    );

    expect(items).toEqual([]);
  });

  it("shows a pin once per account of the source", () => {
    const personal = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "personal",
      windows: [{ id: "five-hour", label: "5-hour", usedPct: 10 }],
    });
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "five-hour", label: "5-hour", usedPct: 90 }],
    });
    const items = windows(
      [personal, codex, work],
      preferences([{ sourceId: "claude", windowId: "five-hour" }]),
    );

    expect(items.map((item) => [item.label, item.percentText])).toEqual([
      ["Claude (personal) 5-hour 10% used", "10%"],
      ["Claude (work) 5-hour 90% used", "90%"],
    ]);
  });
});

it("splits the sidebar summary into one line per provider, Claude first", () => {
  const opencode = report({
    sourceId: "opencode-go-key",
    sourceLabel: "OpenCode Go",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 12, summary: true }],
  });
  const family = report({
    sourceId: "opencode-go-family",
    sourceLabel: "OpenCode Go (family)",
    account: "family",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 40, summary: true }],
  });
  const reports = [opencode, claude, family];
  const rows = splitPinnedUsageRows(resolvePinnedUsage(reports, preferences(null)), reports);

  expect(rows.map((row) => [row.title, row.sources.length])).toEqual([
    ["Claude", 1],
    ["OpenCode Go", 2],
  ]);
});

it("keeps only the 5h and weekly windows on the sidebar lines", () => {
  const opencode = report({
    sourceId: "opencode-go-key",
    sourceLabel: "OpenCode Go",
    windows: [
      { id: "weekly", label: "Weekly", usedPct: 12, summary: true },
      { id: "monthly", label: "Monthly", usedPct: 30, summary: true },
    ],
  });
  const rows = splitPinnedUsageRows(resolvePinnedUsage([opencode], preferences(null)), [opencode]);
  const shown = rows.flatMap((row) => row.sources).flatMap((source) => source.windows);
  expect(shown.map((window) => window.shortLabel)).toEqual(["wk"]);
});

it("keeps a source that pins only its monthly window, so OpenCode Go still gets a line", () => {
  const opencode = report({
    sourceId: "opencode-go-key",
    sourceLabel: "OpenCode Go",
    windows: [{ id: "monthly", label: "Monthly", usedPct: 50, summary: true }],
  });
  const rows = splitPinnedUsageRows(resolvePinnedUsage([opencode], preferences(null)), [opencode]);
  const shown = rows.flatMap((row) => row.sources).flatMap((source) => source.windows);
  expect(rows.map((row) => row.title)).toEqual(["OpenCode Go"]);
  expect(shown.map((window) => window.percentText)).toEqual(["50%"]);
});

it("leaves unavailable and error reports out of the sidebar summary when nothing good is kept", () => {
  const expired: UsageReportEntry = {
    ...claude,
    report: {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-10-01T00:00:00.000Z", refreshedBy: "claude" },
    },
  };
  const failed: UsageReportEntry = {
    ...codex,
    report: { status: "error", error: "Store deleted" },
  };
  expect(resolvePinnedUsage([expired, failed], preferences(null))).toEqual([]);
});

describe("usage that could not be read", () => {
  const HOST = "host-a";
  const now = new Date("2026-10-30T12:00:00.000Z");
  const good: UsageReportEntry = { ...claude, fetchedAt: "2026-10-30T09:00:00.000Z" };
  const expiredReason = usageCopy.problem(
    { kind: "expired", expiresAt: "2026-10-01T00:00:00.000Z", refreshedBy: "claude" },
    now,
  );
  const expired: UsageReportEntry = {
    ...claude,
    fetchedAt: "2026-10-30T11:55:00.000Z",
    report: {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-10-01T00:00:00.000Z", refreshedBy: "claude" },
    },
  };

  function withLastGood(entry: UsageReportEntry): UsagePreferences {
    return {
      ...preferences(null),
      lastGoodByHost: {
        [HOST]: [
          {
            id: entry.id,
            sourceId: entry.sourceId,
            fetchedAt: entry.fetchedAt,
            report: entry.report as AvailableUsageReport,
          },
        ],
      },
    };
  }

  it("shows the last good numbers dimmed and marked, while the login has expired", () => {
    const prefs = withLastGood(good);
    const sources = resolvePinnedUsage([expired], prefs, now, HOST);
    const rows = splitPinnedUsageRows(sources, [expired]);

    expect(sources.map((source) => [source.key, source.staleAgo])).toEqual([
      ["claude:default", "3h ago"],
    ]);
    expect(sources[0]!.windows.map((window) => [window.percentText, window.stale])).toEqual([
      ["31%", true],
    ]);
    expect(sources[0]!.windows[0]!.label).toBe("Claude Session 31% used 3h ago · not updating");
    expect(rows.map((row) => [row.title, row.problem])).toEqual([["Claude", expiredReason]]);
    expect(rows[0]!.sources[0]!.staleAgo).toBe("3h ago");
  });

  it("keeps the line with the reason when the last good copy is over a day old", () => {
    const prefs = withLastGood(good);
    const aDayLater = new Date("2026-10-31T09:00:01.000Z");
    const sources = resolvePinnedUsage([expired], prefs, aDayLater, HOST);
    const rows = splitPinnedUsageRows(sources, [expired]);

    expect(sources).toEqual([]);
    expect(rows.map((row) => row.title)).toEqual(["Claude"]);
    expect(rows[0]!.sources).toEqual([]);
    expect(rows[0]!.problem).toContain("Login expired");
  });

  it("keeps the line with the reason when nothing good was ever kept", () => {
    const rows = splitPinnedUsageRows(resolvePinnedUsage([expired], preferences(null), now, HOST), [
      expired,
    ]);

    expect(rows.map((row) => [row.title, row.sources.length])).toEqual([["Claude", 0]]);
    expect(rows[0]!.problem).toBe(expiredReason);
    expect(usageCopy.fetchFailed(rows[0]!.problem!)).toMatch(
      /^Not updating: Login expired .+ Run claude to refresh it\.$/,
    );
  });

  it("says why a report failed with an error", () => {
    const failed: UsageReportEntry = { ...claude, report: { status: "error", error: "HTTP 500" } };
    const rows = splitPinnedUsageRows(resolvePinnedUsage([failed], preferences(null), now, HOST), [
      failed,
    ]);

    expect(rows[0]!.problem).toBe("HTTP 500");
  });

  it("keeps the failed line's reason while another provider's line keeps its numbers", () => {
    const failed: UsageReportEntry = {
      ...claude,
      report: { status: "error", error: "HTTP 500" },
    };
    const opencode = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode Go",
      windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 12, summary: true }],
    });
    const rows = splitPinnedUsageRows(
      resolvePinnedUsage([failed, opencode], preferences(null), now, HOST),
      [failed, opencode],
    );

    expect(rows.map((row) => [row.title, row.sources.length, row.problem])).toEqual([
      ["Claude", 0, "HTTP 500"],
      ["OpenCode Go", 1, null],
    ]);
  });

  it("drops the dimming and the reason once the source answers again", () => {
    const prefs = withLastGood(good);
    const fresh: UsageReportEntry = { ...good, fetchedAt: "2026-10-30T11:59:00.000Z" };
    const rows = splitPinnedUsageRows(resolvePinnedUsage([fresh], prefs, now, HOST), [fresh]);

    expect(rows.map((row) => [row.sources.length, row.problem])).toEqual([[1, null]]);
    expect(rows[0]!.sources[0]!.staleAgo).toBeUndefined();
    expect(rows[0]!.sources[0]!.windows.every((window) => window.stale === undefined)).toBe(true);
  });

  it("keeps a line whose account the host no longer lists, from its last good copy", () => {
    const prefs = withLastGood(good);
    const rows = splitPinnedUsageRows(resolvePinnedUsage([], prefs, now, HOST), []);

    expect(rows.map((row) => [row.title, row.problem])).toEqual([["Claude", usageCopy.noReport]]);
    expect(rows[0]!.sources[0]!.windows.map((window) => window.percentText)).toEqual(["31%"]);
    // Its numbers are stale too, so they are dimmed and carry their age.
    expect(rows[0]!.sources[0]!.staleAgo).toBe("3h ago");
    expect(rows[0]!.sources[0]!.windows[0]!.stale).toBe(true);
    expect(rows[0]!.sources[0]!.windows[0]!.label).toBe(
      "Claude Session 31% used 3h ago · not updating",
    );
  });

  it("does not repeat one provider's reason on a line that has its own numbers", () => {
    // The host lists the account and it answers: the line's numbers are current.
    const rows = splitPinnedUsageRows(resolvePinnedUsage([good], withLastGood(good), now, HOST), [
      good,
    ]);

    expect(rows.map((row) => [row.title, row.problem])).toEqual([["Claude", null]]);
  });

  it("names the provider of a line kept only from a host that stopped listing it", () => {
    // The line's windows carry its name too, so the label never reads as a bare source ID.
    const rows = splitPinnedUsageRows(resolvePinnedUsage([], withLastGood(good), now, HOST), []);
    const window = rows[0]!.sources[0]!.windows[0]!;

    expect(window.label.startsWith("Claude Session")).toBe(true);
  });

  it("shows nothing at all before any report has arrived", () => {
    expect(splitPinnedUsageRows(resolvePinnedUsage([], preferences(null), now), [])).toEqual([]);
  });

  it("marks numbers the host has not re-read for a while, even while it calls them current", () => {
    // The host's own stand-in after a transient failure is served as "available", but under the
    // time it was really fetched, so it is shown dimmed with its age.
    const old: UsageReportEntry = { ...good, fetchedAt: "2026-10-30T11:40:00.000Z" };
    const sources = resolvePinnedUsage([old], preferences(null), now, HOST);

    expect(sources.map((source) => source.staleAgo)).toEqual(["20m ago"]);
    expect(sources[0]!.windows[0]!.stale).toBe(true);
    expect(sources[0]!.windows[0]!.label).toBe("Claude Session 31% used 20m ago · not updating");
  });

  it("keeps a share the host re-read within the last few minutes undimmed", () => {
    const recent: UsageReportEntry = { ...good, fetchedAt: "2026-10-30T11:50:00.000Z" };
    const sources = resolvePinnedUsage([recent], preferences(null), now, HOST);

    expect(sources[0]!.staleAgo).toBeUndefined();
    expect(sources[0]!.windows[0]!.stale).toBeUndefined();
  });

  it("drops a kept window whose reset time has passed, and keeps one that has not", () => {
    const kept = [
      {
        id: "five-hour",
        label: "Session",
        shortLabel: "5h",
        usedPct: 31,
        summary: true,
        resetsAt: "2026-10-30T10:00:00.000Z",
      },
      {
        id: "weekly",
        label: "Weekly",
        shortLabel: "wk",
        usedPct: 80,
        summary: true,
        resetsAt: "2026-11-02T00:00:00.000Z",
      },
    ];
    const old: UsageReportEntry = {
      ...claude,
      fetchedAt: "2026-10-30T09:00:00.000Z",
      report: { status: "available", windows: kept },
    };
    const sources = resolvePinnedUsage([old], preferences(null), now, HOST);

    expect(sources[0]!.windows.map((window) => window.shortLabel)).toEqual(["wk"]);
  });

  it("keeps an expired login's reason on a line when another account still has numbers", () => {
    // One Claude login answers while the other's session has run out: the line keeps its numbers
    // and says, through `problem`, that something on it is not current.
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 10 }],
    });
    const reports = [{ ...work, fetchedAt: "2026-10-30T11:59:00.000Z" }, expired];
    const pins = [{ sourceId: "claude", windowId: "five-hour" }];
    const rows = splitPinnedUsageRows(
      resolvePinnedUsage(reports, preferences(pins), now, HOST),
      reports,
      preferences(pins),
    );

    expect(rows.map((row) => [row.sources.length, row.problem])).toEqual([[1, expiredReason]]);
  });

  it("keeps no line for a provider the user unpinned, even while it fails", () => {
    const pins = [{ sourceId: "opencode", windowId: "weekly" }];
    const rows = splitPinnedUsageRows([], [expired], preferences(pins));

    expect(rows).toEqual([]);
  });

  it("uses the picked host's kept numbers when no host is named", () => {
    const prefs = { ...withLastGood(good), serverId: HOST };
    const sources = resolvePinnedUsage([expired], prefs, now);

    expect(sources.map((source) => source.staleAgo)).toEqual(["3h ago"]);
  });
});

describe("normalizeShortLabel", () => {
  it("unifies provider spellings", () => {
    expect(normalizeShortLabel("5 hour")).toBe("5h");
    expect(normalizeShortLabel("Weekly")).toBe("wk");
    expect(normalizeShortLabel("wk")).toBe("wk");
    expect(normalizeShortLabel("mo")).toBe("mo");
  });
});
