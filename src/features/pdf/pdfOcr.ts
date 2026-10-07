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

/**
 * Font size (points) for writing `text` into a recognised line box: about 80 % of the line
 * height, reduced when needed so the text fits the original width (+15 %).
 */
export function fitReplacementFontSize(text: string, rect: PdfOcrRect, fontName = 'Helvetica'): number {
  const bySize = Math.max(4, rect.height * 0.8);
  const family = fontName.startsWith('Times') ? 'Times-Roman' : fontName.startsWith('Courier') ? 'Courier' : 'Helvetica';
  const width = standardTextWidth(text, family, bySize, fontName.includes('Bold'));
  if (width <= 0 || width <= rect.width * 1.15) return Math.round(bySize * 10) / 10;
  return Math.max(4, Math.round(bySize * ((rect.width * 1.15) / width) * 10) / 10);
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
): Promise<PdfDocumentOperation[]> {
  const scale = pdfOcrRenderScale(pageWidth, pageHeight);
  const render = await defaultPdfiumEngine.renderPage(docHandle, region.pageIndex, { scale });
  const k = render.width / Math.max(1e-6, pageWidth);
  const patch = await defaultReconstructionEngine.reconstructBackground(render.uri, {
    x: region.rect.x * k,
    y: region.rect.y * k,
    width: region.rect.width * k,
    height: region.rect.height * k,
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
    const fontSize = fitReplacementFontSize(text, region.rect);
    ops.push({
      type: 'addText',
      pageIndex: region.pageIndex,
      text,
      x: region.rect.x,
      // Baseline: line box minus the descender share (~20 %).
      y: region.rect.y + region.rect.height * 0.8,
      fontSize,
      fontName: 'Helvetica',
      color: patch.estimatedTextColor && /^#[0-9a-fA-F]{6}$/.test(patch.estimatedTextColor) ? patch.estimatedTextColor : '#000000',
    });
  }
  return ops;
}
