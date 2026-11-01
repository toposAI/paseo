import type { AssistantMessageItem, StreamItem } from "@/types/stream";
import { parseAssistantImageOnlyBlock } from "@/utils/assistant-image-metadata";

/**
 * A Claude `Read` of an image comes back as its own image-only assistant message right
 * after the tool row. When the reads run one after another (Read, result, Read, result)
 * the images are separate messages with a tool row between them, so each renders as its
 * own gallery and they stack vertically. Here the images of one turn that are separated
 * by nothing but tool rows are collected into one row at the last image's position, so
 * the existing gallery renderer lays them side by side. The tool rows keep their order
 * and sit together above it, where they fold into one Overview group.
 *
 * Text, thoughts, or another turn between two images keep them separate.
 */
const IMAGE_JOIN = "\n\n";

interface CachedMergedGallery {
  rows: readonly AssistantMessageItem[];
  merged: AssistantMessageItem;
}

// Keyed by the run's first row, which is stable while the run only grows at its end.
const mergedGalleryCache = new WeakMap<AssistantMessageItem, CachedMergedGallery>();

export function isImageOnlyRow(item: StreamItem): item is AssistantMessageItem {
  return item.kind === "assistant_message" && parseAssistantImageOnlyBlock(item.text) !== null;
}

function mergeGalleryRun(rows: readonly AssistantMessageItem[]): AssistantMessageItem {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const cached = mergedGalleryCache.get(first);
  if (
    cached &&
    cached.rows.length === rows.length &&
    cached.rows.every((row, index) => row === rows[index])
  ) {
    return cached.merged;
  }
  // The first row's identity keeps the gallery mounted as later images join it; the last
  // row's position and cursor are where the reader has actually got to.
  const merged: AssistantMessageItem = {
    ...first,
    ...(last.timelineCursor !== undefined ? { timelineCursor: last.timelineCursor } : {}),
    text: rows.map((row) => row.text.trim()).join(IMAGE_JOIN),
    timestamp: last.timestamp,
  };
  mergedGalleryCache.set(first, { rows: [...rows], merged });
  return merged;
}

/**
 * Returns the input array unchanged when there is nothing to merge, which keeps
 * downstream identity checks intact.
 */
export function mergeSeparatedImageGalleries(items: StreamItem[]): StreamItem[] {
  let output: StreamItem[] | null = null;
  let index = 0;

  while (index < items.length) {
    const item = items[index]!;
    if (!isImageOnlyRow(item)) {
      output?.push(item);
      index += 1;
      continue;
    }

    const run: AssistantMessageItem[] = [item];
    const tools: StreamItem[] = [];
    let pendingTools: StreamItem[] = [];
    let end = index + 1;
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const next = items[cursor]!;
      if (next.kind === "tool_call") {
        pendingTools.push(next);
      } else if (isImageOnlyRow(next) && next.turnId === item.turnId) {
        run.push(next);
        tools.push(...pendingTools);
        pendingTools = [];
        end = cursor + 1;
      } else {
        break;
      }
    }

    if (run.length === 1) {
      output?.push(item);
      index += 1;
      continue;
    }

    output ??= items.slice(0, index);
    output.push(...tools, mergeGalleryRun(run));
    index = end;
  }

  return output ?? items;
}

export interface GalleryBoundarySplit {
  tail: StreamItem[];
  head: StreamItem[];
}

/**
 * Live: the newest image sits in the streaming head while the earlier ones were already
 * settled into the tail. When the head opens with an image that continues the tail's
 * trailing gallery (only tool rows between), pull that gallery out of the tail so the
 * head carries one gallery that grows in place. Returns null when nothing continues.
 */
export function pullGalleryAcrossBoundary(
  tail: StreamItem[],
  head: StreamItem[],
): GalleryBoundarySplit | null {
  const firstHead = head[0];
  if (!firstHead || !isImageOnlyRow(firstHead)) return null;

  let galleryIndex = tail.length - 1;
  while (galleryIndex >= 0 && tail[galleryIndex]!.kind === "tool_call") galleryIndex -= 1;
  const gallery = tail[galleryIndex];
  if (!gallery || !isImageOnlyRow(gallery) || gallery.turnId !== firstHead.turnId) return null;

  const toolCount = tail.length - 1 - galleryIndex;
  const merged = mergeSeparatedImageGalleries([gallery, ...tail.slice(galleryIndex + 1), ...head]);
  return {
    tail: [...tail.slice(0, galleryIndex), ...merged.slice(0, toolCount)],
    head: merged.slice(toolCount),
  };
}
