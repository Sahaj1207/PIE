/**
 * On-device text recognition for scanned PDF pages (pages that are pictures with no text
 * layer, e.g. "HP Scan" output). Reuses the existing pipeline end to end:
 *
 *   PDFium render of the page  ->  OCR engine (ML Kit / Vision, with its preprocessing)
 *   -> regions in page display points (selection, copy, search)
 *
 * Editing recognised text reuses the image editor's deterministic background reconstruction
 * on the same render; the cleaned patch (and, for a replacement, new standard-14 text) is
 * written into the PDF as page content through the verified document-operations path, so it
 * is one undoable revision like every other PDF edit. Nothing leaves the device.
 */
import { TextRegion } from '../../types/document';
import { defaultOcrEngine } from '../ocr/engine';
import { defaultReconstructionEngine } from '../image/reconstructionEngine';
import { defaultPdfiumEngine } from './pdfiumEngine';
import { PdfDocumentOperation, PdfSearchResult, prepareImageForPdf } from './pdfDocumentOperations';
import { PdfTextObject } from './types';
import { standardTextWidth } from './pdfTextBox';
import { findUnsupportedStandardFontChars } from './pdfGlyphCoverage';

export interface PdfOcrRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One recognised line of a scanned page, in page display points (top-left origin). */
export interface PdfOcrRegion {
  readonly id: string;
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfOcrRect;
  readonly confidence?: number;
}

export interface PdfOcrPageResult {
  readonly pageIndex: number;
  readonly regions: readonly PdfOcrRegion[];
  /** Pixels per point of the render the regions came from. */
  readonly renderScale: number;
}

/** ~300 dpi: what recognisers are tuned for. */
export const PDF_OCR_TARGET_SCALE = 300 / 72;
/** Never render below 2 px/pt (small text would be lost). */
export const PDF_OCR_MIN_SCALE = 2;
/** Same pixel budget as the OCR preprocessing (memory safety). */
export const PDF_OCR_MAX_PIXELS = 16_000_000;

/** Render scale (px/pt) for recognising a page of the given size in points. */
export function pdfOcrRenderScale(pageWidth: number, pageHeight: number): number {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return PDF_OCR_MIN_SCALE;
  const budget = Math.sqrt(PDF_OCR_MAX_PIXELS / (pageWidth * pageHeight));
  return Math.max(Math.min(PDF_OCR_TARGET_SCALE, budget), Math.min(PDF_OCR_MIN_SCALE, budget));
}

/**
 * True when a page has (almost) no extractable text: it is a picture of text and needs OCR
 * before anything can be selected, copied, searched or edited.
 */
export function isLikelyScannedPage(textObjects: readonly Pick<PdfTextObject, 'text'>[]): boolean {
  const chars = textObjects.reduce((n, o) => n + (o.text || '').replace(/\s+/g, '').length, 0);
  return chars < 3;
}

/** OCR regions (render pixels) -> page regions (display points). Empty text is dropped. */
export function regionsFromOcr(regions: readonly TextRegion[], renderScale: number, pageIndex: number): PdfOcrRegion[] {
  if (!(renderScale > 0)) return [];
  return regions
    .map((r, i) => ({
      id: `ocr_${pageIndex}_${i}`,
      pageIndex,
      text: (r.originalText || '').trim(),
      rect: {
        x: r.bounds.x / renderScale,
        y: r.bounds.y / renderScale,
        width: r.bounds.width / renderScale,
        height: r.bounds.height / renderScale,
      },
      confidence: r.confidence,
    }))
    .filter((r) => r.text.length > 0 && r.rect.width > 0 && r.rect.height > 0);
}

function distanceToRect(r: PdfOcrRect, p: { x: number; y: number }): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** Smallest region containing the point, else the nearest within `tolerance` points. */
export function hitTestOcrRegions(
  regions: readonly PdfOcrRegion[],
  point: { x: number; y: number },
  tolerance: number,
): PdfOcrRegion | null {
  let best: PdfOcrRegion | null = null;
  let bestArea = Infinity;
  for (const r of regions) {
    if (distanceToRect(r.rect, point) === 0) {
      const area = r.rect.width * r.rect.height;
      if (area < bestArea) {
        best = r;
        bestArea = area;
      }
    }
  }
  if (best) return best;
  let bestDist = tolerance;
  for (const r of regions) {
    const d = distanceToRect(r.rect, point);
    if (d <= bestDist) {
      best = r;
      bestDist = d;
    }
  }
  return best;
}

