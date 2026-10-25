import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The sidebar's usage lines are icon-only by the user's decision (2026-10-22, re-asserted
// 2026-10-25 after 17008183c put provider names back). `PinnedUsageRow.title` stays for the
// Usage modal and tests, but the sidebar must not render it. This guards against an upstream merge
// or a later "make the rows tellable apart" tweak silently bringing the text back.
describe("sidebar usage item", () => {
  const source = readFileSync(join(__dirname, "sidebar-item.tsx"), "utf8");

  it("does not render the provider name text", () => {
    expect(source).not.toMatch(/row\.title/);
    expect(source).not.toMatch(/rowTitle/);
  });

  it("still leads each source with its icon", () => {
    expect(source).toMatch(/<UsageSourceIcon\b/);
  });
});
