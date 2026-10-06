import { Document, TextRegion } from '../../types/document';
import { mergeDetectedRegions } from '../ocr/regionMerge';

/**
 * Pure helpers for image document state used by the canonical image editor flow
 * (EditorScreen + DocumentHistoryManager + Document model).
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Deterministic content fingerprint of an image document's editable state.
 *
 * Covers everything a Save persists that the user can change (title + page content:
 * OCR regions, edits, deletions, patches, added text). Bookkeeping metadata such as
 * updatedAt is excluded, so undoing back to the saved content yields the saved fingerprint.
 * Viewport transforms are not part of the Document and therefore never affect it.
 */
export function fingerprintImageDocument(document: Document): string {
  return stableStringify({
    title: document.metadata.title,
    pages: document.pages,
  });
}

/** True when the document content differs from the last saved fingerprint. */
export function isImageDocumentDirty(document: Document, savedFingerprint: string): boolean {
  return fingerprintImageDocument(document) !== savedFingerprint;
}

/** Collision-resistant token for one OCR detection run. */
export function createOcrRunToken(now: number = Date.now()): string {
  return now.toString(36);
}

/**
 * Returns a new document with a fresh OCR detection merged into the given page,
 * preserving existing edits and deletions (see mergeDetectedRegions).
 */
export function applyOcrDetection(
  document: Document,
  detectedRegions: readonly TextRegion[],
  runToken: string,
  pageIndex = 0,
): Document {
  const page = document.pages[pageIndex];
  if (!page) {
    return document;
  }

  const merged = mergeDetectedRegions(page.editableTextRegions || [], detectedRegions, {
    pageIndex,
    runToken,
  });

  const pages = document.pages.map((p, idx) =>
    idx === pageIndex ? { ...p, editableTextRegions: merged } : p,
  );

  return {
    ...document,
    metadata: { ...document.metadata, updatedAt: Date.now() },
    pages,
  };
}

/** Number of regions on a page that carry user edits (modified or deleted). */
export function countEditedRegions(document: Document, pageIndex = 0): number {
  const page = document.pages[pageIndex];
  if (!page) return 0;
  return (page.editableTextRegions || []).filter(
    (r) => r.status === 'modified' || r.status === 'deleted',
  ).length;
}
