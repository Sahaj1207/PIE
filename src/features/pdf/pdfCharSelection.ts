/**
 * Character-level PDF text selection (Google Drive–style): long press selects a word, two
 * handles extend the selection character by character across words and lines.
 *
 * Characters come from PDFium's text page (native getPageChars): reading order, display-space
 * loose boxes (all characters of a line share top and bottom), baselines and the owning text
 * object with the character's offset inside it. Generated characters (spaces / line breaks that
 * PDFium infers between runs) belong to no object.
 *
 * Edits map a character range onto the page's text objects (the units PDFium can change):
 *   first touched object  -> prefix + replacement (+ suffix when the range ends inside it)
 *   objects fully inside  -> deleted
 *   last touched object   -> its unselected tail (deleted when nothing remains)
 * with `reflow`, so the rest of the line closes up or makes room (native pdfium_bridge.cpp).
 */
import type { PdfRect, PdfTextObject } from './types';
import type { PdfDocumentOperation } from './pdfDocumentOperations';
import { DEFAULT_ANNOTATION_COLORS, PdfTextMarkStyle } from './pdfTextSelection';

export interface PdfChar {
  readonly index: number;
  readonly ch: string;
  /** Display-space loose box (top-left origin, document points). */
  readonly rect: PdfRect;
  /** Display-space y of the character origin (baseline). */
  readonly baselineY: number;
  /** Owning text object id (same ids as getTextObjects), null for generated characters. */
  readonly objectId: string | null;
  /** Offset of the character among its object's characters (reading order). */
  readonly offset: number;
  readonly generated: boolean;
  /** Index of the visual line in PdfPageChars.lines. */
  readonly line: number;
}

export interface PdfPageChars {
  readonly pageIndex: number;
  readonly chars: readonly PdfChar[];
  /** Character indices per visual line, in reading order. */
  readonly lines: readonly (readonly number[])[];
}

/** Inclusive character range [start, end] (start <= end). */
export interface PdfCharRange {
  readonly start: number;
  readonly end: number;
}

const isLineBreak = (ch: string) => ch === '\r' || ch === '\n';

function sameLine(a: PdfRect, b: PdfRect): boolean {
  if (a.height <= 0 || b.height <= 0) return true;
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap >= Math.min(a.height, b.height) * 0.5;
}

/** Parses the native JSON ({pageIndex, objects, chars: [[cp, x, y, w, h, baseline, obj, off, gen]]}). */
export function parsePageChars(raw: unknown): PdfPageChars | null {
  let data: any;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.chars) || !Array.isArray(data.objects)) return null;
  const objects: string[] = data.objects.map(String);
  const chars: PdfChar[] = [];
  const lines: number[][] = [];
  let lineRect: PdfRect | null = null;
  let breakPending = false;
  for (const entry of data.chars as unknown[]) {
    if (!Array.isArray(entry) || entry.length < 9) continue;
    const [cp, x, y, w, h, baseline, obj, off, gen] = entry.map(Number);
    if (![cp, x, y, w, h, baseline].every(Number.isFinite)) continue;
    const ch = String.fromCodePoint(cp > 0 && cp <= 0x10ffff ? cp : 0xfffd);
    const rect = { x, y, width: Math.max(0, w), height: Math.max(0, h) };
    const hasBox = rect.width > 0 && rect.height > 0;
    if (isLineBreak(ch)) {
      breakPending = true;
    } else if (hasBox && (breakPending || !lineRect || !sameLine(lineRect, rect))) {
      lines.push([]);
      lineRect = rect;
      breakPending = false;
    }
    if (lines.length === 0) lines.push([]);
    const index = chars.length;
    lines[lines.length - 1].push(index);
    chars.push({
      index,
      ch,
      rect,
      baselineY: baseline,
      objectId: obj >= 0 && obj < objects.length ? objects[obj] : null,
      offset: Math.max(0, off | 0),
      generated: gen === 1,
      line: lines.length - 1,
    });
  }
  return { pageIndex: Number(data.pageIndex) || 0, chars, lines };
}

const hasBox = (c: PdfChar) => c.rect.width > 0 && c.rect.height > 0;

function lineBand(page: PdfPageChars, line: number): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const i of page.lines[line] ?? []) {
    const c = page.chars[i];
    if (!hasBox(c)) continue;
    top = Math.min(top, c.rect.y);
    bottom = Math.max(bottom, c.rect.y + c.rect.height);
  }
  return Number.isFinite(top) ? { top, bottom } : null;
}

