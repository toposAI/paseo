import {
  parseAssistantImageOnlyBlock,
  type AssistantImageEntry,
} from "@/utils/assistant-image-metadata";

const PARTIAL_IMAGE_TAIL = /!(?:\[[^\]]*)?(?:\]\([^)]*)?$/;

export type AssistantBlockItem =
  | { kind: "markdown"; key: string; block: string; isLast: boolean }
  | { kind: "images"; key: string; images: AssistantImageEntry[]; isLast: boolean };

/**
 * Consecutive image-only blocks become one gallery so they can sit side by side.
 * Any other block (text, code, ...) stays a markdown block and ends the run.
 */
export function groupAssistantImageBlocks(blocks: string[]): AssistantBlockItem[] {
  const items: AssistantBlockItem[] = [];
  blocks.forEach((block, index) => {
    // While streaming, the last block may end in a half-written image token. Dropping it
    // keeps a gallery a gallery instead of flipping to markdown and back (a remount each time).
    const settled = index === blocks.length - 1 ? block.replace(PARTIAL_IMAGE_TAIL, "") : block;
    const entries = parseAssistantImageOnlyBlock(settled);
    const previous = items[items.length - 1];
    if (entries && previous?.kind === "images") {
      previous.images.push(...entries);
      return;
    }
    if (entries) {
      items.push({ kind: "images", key: `images:${index}`, images: [...entries], isLast: false });
      return;
    }
    items.push({ kind: "markdown", key: `block:${index}`, block, isLast: false });
  });
  const last = items[items.length - 1];
  if (last) last.isLast = true;
  return items;
}

export interface GalleryRowLayout {
  /** Image indexes in this row, in order. */
  indexes: number[];
  /** Common height of every image in the row. */
  height: number;
  /** Pixel width of each image (height * aspect ratio). */
  widths: number[];
}

export interface GalleryLayoutInput {
  aspectRatios: number[];
  availableWidth: number;
  /** Tallest an image may be, so one image never needs vertical scrolling to see whole. */
  maxHeight: number;
  gap: number;
  /** Compact (phone): at most 2 images share a row; 3+ become one horizontal-scroll row. */
  compact: boolean;
  /** Wide screens start a new row rather than shrink images below this height. */
  minRowHeight: number;
}

export interface GalleryLayout {
  rows: GalleryRowLayout[];
  scrollable: boolean;
}

function justifiedHeight(ratios: number[], availableWidth: number, gap: number): number {
  const totalGap = gap * (ratios.length - 1);
  const ratioSum = ratios.reduce((sum, ratio) => sum + ratio, 0);
  return (availableWidth - totalGap) / ratioSum;
}

function buildRow(indexes: number[], ratios: number[], height: number): GalleryRowLayout {
  return { indexes, height, widths: indexes.map((index) => height * ratios[index]!) };
}

export function layoutAssistantImageGallery(input: GalleryLayoutInput): GalleryLayout {
  const { aspectRatios, availableWidth, maxHeight, gap, compact, minRowHeight } = input;
  const count = aspectRatios.length;
  if (count === 0 || availableWidth <= 0) {
    return { rows: [], scrollable: false };
  }
  const ratios = aspectRatios.map((ratio) => (ratio > 0 && Number.isFinite(ratio) ? ratio : 1));

  if (compact && count >= 3) {
    // One row, swiped sideways. Each image is tall enough to read yet never wider
    // than ~85% of the screen, so the next one peeks in and shows there is more.
    const widest = Math.max(...ratios);
    const height = Math.min(maxHeight, Math.max(minRowHeight, (availableWidth * 0.85) / widest));
    return {
      rows: [
        buildRow(
          ratios.map((_, index) => index),
          ratios,
          height,
        ),
      ],
      scrollable: true,
    };
  }

  const perRowLimit = compact ? 2 : count;
  const rows: GalleryRowLayout[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const rowRatios = current.map((index) => ratios[index]!);
    const fitted = justifiedHeight(rowRatios, availableWidth, gap);
    // A short last row keeps the previous row's height so the set reads as one even grid.
    const previousHeight = rows[rows.length - 1]?.height ?? maxHeight;
    rows.push(buildRow(current, ratios, Math.min(fitted, maxHeight, previousHeight)));
    current = [];
  };
  for (let index = 0; index < count; index += 1) {
    if (current.length > 0) {
      const candidate = [...current, index].map((i) => ratios[i]!);
      const tooSmall = justifiedHeight(candidate, availableWidth, gap) < minRowHeight;
      if (tooSmall || current.length >= perRowLimit) flush();
    }
    current.push(index);
  }
  flush();
  return { rows, scrollable: false };
}
