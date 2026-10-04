import { DocumentPoint, DocumentRect } from '../../types/geometry';
import { rectContainsPoint } from '../../utils/coordinates';
import {
  OcrBlock,
  OcrDocument,
  OcrElement,
  OcrLine,
  OcrSelectionState,
} from './types';

/**
 * Checks if a point lies within a rectangle expanded by tolerance padding.
 */
export function rectContainsPointWithTolerance(
  rect: DocumentRect,
  point: DocumentPoint,
  tolerance = 0,
): boolean {
  return (
    point.x >= rect.x - tolerance &&
    point.x <= rect.x + rect.width + tolerance &&
    point.y >= rect.y - tolerance &&
    point.y <= rect.y + rect.height + tolerance
  );
}

/**
 * Calculates squared distance between a point and the center of a rectangle.
 */
function distanceSqToRectCenter(rect: DocumentRect, point: DocumentPoint): number {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = cx - point.x;
  const dy = cy - point.y;
  return dx * dx + dy * dy;
}

/**
 * Performs deterministic hit-testing to select an OCR element (word/token) at the given document point.
 *
 * Algorithm:
 * 1. Exact Hit: First searches for an element whose bounds contain the point exactly.
 *    If multiple elements overlap, chooses the one with the smallest area (most specific).
 * 2. Tolerance Hit: If no exact hit, searches within tolerance padding.
 *    Chooses the element whose center is closest to the tap point.
 * 3. Returns null if tap is outside all elements.
 */
export function hitTestOcrElement(
  ocrDoc: OcrDocument,
  point: DocumentPoint,
  tolerance = 4,
): OcrElement | null {
  if (!ocrDoc || !ocrDoc.blocks) return null;

  // Pass 1: Exact containment
  let exactMatch: OcrElement | null = null;
  let smallestArea = Infinity;

  for (const block of ocrDoc.blocks) {
    if (!rectContainsPointWithTolerance(block.bounds, point, tolerance)) {
      continue;
    }

    for (const line of block.lines) {
      if (!rectContainsPointWithTolerance(line.bounds, point, tolerance)) {
        continue;
      }

      for (const element of line.elements) {
        if (rectContainsPoint(element.bounds, point)) {
          const area = element.bounds.width * element.bounds.height;
          if (area < smallestArea) {
            smallestArea = area;
            exactMatch = element;
          }
        }
      }
    }
  }

  if (exactMatch) {
    return exactMatch;
  }

  // Pass 2: Tolerance hit
  if (tolerance <= 0) return null;

  let closestElement: OcrElement | null = null;
  let closestDistSq = Infinity;

  for (const block of ocrDoc.blocks) {
    if (!rectContainsPointWithTolerance(block.bounds, point, tolerance)) {
      continue;
    }

    for (const line of block.lines) {
      if (!rectContainsPointWithTolerance(line.bounds, point, tolerance)) {
        continue;
      }

      for (const element of line.elements) {
        if (rectContainsPointWithTolerance(element.bounds, point, tolerance)) {
          const distSq = distanceSqToRectCenter(element.bounds, point);
          if (distSq < closestDistSq) {
            closestDistSq = distSq;
            closestElement = element;
          }
        }
      }
    }
  }

  return closestElement;
}

/**
 * Performs hit-testing to select an OCR line at the given document point.
 */
export function hitTestOcrLine(
  ocrDoc: OcrDocument,
  point: DocumentPoint,
  tolerance = 4,
): OcrLine | null {
  if (!ocrDoc || !ocrDoc.blocks) return null;

  let bestLine: OcrLine | null = null;
  let closestDistSq = Infinity;

  for (const block of ocrDoc.blocks) {
    if (!rectContainsPointWithTolerance(block.bounds, point, tolerance)) {
      continue;
    }

    for (const line of block.lines) {
      if (rectContainsPoint(line.bounds, point)) {
        return line;
      }
      if (rectContainsPointWithTolerance(line.bounds, point, tolerance)) {
        const distSq = distanceSqToRectCenter(line.bounds, point);
        if (distSq < closestDistSq) {
          closestDistSq = distSq;
          bestLine = line;
        }
      }
    }
  }

  return bestLine;
}

/**
 * Performs hit-testing to select an OCR block at the given document point.
 */
export function hitTestOcrBlock(
  ocrDoc: OcrDocument,
  point: DocumentPoint,
  tolerance = 4,
): OcrBlock | null {
  if (!ocrDoc || !ocrDoc.blocks) return null;

  for (const block of ocrDoc.blocks) {
    if (rectContainsPointWithTolerance(block.bounds, point, tolerance)) {
      return block;
    }
  }

  return null;
}

export interface OcrHierarchyHit {
  readonly block: OcrBlock;
  readonly line: OcrLine;
  readonly element: OcrElement;
}

/**
 * Resolves full hierarchy for a tap point.
 */
export function hitTestOcrHierarchy(
  ocrDoc: OcrDocument,
  point: DocumentPoint,
  tolerance = 4,
): OcrHierarchyHit | null {
  const element = hitTestOcrElement(ocrDoc, point, tolerance);
  if (!element) return null;

  for (const block of ocrDoc.blocks) {
    if (block.id === element.blockId) {
      for (const line of block.lines) {
        if (line.id === element.lineId) {
          return { block, line, element };
        }
      }
    }
  }

  return null;
}

/**
 * Constructs canonical OcrSelectionState from a selected element.
 */
export function createOcrSelectionState(
  ocrDoc: OcrDocument,
  element: OcrElement,
): OcrSelectionState {
  return {
    documentId: ocrDoc.documentId,
    elementId: element.id,
    text: element.text,
    bounds: element.bounds,
    blockId: element.blockId,
    lineId: element.lineId,
    confidence: element.confidence,
  };
}
