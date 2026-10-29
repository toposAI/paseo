import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_PREFERENCES,
  isUsagePinned,
  LAST_GOOD_MAX_AGE_MS,
  rememberLastGood,
  resolveLastGood,
  setUsageDisplayAs,
  setUsageHost,
  toggleUsagePin,
  UsagePreferencesSchema,
} from "./preferences";
import type { UsageReportEntry } from "./types";

const claudeFiveHour = { sourceId: "claude", windowId: "five-hour" };
const codexWeekly = { sourceId: "codex", windowId: "weekly" };

describe("usage preferences", () => {
  it("pins windows in the order the user pins them", () => {
    const pinned = toggleUsagePin({
      preferences: toggleUsagePin({
        preferences: DEFAULT_USAGE_PREFERENCES,
        pin: codexWeekly,
        reports: [],
      }),
      pin: claudeFiveHour,
      reports: [],
    });

    expect(pinned.pins).toEqual([codexWeekly, claudeFiveHour]);
    expect(isUsagePinned(pinned, { sourceId: "codex", windowId: "weekly" }, [])).toBe(true);
    expect(isUsagePinned(pinned, { sourceId: "codex", windowId: "five-hour" }, [])).toBe(false);
  });

  it("unpins a pinned window and keeps the others in order", () => {
    const three = [codexWeekly, claudeFiveHour, { sourceId: "claude", windowId: "weekly" }];
    const unpinned = toggleUsagePin({
      preferences: { displayAs: "used", pins: three, serverId: null, lastGoodByHost: {} },
      pin: claudeFiveHour,
      reports: [],
    });

    expect(unpinned.pins).toEqual([codexWeekly, { sourceId: "claude", windowId: "weekly" }]);
  });

  it("switches between used and remaining without touching pins", () => {
    const preferences = {
      displayAs: "used" as const,
      pins: [codexWeekly],
      serverId: null,
      lastGoodByHost: {},
    };

    expect(setUsageDisplayAs(preferences, "remaining")).toEqual({
      displayAs: "remaining",
      pins: [codexWeekly],
      serverId: null,
      lastGoodByHost: {},
    });
  });

  it("remembers the picked host without touching pins", () => {
    expect(setUsageHost({ ...DEFAULT_USAGE_PREFERENCES, pins: [codexWeekly] }, "server")).toEqual({
      displayAs: "used",
      pins: [codexWeekly],
      serverId: "server",
      lastGoodByHost: {},
    });
  });

  it("reads preferences saved before hosts could be picked as no pick", () => {
    expect(UsagePreferencesSchema.parse({ displayAs: "remaining", pinned: [codexWeekly] })).toEqual(
      { displayAs: "remaining", pins: [codexWeekly], serverId: null, lastGoodByHost: {} },
    );
  });
});

it("default sidebar windows are pinned on cards and the first toggle removes only that row", () => {
  const reports = [
    {
      id: "claude:default",
      sourceId: "claude",
      sourceLabel: "Claude",
      account: {},
      fetchedAt: "2026-10-02T00:00:00Z",
      report: {
        status: "available" as const,
        windows: [
          { id: "five_hour", label: "5-hour", summary: true, usedPct: 31 },
          { id: "weekly", label: "Weekly", summary: true, usedPct: 54 },
        ],
      },
    },
    {
      id: "codex:default",
      sourceId: "codex",
      sourceLabel: "Codex",
      account: {},
      fetchedAt: "2026-10-02T00:00:00Z",
      report: {
        status: "available" as const,
        windows: [{ id: "five_hour", label: "5-hour", summary: true, usedPct: 7 }],
      },
    },
  ];
  const pins = [
    { sourceId: "claude", windowId: "five_hour" },
    { sourceId: "claude", windowId: "weekly" },
    { sourceId: "codex", windowId: "five_hour" },
  ];
  for (const pin of pins) expect(isUsagePinned(DEFAULT_USAGE_PREFERENCES, pin, reports)).toBe(true);
  const changed = toggleUsagePin({
    preferences: DEFAULT_USAGE_PREFERENCES,
    pin: pins[1]!,
    reports,
  });
  expect(isUsagePinned(changed, pins[1]!, reports)).toBe(false);
  expect(isUsagePinned(changed, pins[0]!, reports)).toBe(true);
  expect(isUsagePinned(changed, pins[2]!, reports)).toBe(true);
  const empty = toggleUsagePin({
    preferences: toggleUsagePin({ preferences: changed, pin: pins[0]!, reports }),
    pin: pins[2]!,
    reports,
  });
  const restored = UsagePreferencesSchema.parse(JSON.parse(JSON.stringify(empty)));
  for (const pin of pins) expect(isUsagePinned(restored, pin, reports)).toBe(false);
});

