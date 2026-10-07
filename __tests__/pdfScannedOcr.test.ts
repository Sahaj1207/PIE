/**
 * Scanned PDF pages: on-device text recognition (render -> OCR -> page points), selection,
 * copy, search, and the replace / remove operations written back through the verified
 * document-operations path.
 */
import { NativeModules } from 'react-native';
import {
  PDF_OCR_MAX_PIXELS,
  PdfOcrRegion,
  buildOcrEditOperations,
  fitReplacementFontSize,
  hitTestOcrRegions,
  isLikelyScannedPage,
  mergeSearchResults,
  ocrPageText,
  pdfOcrRenderScale,
  recognizePdfPage,
  regionsFromOcr,
  searchOcrPages,
  unsupportedOcrReplacementChars,
} from '../src/features/pdf/pdfOcr';
import { validateDocumentOperations } from '../src/features/pdf/pdfDocumentOperations';
import { TextRegion } from '../src/types/document';

declare const __dirname: string;

const region = (id: string, text: string, x: number, y: number, w = 100, h = 12): PdfOcrRegion => ({
  id,
  pageIndex: 0,
  text,
  rect: { x, y, width: w, height: h },
});

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
  delete (NativeModules as any).OcrNativeModule;
  delete (NativeModules as any).ImageProcessingModule;
});

describe('scanned page detection and render scale', () => {
  it('treats pages without (meaningful) text objects as scans', () => {
    expect(isLikelyScannedPage([])).toBe(true);
    expect(isLikelyScannedPage([{ text: ' ' }, { text: '.' }])).toBe(true);
    expect(isLikelyScannedPage([{ text: 'Notice regarding ID card' }])).toBe(false);
  });

  it('renders at ~300 dpi within the OCR pixel budget', () => {
    expect(pdfOcrRenderScale(595, 842)).toBeCloseTo(300 / 72, 5); // A4: 8.7 MP
    const big = pdfOcrRenderScale(2384, 3370); // A0-ish
    expect(2384 * 3370 * big * big).toBeLessThanOrEqual(PDF_OCR_MAX_PIXELS + 1);
    expect(pdfOcrRenderScale(0, 0)).toBe(2);
  });
});

describe('recognised regions', () => {
  it('maps OCR pixels to page points and drops empty lines', () => {
    const ocr: TextRegion[] = [
      { id: 'a', pageIndex: 0, bounds: { x: 417, y: 834, width: 834, height: 83 }, originalText: ' NOTICE ', currentText: 'NOTICE', status: 'detected', style: { fontSize: 60, color: '#000' } },
      { id: 'b', pageIndex: 0, bounds: { x: 0, y: 0, width: 10, height: 10 }, originalText: '  ', currentText: '', status: 'detected', style: { fontSize: 8, color: '#000' } },
    ];
    const out = regionsFromOcr(ocr, 300 / 72, 0);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('NOTICE');
    expect(out[0].rect.x).toBeCloseTo(100.08, 2);
    expect(out[0].rect.height).toBeCloseTo(19.92, 2);
  });

  it('hit-tests the containing line, else the nearest within the finger tolerance', () => {
    const regions = [region('1', 'First', 50, 100), region('2', 'Second', 50, 120)];
    expect(hitTestOcrRegions(regions, { x: 60, y: 105 }, 10)?.id).toBe('1');
    expect(hitTestOcrRegions(regions, { x: 60, y: 117 }, 10)?.id).toBe('2'); // 3 pt above "Second"
    expect(hitTestOcrRegions(regions, { x: 400, y: 400 }, 10)).toBeNull();
  });

  it('copies page text in reading order', () => {
    const regions = [region('b', 'World', 200, 101), region('a', 'Hello', 50, 100), region('c', 'Next line', 50, 130)];
    expect(ocrPageText(regions)).toBe('Hello\nWorld\nNext line');
  });

  it('searches recognised pages (case-insensitive, every occurrence) and merges with text-layer hits', () => {
    const ocr = searchOcrPages({ 2: [region('x', 'ID card and id CARD', 0, 50, 190)] }, 'card');
    expect(ocr).toHaveLength(2);
    expect(ocr[0]).toMatchObject({ pageIndex: 2, matchStart: 3, matchLength: 4 });
    expect(ocr[0].rects[0].x).toBeCloseTo(30, 5);
    const merged = mergeSearchResults([{ pageIndex: 3, charIndex: 0, snippet: 's', matchStart: 0, matchLength: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }] }], ocr);
    expect(merged.map((r) => r.pageIndex)).toEqual([2, 2, 3]);
    expect(searchOcrPages({ 0: [region('x', 'abc', 0, 0)] }, '  ')).toEqual([]);
  });

  it('fits replacement text to the scanned line', () => {
    const rect = { x: 0, y: 0, width: 100, height: 20 };
    expect(fitReplacementFontSize('Hi', rect)).toBe(16);
    const long = fitReplacementFontSize('A much longer replacement sentence', rect);
    expect(long).toBeLessThan(16);
    expect(long).toBeGreaterThanOrEqual(4);
    expect(unsupportedOcrReplacementChars('₹ 500')).toEqual(['₹']);
    expect(unsupportedOcrReplacementChars('Rs. 500')).toEqual([]);
  });
});