/** Recognised text of a page in reading order (lines top to bottom, left to right). */
export function ocrPageText(regions: readonly PdfOcrRegion[]): string {
  const sorted = [...regions].sort((a, b) => {
    const sameLine = Math.abs(a.rect.y - b.rect.y) < Math.min(a.rect.height, b.rect.height) * 0.5;
    return sameLine ? a.rect.x - b.rect.x : a.rect.y - b.rect.y;
  });
  return sorted.map((r) => r.text).join('\n');
}

/** Case-insensitive search over recognised pages (same result shape as PDFium search). */
export function searchOcrPages(
  pages: Readonly<Record<number, readonly PdfOcrRegion[]>>,
  query: string,
): PdfSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: PdfSearchResult[] = [];
  const pageIndexes = Object.keys(pages)
    .map(Number)
    .sort((a, b) => a - b);
  for (const pageIndex of pageIndexes) {
    for (const r of pages[pageIndex] ?? []) {
      const lower = r.text.toLowerCase();
      let from = 0;
      for (let at = lower.indexOf(q, from); at >= 0; at = lower.indexOf(q, from)) {
        // Approximate the match rectangle by the share of characters (monospace assumption).
        const n = Math.max(1, r.text.length);
        const x = r.rect.x + (r.rect.width * at) / n;
        const width = Math.max(2, (r.rect.width * q.length) / n);
        results.push({
          pageIndex,
          charIndex: at,
          snippet: r.text,
          matchStart: at,
          matchLength: q.length,
          rects: [{ x, y: r.rect.y, width, height: r.rect.height }],
        });
        from = at + q.length;
      }
    }
  }
  return results;
}

/** Merges native (text-layer) and OCR results in page order. */
export function mergeSearchResults(
  native: readonly PdfSearchResult[],
  ocr: readonly PdfSearchResult[],
): PdfSearchResult[] {
  return [...native, ...ocr].sort((a, b) => a.pageIndex - b.pageIndex || a.rects[0]?.y - b.rects[0]?.y || 0);
}

/** Recognised line boxes span ascender to descender: about 1.15 em of the font. */
export const OCR_LINE_HEIGHT_EM = 1.15;
/** Baseline position inside a recognised line box (fraction of its height from the top). */
export const OCR_BASELINE_RATIO = 0.78;

/**
 * Measured ink of the scanned line: its horizontal extent (page points) and the text OCR read
 * from it. When given, the printed size is taken from how wide that text was printed, which is
 * far more precise than the line box height (OCR boxes are loose by a few pixels).
 */
export interface OcrInkReference {
  readonly text: string;
  readonly width: number;
}

/**
 * Font size (points) for writing `text` into a recognised line box: the size the scanned line
 * was printed at, reduced only when the new text would run well past the original width.
 */
export function fitReplacementFontSize(
  text: string,
  rect: PdfOcrRect,
  fontName = 'Helvetica',
  ink?: OcrInkReference,
): number {
  const family = fontName.startsWith('Times') ? 'Times-Roman' : fontName.startsWith('Courier') ? 'Courier' : 'Helvetica';
  const bold = fontName.includes('Bold');
  const byHeight = Math.max(4, rect.height / OCR_LINE_HEIGHT_EM);
  let size = byHeight;
  const unit = ink ? standardTextWidth(ink.text.trim(), family, 1, bold) : 0;
  if (ink && unit > 0 && ink.width > 0) {
    // Guard against misread text: stay within a sensible band around the height estimate.
    size = Math.min(byHeight * 1.35, Math.max(byHeight * 0.8, ink.width / unit));
  }
  const width = standardTextWidth(text, family, size, bold);
  const limit = Math.max(rect.width, ink?.width ?? 0) * 1.25;
  if (width <= 0 || width <= limit) return Math.round(size * 10) / 10;
  return Math.max(4, Math.round(size * (limit / width) * 10) / 10);
}

/**
 * Area to rebuild behind a recognised line. OCR boxes hug the glyphs (and scans are often a
 * little tilted), so edges and descenders would survive a box-sized patch. The box grows by
 * half its height left/right and 35 % up/down, but never into a neighbouring recognised line
 * and never past the page.
 */
