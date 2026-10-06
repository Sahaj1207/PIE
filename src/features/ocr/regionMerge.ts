import { DocumentRect } from '../../types/geometry';
import { TextRegion } from '../../types/document';

/**
 * Minimum fraction of the smaller rectangle that must be covered by the intersection
 * for a fresh OCR detection to be considered the same text as an edited region.
 */
export const EDITED_REGION_OVERLAP_THRESHOLD = 0.5;

function intersectionArea(a: DocumentRect, b: DocumentRect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/** Overlap ratio relative to the smaller of the two rectangles (0..1). */
export function overlapRatio(a: DocumentRect, b: DocumentRect): number {
  const areaA = Math.max(0, a.width) * Math.max(0, a.height);
  const areaB = Math.max(0, b.width) * Math.max(0, b.height);
  const smaller = Math.min(areaA, areaB);
  if (smaller <= 0) return 0;
  return intersectionArea(a, b) / smaller;
}

export interface MergeDetectedRegionsOptions {
  readonly pageIndex?: number;
  /**
   * Unique token for this detection run (e.g. a timestamp in base 36). Combined with a
   * per-run counter it yields IDs that cannot collide with regions from earlier runs,
   * including regions restored from a persisted document after an app restart.
   */
  readonly runToken: string;
}

/**
 * Merges a fresh OCR detection into a page's existing text regions.
 *
 * Rules (deterministic):
 * 1. Regions the user edited ('modified') or deleted ('deleted') are preserved unchanged,
 *    including their reconstructed patches.
 * 2. Previously detected but unedited regions ('detected') are replaced by the new run.
 * 3. A new detection overlapping an edited/deleted region (the OCR re-reads the original
 *    pixels underneath the patch) is dropped so the edit is never duplicated.
 * 4. Every newly added region receives a fresh, collision-free ID.
 *
 * Preserved regions are placed after new detections so they win reverse-order hit tests.
 */
export function mergeDetectedRegions(
  existing: readonly TextRegion[],
  detected: readonly TextRegion[],
  options: MergeDetectedRegionsOptions,
): TextRegion[] {
  const pageIndex = options.pageIndex ?? 0;
  const preserved = existing.filter((r) => r.status === 'modified' || r.status === 'deleted');
  const preservedBounds = preserved.map((r) => r.originalBounds || r.bounds);

  const usedIds = new Set(preserved.map((r) => r.id));
  let counter = 1;
  const nextId = (): string => {
    let id = `text-region-${pageIndex}-${options.runToken}-${counter++}`;
    while (usedIds.has(id)) {
      id = `text-region-${pageIndex}-${options.runToken}-${counter++}`;
    }
    usedIds.add(id);
    return id;
  };

  const fresh: TextRegion[] = [];
  for (const region of detected) {
    const overlapsEdit = preservedBounds.some(
      (b) => overlapRatio(b, region.bounds) >= EDITED_REGION_OVERLAP_THRESHOLD,
    );
    if (overlapsEdit) continue;
    fresh.push({ ...region, id: nextId(), pageIndex, status: 'detected' });
  }

  return [...fresh, ...preserved];
}