describe('native pipeline', () => {
  function installNatives() {
    const renderPage = jest.fn().mockResolvedValue({ filePath: '/c/r.png', uri: 'file:///c/r.png', width: 2481, height: 3509, scale: 4.17, pageIndex: 0 });
    const recognizeTextWithOptions = jest.fn().mockResolvedValue({
      fullText: 'NOTICE',
      imageWidth: 2481,
      imageHeight: 3509,
      blocks: [{ text: 'NOTICE', boundingBox: { x: 417, y: 834, width: 834, height: 83 }, lines: [{ text: 'NOTICE', boundingBox: { x: 417, y: 834, width: 834, height: 83 }, words: [] }] }],
    });
    const reconstructBackground = jest.fn().mockResolvedValue({
      patchUri: 'file:///c/patch.png',
      bounds: { x: 412, y: 829, width: 844, height: 93 },
      estimatedTextColor: '#1A1A1A',
    });
    const prepareImageForPdf = jest.fn().mockResolvedValue({ path: '/c/patch.jpg', width: 844, height: 93 });
    (NativeModules as any).PdfiumNativeModule = { renderPage, prepareImageForPdf };
    (NativeModules as any).OcrNativeModule = { recognizeText: jest.fn(), recognizeTextWithOptions };
    (NativeModules as any).ImageProcessingModule = { reconstructBackground };
    return { renderPage, recognizeTextWithOptions, reconstructBackground, prepareImageForPdf };
  }

  it('recognises a page from a ~300 dpi PDFium render, in page points', async () => {
    const n = installNatives();
    const result = await recognizePdfPage(7, 0, 595, 842);
    expect(n.renderPage).toHaveBeenCalledWith(7, 0, expect.closeTo(300 / 72, 5));
    expect(n.recognizeTextWithOptions).toHaveBeenCalledWith('file:///c/r.png', expect.objectContaining({ flattenAlpha: true }));
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].text).toBe('NOTICE');
    expect(result.regions[0].rect.x).toBeCloseTo(417 / (2481 / 595), 3);
  });

  it('replace = rebuilt background patch + new text in one batch; delete = patch only', async () => {
    const n = installNatives();
    const page = { w: 595, h: 842 };
    const k = 2481 / page.w;
    const target = region('r', 'NOTICE', 417 / k, 834 / k, 834 / k, 83 / k);

    const replaceOps = await buildOcrEditOperations(7, target, page.w, page.h, 'NOTICE 2026');
    expect(n.reconstructBackground).toHaveBeenCalledWith('file:///c/r.png', expect.closeTo(417, 3), expect.closeTo(834, 3), expect.closeTo(834, 3), expect.closeTo(83, 3));
    expect(replaceOps.map((o) => o.type)).toEqual(['addImage', 'addText']);
    expect(replaceOps[0]).toMatchObject({ imagePath: '/c/patch.jpg', pageIndex: 0 });
    expect((replaceOps[0] as any).rect.x).toBeCloseTo(412 / k, 3);
    expect(replaceOps[1]).toMatchObject({ text: 'NOTICE 2026', fontName: 'Helvetica', color: '#1A1A1A' });
    expect(() => validateDocumentOperations(replaceOps, 1)).not.toThrow();

    const deleteOps = await buildOcrEditOperations(7, target, page.w, page.h, null);
    expect(deleteOps.map((o) => o.type)).toEqual(['addImage']);
  });
});

describe('native addText operation (static)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs: { readFileSync(f: string, e: 'utf8'): string } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path: { join(...p: string[]): string } = require('path');

  it('writes WinAnsi standard-14 text only, upright on the displayed page', () => {
    const ops = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/cpp/pdfium/pie_pdf_ops.h'), 'utf8');
    expect(ops).toContain('type == "addText"');
    expect(ops).toContain('pie::isWinAnsiEncodable(cp)');
    expect(ops).toContain('FPDFPageObj_NewTextObj(doc, font.c_str()');
    expect(ops).toContain('r.type == "addText"');
  });
});
