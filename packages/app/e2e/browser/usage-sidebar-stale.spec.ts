import { expect, test } from "../support/fixtures";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectFooterItemSetting,
  openSidebarNavSettings,
  seedSidebarFooterPreferences,
  setFooterItemVisible,
} from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  expectPinnedUsage,
  openCompactSidebar,
  usageItem,
} from "../support/helpers/usage-sidebar-item";

const COMPACT = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };

/** The Claude reports from the fixture, cloned per call so the fixture's lists stay apart. */
function claudeReports(report?: UsageReportEntry["report"]): UsageReportEntry[] {
  return claudeAndCodexReports()
    .filter((entry) => entry.sourceId === "claude")
    .map((entry) => (report ? Object.assign(entry, { report }) : entry));
}

/** Turns the Usage footer item on from a fresh device, the way a user would. */
async function showUsageItem(page: Parameters<typeof gotoAppShell>[0]): Promise<void> {
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: false }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await openSidebarNavSettings(page);
  await expectFooterItemSetting(page, "usage", false);
  await setFooterItemVisible(page, "usage", true);
}

/**
 * The sidebar keeps the line when a source cannot answer (案A, 2026-10-30): the last good numbers
 * dimmed with how old they are, or, with none to keep, the reason in one line. A lapsed login must
 * never leave a bare "Usage —".
 */
test("a lapsed Claude login keeps its line with the last numbers and how old they are", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const expired = {
    kind: "expired" as const,
    expiresAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    refreshedBy: "claude",
  };
  await installUsageReportsFixture(page, {
    lists: [
      // The source answers once...
      () => claudeReports(),
      // ...then its login has expired on every later read.
      () => claudeReports({ status: "unavailable", problem: expired }),
    ],
  });
  await showUsageItem(page);
  await page.setViewportSize(COMPACT);
  await gotoAppShell(page);
  await openCompactSidebar(page);
  await expectPinnedUsage(page, ["31% 5h", "54% wk"]);

  // A reload starts from the kept numbers, and the first read gets the expired login.
  await gotoAppShell(page);
  await openCompactSidebar(page);
  await expect(usageItem(page)).toBeVisible();
  await expect(usageItem(page)).toContainText("not updating");
  await expect(usageItem(page)).toContainText("31% 5h");
  // The line has numbers, so the reason is a short mark; the spoken label carries it in full.
  await expect(page.getByTestId("sidebar-usage-partial-failure")).toHaveText("!");
  await expect(usageItem(page)).toHaveAccessibleName(/Login expired/);
});

test("a line that never had numbers says why instead of turning into a dash", async ({ page }) => {
  test.setTimeout(180_000);
  await installUsageReportsFixture(page, {
    lists: [() => claudeReports({ status: "error", error: "HTTP 500" })],
  });
  await showUsageItem(page);
  await page.setViewportSize(COMPACT);
  await gotoAppShell(page);
  await openCompactSidebar(page);
  await expect(usageItem(page)).toBeVisible();
  await expect(page.getByTestId("sidebar-usage-failed")).toHaveText("! Not updating: HTTP 500");
  await expect(usageItem(page)).not.toContainText("Usage —");
});
