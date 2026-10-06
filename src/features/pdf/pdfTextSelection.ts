/**
 * Logical PDF text selection on top of the PDFium text-object model.
 *
 * PDFium exposes text as page objects (a run of glyphs drawn with one font/matrix: depending on
 * the producer a word, a line or a cell). Character-level selection would need per-glyph boxes
 * and partial-object editing, which the object model does not support, so selection works on
 * whole objects with an easy step up to the visual line:
 *
 *   tap         -> the object under the finger (pdfiumEngine.hitTestTextObjects)
 *   tap again   -> the whole visual line: neighbours on the same baseline with word-sized gaps
 *                  (table columns, separated by larger gaps, are never joined)
 *
 * All geometry is in display-space document points (top-left origin), the same space as
 * PdfTextObject.bounds, so rotated pages and nested Form XObjects behave like any other text.
 */
import type { PdfRect, PdfTextObject } from './types';
import type { PdfDocumentOperation } from './pdfDocumentOperations';

export type PdfTextMarkStyle = 'highlight' | 'underline' | 'strikeout';

export interface PdfAnnotationColors {
  readonly highlight: string;
  readonly underline: string;
  readonly strikeout: string;
}

export const DEFAULT_ANNOTATION_COLORS: PdfAnnotationColors = {
  highlight: '#FFD60A',
  underline: '#007AFF',
  strikeout: '#FF3B30',
};

/** Swatches offered per markup style (highlighter tones for highlight, ink tones for lines). */
export const ANNOTATION_SWATCHES: Record<PdfTextMarkStyle, readonly string[]> = {
  highlight: ['#FFD60A', '#7CF29A', '#7FD4FF', '#FF9ECF', '#FFB37A', '#C9A7FF'],
  underline: ['#007AFF', '#FF3B30', '#34C759', '#FF9500', '#AF52DE', '#000000'],
  strikeout: ['#FF3B30', '#007AFF', '#000000', '#FF9500', '#AF52DE', '#34C759'],
};

export const ANNOTATION_STYLE_LABELS: Record<PdfTextMarkStyle, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validates persisted annotation colours (invalid entries fall back to the defaults). */
export function sanitizeAnnotationColors(raw: unknown): PdfAnnotationColors {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof PdfAnnotationColors) =>
    typeof src[key] === 'string' && HEX.test(src[key] as string)
      ? (src[key] as string).toUpperCase()
      : DEFAULT_ANNOTATION_COLORS[key];
  return { highlight: pick('highlight'), underline: pick('underline'), strikeout: pick('strikeout') };
}

/** Two boxes lie on the same visual text line (strong vertical overlap, similar size). */
export function onSameTextLine(a: PdfRect, b: PdfRect): boolean {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = bottom - top;
  const minH = Math.min(a.height, b.height);
  const maxH = Math.max(a.height, b.height);
  if (minH <= 0 || overlap <= 0) return false;
  return overlap >= minH * 0.6 && maxH <= minH * 1.8;
}

/**
 * The visual line containing `anchor`: objects on the same line reachable from it through gaps
 * no wider than ~0.8 x the line height (a generous word space; column gaps are wider), sorted
 * left to right. Always contains the anchor.
 */
export function findTextLine(objects: readonly PdfTextObject[], anchor: PdfTextObject): PdfTextObject[] {
  const lineHeight = Math.max(1, anchor.bounds.height);
  const maxGap = lineHeight * 0.8;
  const candidates = objects
    .filter((o) => o.id === anchor.id || (o.text.trim().length > 0 && onSameTextLine(anchor.bounds, o.bounds)))
    .sort((a, b) => a.bounds.x - b.bounds.x);
  const index = candidates.findIndex((o) => o.id === anchor.id);
  if (index < 0) return [anchor];

  const line: PdfTextObject[] = [anchor];
  let left = anchor.bounds.x;
  for (let i = index - 1; i >= 0; i--) {
    const o = candidates[i];
    const gap = left - (o.bounds.x + o.bounds.width);
    if (gap > maxGap) break;
    line.unshift(o);
    left = Math.min(left, o.bounds.x);
  }
  let right = anchor.bounds.x + anchor.bounds.width;
  for (let i = index + 1; i < candidates.length; i++) {
    const o = candidates[i];
    const gap = o.bounds.x - right;
    if (gap > maxGap) break;
    line.push(o);
    right = Math.max(right, o.bounds.x + o.bounds.width);
  }
  return line;
}