/**
 * Character at (or nearest to) a document point. With `tolerance`, null when nothing is that
 * close (long press); without it, always the nearest character of the nearest line (handles).
 */
export function charAtPoint(page: PdfPageChars, point: { x: number; y: number }, tolerance?: number): number | null {
  let bestLine = -1;
  let bestLineDist = Infinity;
  page.lines.forEach((_, li) => {
    const band = lineBand(page, li);
    if (!band) return;
    const d = point.y < band.top ? band.top - point.y : point.y > band.bottom ? point.y - band.bottom : 0;
    if (d < bestLineDist) {
      bestLineDist = d;
      bestLine = li;
    }
  });
  if (bestLine < 0 || (tolerance !== undefined && bestLineDist > tolerance)) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const i of page.lines[bestLine]) {
    const c = page.chars[i];
    if (!hasBox(c)) continue;
    const d = point.x < c.rect.x ? c.rect.x - point.x : point.x > c.rect.x + c.rect.width ? point.x - (c.rect.x + c.rect.width) : 0;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best === null || (tolerance !== undefined && bestDist > tolerance)) return null;
  return best;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const JOINER = /['’\-‐]/u;

function isWordChar(page: PdfPageChars, i: number): boolean {
  const c = page.chars[i];
  if (!c || c.generated || isLineBreak(c.ch)) return false;
  if (WORD_CHAR.test(c.ch)) return true;
  // apostrophes / hyphens inside a word (don't, well-known)
  if (JOINER.test(c.ch)) {
    const prev = page.chars[i - 1];
    const next = page.chars[i + 1];
    return !!prev && !!next && WORD_CHAR.test(prev.ch) && WORD_CHAR.test(next.ch) && prev.line === c.line && next.line === c.line;
  }
  return false;
}

/** The word containing character `index` (punctuation / spaces select just themselves). */
export function wordRangeAt(page: PdfPageChars, index: number): PdfCharRange {
  if (!isWordChar(page, index)) return { start: index, end: index };
  let start = index;
  let end = index;
  while (start > 0 && isWordChar(page, start - 1) && page.chars[start - 1].line === page.chars[index].line) start--;
  while (end < page.chars.length - 1 && isWordChar(page, end + 1) && page.chars[end + 1].line === page.chars[index].line) end++;
  return { start, end };
}

export function normalizeRange(a: number, b: number): PdfCharRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Selection bands: one rectangle per line, spanning the selected characters. */
export function rangeRects(page: PdfPageChars, range: PdfCharRange): PdfRect[] {
  const byLine = new Map<number, { l: number; r: number; t: number; b: number }>();
  for (let i = range.start; i <= range.end; i++) {
    const c = page.chars[i];
    if (!c || !hasBox(c)) continue;
    const band = byLine.get(c.line);
    if (!band) byLine.set(c.line, { l: c.rect.x, r: c.rect.x + c.rect.width, t: c.rect.y, b: c.rect.y + c.rect.height });
    else {
      band.l = Math.min(band.l, c.rect.x);
      band.r = Math.max(band.r, c.rect.x + c.rect.width);
      band.t = Math.min(band.t, c.rect.y);
      band.b = Math.max(band.b, c.rect.y + c.rect.height);
    }
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ x: v.l, y: v.t, width: v.r - v.l, height: v.b - v.t }));
}

/** Handle anchors: caret at the start / end of the selection, spanning the line height. */
export function rangeHandles(
  page: PdfPageChars,
  range: PdfCharRange,
): { start: { x: number; top: number; bottom: number }; end: { x: number; top: number; bottom: number } } | null {
  const first = firstBoxed(page, range.start, range.end, 1);
  const last = firstBoxed(page, range.end, range.start, -1);
  if (first === null || last === null) return null;
  const a = page.chars[first].rect;
  const b = page.chars[last].rect;
  return {
    start: { x: a.x, top: a.y, bottom: a.y + a.height },
    end: { x: b.x + b.width, top: b.y, bottom: b.y + b.height },
  };
}

function firstBoxed(page: PdfPageChars, from: number, to: number, step: 1 | -1): number | null {
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
    if (page.chars[i] && hasBox(page.chars[i])) return i;
  }
  return null;
}

/** Selected text as it reads (line breaks kept, generated spaces included). */
export function rangeText(page: PdfPageChars, range: PdfCharRange): string {
  let out = '';
  for (let i = range.start; i <= range.end; i++) {
    const c = page.chars[i];
    if (!c) continue;
    if (c.ch === '\r') continue;
    out += c.ch;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/^\s+|\s+$/g, '');
}

