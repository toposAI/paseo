import { describe, expect, it } from "vitest";
import { groupAssistantImageBlocks, layoutAssistantImageGallery } from "./assistant-image-gallery";

const base = { gap: 8, minRowHeight: 140, maxHeight: 480 };

describe("groupAssistantImageBlocks", () => {
  it("merges consecutive image-only blocks and keeps text apart", () => {
    const items = groupAssistantImageBlocks([
      "hello",
      "![a](/a.png)",
      "![b](/b.png) ![c](/c.png)",
      "bye",
      "![d](/d.png)",
    ]);
    expect(items.map((item) => item.kind)).toEqual(["markdown", "images", "markdown", "images"]);
    const first = items[1];
    expect(first?.kind === "images" && first.images.map((image) => image.source)).toEqual([
      "/a.png",
      "/b.png",
      "/c.png",
    ]);
    expect(items.map((item) => item.isLast)).toEqual([false, false, false, true]);
  });

  it("does not treat an image with text as a gallery", () => {
    expect(groupAssistantImageBlocks(["see ![a](/a.png)"])[0]?.kind).toBe("markdown");
  });
});

describe("layoutAssistantImageGallery", () => {
  it("keeps a single landscape image full width", () => {
    const { rows } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [1.6],
      availableWidth: 700,
      compact: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.widths[0]).toBeCloseTo(700);
    expect(rows[0]!.height).toBeCloseTo(700 / 1.6);
  });

  it("caps a single portrait image to the max height", () => {
    const { rows } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [0.46],
      availableWidth: 700,
      compact: false,
    });
    expect(rows[0]?.height).toBe(480);
    expect(rows[0]?.widths[0]).toBeCloseTo(480 * 0.46);
  });

  it("puts three portrait images in one equal-height row on desktop", () => {
    const { rows, scrollable } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [0.46, 0.46, 0.46],
      availableWidth: 800,
      compact: false,
    });
    expect(scrollable).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexes).toEqual([0, 1, 2]);
    expect(rows[0]!.widths.reduce((a, b) => a + b, 0) + 16).toBeLessThanOrEqual(800 + 0.001);
  });

  it("places two images side by side on a phone", () => {
    const { rows } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [0.46, 0.46],
      availableWidth: 358,
      compact: true,
      maxHeight: 506,
    });
    expect(rows).toHaveLength(1);
    const widthSum = rows[0]!.widths.reduce((a, b) => a + b, 0) + 8;
    expect(widthSum).toBeLessThanOrEqual(358 + 0.001);
  });

  it("scrolls horizontally from three images on a phone", () => {
    const { rows, scrollable } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [0.46, 0.46, 0.46],
      availableWidth: 358,
      compact: true,
      maxHeight: 506,
    });
    expect(scrollable).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.height).toBeLessThanOrEqual(506);
  });

  it("wraps to a new row rather than shrink below the minimum height", () => {
    const { rows } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [1.5, 1.5, 1.5, 1.5],
      availableWidth: 600,
      compact: false,
    });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.height).toBeGreaterThanOrEqual(140 - 0.001);
  });
});

describe("review follow-ups", () => {
  it("keeps a gallery while the last image token is half written", () => {
    const items = groupAssistantImageBlocks(["![a](/a.png) ![b](/b"]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("images");
    expect(groupAssistantImageBlocks(["![a](/a.png) ![b"])[0]?.kind).toBe("images");
  });

  it("does not stretch a lone last row taller than the row before it", () => {
    const { rows } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [1.5, 1.5, 1.5, 1.5, 1.5],
      availableWidth: 600,
      compact: false,
    });
    const last = rows[rows.length - 1]!;
    expect(last.height).toBeLessThanOrEqual(rows[0]!.height + 0.001);
  });

  it("never lets a panorama squash the phone swipe row below the minimum height", () => {
    const { rows } = layoutAssistantImageGallery({
      ...base,
      aspectRatios: [5, 0.5, 0.5],
      availableWidth: 358,
      compact: true,
    });
    expect(rows[0]!.height).toBeGreaterThanOrEqual(140);
  });
});