/** Smallest rectangle covering every rect. */
export function unionRect(rects: readonly PdfRect[]): PdfRect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Rectangles to mark for a selection: one continuous band per visual line (so an underline or
 * highlight across several words has no gaps), in reading order.
 */
export function selectionMarkRects(selection: readonly PdfTextObject[]): PdfRect[] {
  const lines: PdfTextObject[][] = [];
  const sorted = [...selection].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  for (const o of sorted) {
    const line = lines.find((l) => onSameTextLine(l[0].bounds, o.bounds));
    if (line) line.push(o);
    else lines.push([o]);
  }
  return lines
    .map((l) => unionRect(l.map((o) => o.bounds)))
    .filter((r): r is PdfRect => !!r && r.width > 0 && r.height > 0);
}

/** Text of a selection in reading order (words of a line joined with single spaces). */
export function selectionText(selection: readonly PdfTextObject[]): string {
  const sorted = [...selection].sort((a, b) => {
    if (onSameTextLine(a.bounds, b.bounds)) return a.bounds.x - b.bounds.x;
    return a.bounds.y - b.bounds.y;
  });
  let out = '';
  let prev: PdfTextObject | null = null;
  for (const o of sorted) {
    const text = o.text.replace(/\s+$/u, '');
    if (prev) out += onSameTextLine(prev.bounds, o.bounds) ? (/\s$/u.test(out) ? '' : ' ') : '\n';
    out += prev ? text.replace(/^\s+/u, '') : text;
    prev = o;
  }
  return out.trim();
}

/**
 * Rectangles for a markup style. Highlights cover the glyph boxes. When the baseline of every
 * object on a line is known (`baselineOf`), underline / strikethrough rectangles are shaped so
 * the native line lands just below the baseline (underline) or through the lower-case letters
 * (strikethrough), instead of at the bottom of the descender box. The native operation draws
 * underline at y + h - w/2 and strikethrough at y + 0.55h, with w = max(0.75, 0.07h).
 */
export function markRectsForStyle(
  style: PdfTextMarkStyle,
  selection: readonly PdfTextObject[],
  baselineOf?: (obj: PdfTextObject) => number | null,
): PdfRect[] {
  const bands = selectionMarkRects(selection);
  if (style === 'highlight' || !baselineOf) return bands;
  return bands.map((band) => {
    const members = selection.filter((o) => onSameTextLine(band, o.bounds) && o.bounds.x >= band.x - 0.5 && o.bounds.x <= band.x + band.width);
    const baselines = members.map((o) => baselineOf(o));
    if (members.length === 0 || baselines.some((b) => b === null || !Number.isFinite(b))) return band;
    const baseline = (baselines as number[]).reduce((a, b) => a + b, 0) / baselines.length;
    const em = band.height / 1.17;
    if (!(em > 0)) return band;
    if (style === 'underline') {
      const lineW = Math.max(0.75, em * 0.07);
      return { x: band.x, y: baseline + em * 0.1 + lineW / 2 - em, width: band.width, height: em };
    }
    return { x: band.x, y: baseline - em * 0.85, width: band.width, height: em };
  });
}

/**
 * The page-content operation that highlights / underlines / strikes through the selection with
 * `color` (one undoable revision; written into the page, saved and reopened like other markup).
 */
export function textMarkOperation(
  style: PdfTextMarkStyle,
  pageIndex: number,
  selection: readonly PdfTextObject[],
  color: string,
  baselineOf?: (obj: PdfTextObject) => number | null,
): PdfDocumentOperation {
  return {
    type: 'addHighlight',
    pageIndex,
    style,
    rects: markRectsForStyle(style, selection, baselineOf),
    color: HEX.test(color) ? color.toUpperCase() : DEFAULT_ANNOTATION_COLORS[style],
    opacity: style === 'highlight' ? 0.5 : 1,
  };
}