/** Characters-of-selection markup rectangles; underline / strikethrough from exact baselines. */
export function rangeMarkRects(page: PdfPageChars, range: PdfCharRange, style: PdfTextMarkStyle): PdfRect[] {
  const bands = rangeRects(page, range);
  if (style === 'highlight') return bands;
  const byLine = new Map<number, number[]>();
  for (let i = range.start; i <= range.end; i++) {
    const c = page.chars[i];
    if (!c || !hasBox(c) || c.generated) continue;
    const list = byLine.get(c.line) ?? [];
    list.push(c.baselineY);
    byLine.set(c.line, list);
  }
  const baselines = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((p, q) => p - q)[Math.floor(v.length / 2)]);
  return bands.map((band, i) => {
    const baseline = baselines[i];
    if (baseline === undefined || baseline < band.y || baseline > band.y + band.height + 0.5) return band;
    const em = band.height / 1.17;
    if (style === 'underline') {
      const lineW = Math.max(0.75, em * 0.07);
      return { x: band.x, y: baseline + em * 0.1 + lineW / 2 - em, width: band.width, height: em };
    }
    return { x: band.x, y: baseline - em * 0.85, width: band.width, height: em };
  });
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Markup operation (highlight / underline / strikethrough) for a character selection. */
export function rangeMarkOperation(
  page: PdfPageChars,
  range: PdfCharRange,
  style: PdfTextMarkStyle,
  color: string,
): PdfDocumentOperation {
  return {
    type: 'addHighlight',
    pageIndex: page.pageIndex,
    style,
    rects: rangeMarkRects(page, range, style),
    color: HEX.test(color) ? color.toUpperCase() : DEFAULT_ANNOTATION_COLORS[style],
    opacity: style === 'highlight' ? 0.5 : 1,
  };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export interface RangeEditItem {
  readonly objectId: string;
  /** New full text of the object, or null to delete it. */
  readonly newText: string | null;
}

export interface RangeEditPlan {
  readonly items: readonly RangeEditItem[];
  /** True when every touched object is completely inside the selection. */
  readonly wholeObjects: boolean;
  /** Ids of the touched objects in reading order. */
  readonly objectIds: readonly string[];
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * Plans replacing (or, with replacement '', deleting) the selected characters. Returns an error
 * string when the selection cannot be edited reliably (no text objects, or an object's
 * characters do not match its text, e.g. ligatures, when only part of it is selected).
 */
export function planRangeEdit(
  page: PdfPageChars,
  range: PdfCharRange,
  replacement: string,
  objects: ReadonlyMap<string, PdfTextObject>,
): RangeEditPlan | { error: string } {
  const touched: string[] = [];
  const selected = new Map<string, Set<number>>();
  for (let i = range.start; i <= range.end; i++) {
    const c = page.chars[i];
    if (!c || c.generated || !c.objectId) continue;
    if (!selected.has(c.objectId)) {
      selected.set(c.objectId, new Set());
      touched.push(c.objectId);
    }
    selected.get(c.objectId)!.add(c.offset);
  }
  if (touched.length === 0) return { error: 'There is no editable text in the selection.' };

  const charsOf = (id: string) =>
    page.chars.filter((c) => c.objectId === id && !c.generated).sort((a, b) => a.offset - b.offset);

  const items: RangeEditItem[] = [];
  let wholeObjects = true;
  let mismatch = false;
  touched.forEach((id, k) => {
    const all = charsOf(id);
    const sel = selected.get(id)!;
    const whole = all.every((c) => sel.has(c.offset));
    if (!whole) wholeObjects = false;
    const obj = objects.get(id);
    // Partial edits rebuild the object's text from its characters: they must match exactly
    if (!whole && obj && squash(all.map((c) => c.ch).join('')) !== squash(obj.text)) mismatch = true;
    const minSel = Math.min(...sel);
    const maxSel = Math.max(...sel);
    const prefix = all.filter((c) => c.offset < minSel).map((c) => c.ch).join('');
    const suffix = all.filter((c) => c.offset > maxSel).map((c) => c.ch).join('');
    let text: string;
    if (k === 0) {
      text = prefix + replacement + (touched.length === 1 ? suffix : '');
    } else if (k === touched.length - 1) {
      text = suffix;
    } else {
      text = '';
    }
    items.push({ objectId: id, newText: text.trim().length > 0 ? text : null });
  });
  if (mismatch) {
    return { error: 'Part of this text cannot be edited separately. Select the whole word to change it.' };
  }
  return { items, wholeObjects, objectIds: touched };
}