it("reads old selections without losing display or host and preserves an explicit empty selection", () => {
  for (const [input, pins] of [
    [{ pinned: [] }, null],
    [{ pinned: [codexWeekly] }, [codexWeekly]],
    [{ pins: [], pinned: [codexWeekly] }, []],
    [{ pins: null, pinned: [codexWeekly] }, null],
    [{ pins: "bad", pinned: [codexWeekly] }, null],
  ] as const) {
    expect(
      UsagePreferencesSchema.parse({ displayAs: "remaining", serverId: "host", ...input }),
    ).toEqual({ displayAs: "remaining", serverId: "host", pins, lastGoodByHost: {} });
  }
});

describe("rememberLastGood", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const host = "host-a";
  const mapped = { id: "five-hour", label: "5-hour", usedPct: 31, summary: true };
  const other = { id: "five-hour", label: "5-hour", usedPct: 99, summary: true };

  function report(
    id: string,
    sourceId: string,
    fetchedAt: string,
    windows: { id: string; label: string; usedPct?: number; summary?: boolean }[] = [mapped],
  ): UsageReportEntry {
    return {
      id,
      sourceId,
      sourceLabel: sourceId,
      account: {},
      fetchedAt,
      report: { status: "available", windows },
    };
  }

  /** Every host's kept list at one place, for assertions that do not care which host they are. */
  function allHosts(preferences: {
    lastGoodByHost: Record<string, readonly { id: string }[]>;
  }): { id: string }[] {
    return Object.values(preferences.lastGoodByHost).flatMap((entries) => entries.concat());
  }

  it("keeps each available report of the host and drops the ones that could not be read", () => {
    const kept = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [
        report("claude:default", "claude", "2026-10-30T11:00:00.000Z"),
        {
          ...report("codex:default", "codex", "2026-10-30T11:00:00.000Z"),
          report: { status: "error", error: "x" },
        },
      ],
      now,
    );

    expect(
      kept.lastGoodByHost[host]?.map((entry) => [entry.id, entry.sourceId, entry.fetchedAt]),
    ).toEqual([["claude:default", "claude", "2026-10-30T11:00:00.000Z"]]);
  });

  it("keeps the same object when nothing changed, so saving it cannot loop", () => {
    const once = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [report("claude:default", "claude", "2026-10-30T11:00:00.000Z")],
      now,
    );
    // As read back from settings, the entry goes through the stored copy's schema.
    const stored = UsagePreferencesSchema.parse(JSON.parse(JSON.stringify(once)));

    expect(
      rememberLastGood(
        stored,
        host,
        [report("claude:default", "claude", "2026-10-30T11:00:00.000Z")],
        now,
      ),
    ).toBe(stored);
    expect(rememberLastGood(stored, host, [], now)).toBe(stored);
  });

  it("replaces an account's copy with a later fetch but not an earlier one", () => {
    const first = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [report("claude:default", "claude", "2026-10-30T10:00:00.000Z")],
      now,
    );
    const earlier = rememberLastGood(
      first,
      host,
      [report("claude:default", "claude", "2026-10-30T09:00:00.000Z", [other])],
      now,
    );
    const later = rememberLastGood(
      earlier,
      host,
      [report("claude:default", "claude", "2026-10-30T11:30:00.000Z")],
      now,
    );

    expect(earlier).toBe(first);
    expect(later.lastGoodByHost[host]?.[0]?.fetchedAt).toBe("2026-10-30T11:30:00.000Z");
  });

  it("keeps each host's copies apart, so one machine's numbers never stand in for another's", () => {
    const a = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [report("claude:default", "claude", "2026-10-30T11:00:00.000Z")],
      now,
    );
    const b = rememberLastGood(
      a,
      "host-b",
      [report("claude:default", "claude", "2026-10-30T11:20:00.000Z", [other])],
      now,
    );

    expect(resolveLastGood(b, host, now).map((entry) => entry.report)).toEqual([
      { status: "available", windows: [mapped] },
    ]);
    expect(resolveLastGood(b, "host-b", now).map((entry) => entry.report)).toEqual([
      { status: "available", windows: [other] },
    ]);
    expect(resolveLastGood(b, null, now)).toEqual([]);
  });

  it("drops copies older than a day, even from settings", () => {
    const kept = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [report("claude:default", "claude", "2026-10-30T11:00:00.000Z")],
      now,
    );
    const fetchedAt = Date.parse("2026-10-30T11:00:00.000Z");
    const justInside = new Date(fetchedAt + LAST_GOOD_MAX_AGE_MS - 1);
    const justOutside = new Date(fetchedAt + LAST_GOOD_MAX_AGE_MS + 1);

    expect(resolveLastGood(kept, host, justInside)).toHaveLength(1);
    expect(resolveLastGood(kept, host, justOutside)).toEqual([]);
    expect(rememberLastGood(kept, host, [], justOutside).lastGoodByHost[host]).toBeUndefined();
    // The last good copy also ages out of the pin defaults once nothing is fresh.
    expect(
      isUsagePinned(
        kept,
        { sourceId: "claude", windowId: "five-hour" },
        [],
        resolveLastGood(kept, host, justOutside),
      ),
    ).toBe(false);
  });

  it("gives a source that cannot answer its last good default pins", () => {
    const kept = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [report("claude:default", "claude", "2026-10-30T11:00:00.000Z")],
      now,
    );
    const expired: UsageReportEntry = {
      ...report("claude:default", "claude", "2026-10-30T11:59:00.000Z"),
      report: {
        status: "unavailable",
        problem: { kind: "rejected", status: 401, refreshedBy: "claude" },
      },
    };
    const lastGood = resolveLastGood(kept, host, now);

    expect(isUsagePinned(kept, { sourceId: "claude", windowId: "five-hour" }, [], lastGood)).toBe(
      true,
    );
    expect(
      isUsagePinned(kept, { sourceId: "claude", windowId: "five-hour" }, [expired], lastGood),
    ).toBe(true);
  });

  it("reads a stored last good copy and ignores one that cannot be read", () => {
    const kept = rememberLastGood(
      DEFAULT_USAGE_PREFERENCES,
      host,
      [report("claude:default", "claude", "2026-10-30T11:00:00.000Z")],
      now,
    );
    const parsed = UsagePreferencesSchema.parse(JSON.parse(JSON.stringify(kept)));

    expect(parsed).toEqual(kept);
    expect(allHosts(parsed)).toHaveLength(1);
    expect(
      allHosts(
        UsagePreferencesSchema.parse({
          lastGoodByHost: {
            [host]: [{ id: "x", report: { status: "error" } }, "junk"],
            "not-a-host": "junk",
          },
        }),
      ),
    ).toEqual([]);
    expect(UsagePreferencesSchema.parse({ displayAs: "remaining" })).toEqual({
      displayAs: "remaining",
      pins: null,
      serverId: null,
      lastGoodByHost: {},
    });
  });
});