export function ocrCoverRect(
  region: PdfOcrRegion,
  neighbours: readonly PdfOcrRegion[],
  page: { width: number; height: number },
): PdfOcrRect {
  const r = region.rect;
  let left = r.x - r.height * 0.5;
  let right = r.x + r.width + r.height * 0.5;
  let top = r.y - r.height * 0.35;
  let bottom = r.y + r.height * 1.35;
  for (const n of neighbours) {
    if (n.id === region.id) continue;
    const o = n.rect;
    const overlapsX = o.x < right && o.x + o.width > left;
    const overlapsY = o.y < bottom && o.y + o.height > top;
    if (!overlapsX || !overlapsY) continue;
    const gap = 0.5;
    if (o.y + o.height <= r.y) top = Math.max(top, o.y + o.height + gap); // line above
    else if (o.y >= r.y + r.height) bottom = Math.min(bottom, o.y - gap); // line below
    else if (o.x + o.width <= r.x) left = Math.max(left, o.x + o.width + gap); // same line, left
    else if (o.x >= r.x + r.width) right = Math.min(right, o.x - gap); // same line, right
  }
  left = Math.max(0, Math.min(left, r.x));
  top = Math.max(0, Math.min(top, r.y));
  right = Math.min(page.width, Math.max(right, r.x + r.width));
  bottom = Math.min(page.height, Math.max(bottom, r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Characters the standard PDF fonts cannot write (the user must change them first). */
export function unsupportedOcrReplacementChars(text: string): string[] {
  return findUnsupportedStandardFontChars(text);
}

// ---------------------------------------------------------------------------
// Native pipeline
// ---------------------------------------------------------------------------

/** Renders the page at OCR resolution and recognises its text (on-device). */
export async function recognizePdfPage(
  docHandle: number,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
): Promise<PdfOcrPageResult> {
  const scale = pdfOcrRenderScale(pageWidth, pageHeight);
  const render = await defaultPdfiumEngine.renderPage(docHandle, pageIndex, { scale });
  const regions = await defaultOcrEngine.extractTextRegions(render.uri, pageIndex, {
    imageSize: { width: render.width, height: render.height },
  });
  const effective = render.width / Math.max(1e-6, pageWidth);
  return { pageIndex, regions: regionsFromOcr(regions, effective, pageIndex), renderScale: effective };
}

/**
 * Document operations that remove (text === null) or replace a recognised line: the
 * background behind it is rebuilt from the page render (same deterministic reconstruction as
 * the image editor) and placed over it; a replacement then writes the new text on top.
 */
export async function buildOcrEditOperations(
  docHandle: number,
  region: PdfOcrRegion,
  pageWidth: number,
  pageHeight: number,
  newText: string | null,
  options: { readonly neighbours?: readonly PdfOcrRegion[] } = {},
): Promise<PdfDocumentOperation[]> {
  const scale = pdfOcrRenderScale(pageWidth, pageHeight);
  const render = await defaultPdfiumEngine.renderPage(docHandle, region.pageIndex, { scale });
  const k = render.width / Math.max(1e-6, pageWidth);
  const cover = ocrCoverRect(region, options.neighbours ?? [], { width: pageWidth, height: pageHeight });
  const patch = await defaultReconstructionEngine.reconstructBackground(render.uri, {
    x: cover.x * k,
    y: cover.y * k,
    width: cover.width * k,
    height: cover.height * k,
  });
  const jpeg = await prepareImageForPdf(patch.patchUri);
  const ops: PdfDocumentOperation[] = [
    {
      type: 'addImage',
      pageIndex: region.pageIndex,
      imagePath: jpeg.path,
      rect: {
        x: patch.bounds.x / k,
        y: patch.bounds.y / k,
        width: patch.bounds.width / k,
        height: patch.bounds.height / k,
      },
    },
  ];
  const text = newText?.replace(/\s+/g, ' ').trim();
  if (text) {
    // Measured ink (inside the cover area) beats the OCR box for where and how big the line was.
    const inkBox = patch.inkBounds;
    const ink =
      inkBox && inkBox.width > 0 && inkBox.x / k >= cover.x - 0.5 && (inkBox.x + inkBox.width) / k <= cover.x + cover.width + 0.5
        ? { x: inkBox.x / k, width: inkBox.width / k }
        : null;
    const fontSize = fitReplacementFontSize(text, region.rect, 'Helvetica', ink ? { text: region.text, width: ink.width } : undefined);
    const color = [patch.inkColor, patch.estimatedTextColor].find((c) => c && /^#[0-9a-fA-F]{6}$/.test(c));
    ops.push({
      type: 'addText',
      pageIndex: region.pageIndex,
      text,
      x: ink ? ink.x : region.rect.x,
      y: region.rect.y + region.rect.height * OCR_BASELINE_RATIO,
      fontSize,
      fontName: 'Helvetica',
      color: color ?? '#000000',
    });
  }
  return ops;
}
