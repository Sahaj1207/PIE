/**
 * Fix pass — image OCR input preparation / coordinate safety and tolerant PDF text selection.
 */
import { NativeModules } from 'react-native';
import {
  OCR_MAX_PIXELS,
  alignRegionsToDocument,
  nativeOcrOptions,
  planOcrInput,
} from '../src/features/ocr/ocrPreprocessing';
import { OnDeviceOcrEngine } from '../src/features/ocr/engine';
import { TextRegion } from '../src/types/document';
import {
  PDF_TAP_TOLERANCE_PT,
  hitTestTextObjects,
  pdfTapToleranceDocPoints,
} from '../src/features/pdf/pdfiumEngine';
import { PdfTextObject } from '../src/features/pdf/types';
import { rotationDisplayMatrix, userBoundsToDisplayRect, userToDisplayPoint } from '../src/features/pdf/pdfPageGeometry';

// Node built-ins (Jest runs on Node), typed locally: the RN tsconfig loads only jest types.
declare const __dirname: string;

describe('Fix — OCR input plan (deterministic, on-device)', () => {
  it('leaves normal photos untouched', () => {
    expect(planOcrInput(4000, 3000)).toEqual({ scale: 1, reason: 'none' });
    expect(planOcrInput(1920, 1080)).toEqual({ scale: 1, reason: 'none' });
  });

  it('downscales very large images to the decode budget (prevents OOM)', () => {
    const plan = planOcrInput(8000, 6000); // 48 MP
    expect(plan.reason).toBe('downscale');
    expect(8000 * 6000 * plan.scale ** 2).toBeLessThanOrEqual(OCR_MAX_PIXELS);
    expect(plan.scale).toBeGreaterThan(0.5);
  });

  it('upscales small images so small text reaches the recognizer minimum (max 3x)', () => {
    expect(planOcrInput(640, 480)).toEqual({ scale: 3, reason: 'upscale' });
    expect(planOcrInput(1000, 200)).toEqual({ scale: 1.92, reason: 'upscale' });
    expect(planOcrInput(1200, 900)).toEqual({ scale: 1.6, reason: 'upscale' });
    expect(planOcrInput(1270, 1270).scale).toBe(1.511);
  });

  it('skips negligible upscales and invalid sizes', () => {
    expect(planOcrInput(1279, 100).reason).toBe('upscale'); // 1.501
    expect(planOcrInput(0, 0)).toEqual({ scale: 1, reason: 'none' });
    expect(nativeOcrOptions(640, 480)).toEqual({ scale: 3, flattenAlpha: true });
  });
});

describe('Fix — OCR regions always land in document coordinates', () => {
  const r = (bounds: TextRegion['bounds']): TextRegion => ({
    id: 'r', pageIndex: 0, bounds, originalText: 'A', currentText: 'A', status: 'detected', style: { fontSize: 20, color: '#000' },
  });

  it('returns regions unchanged when the OCR grid equals the document', () => {
    const regions = [r({ x: 10, y: 20, width: 100, height: 30 })];
    expect(alignRegionsToDocument(regions, { width: 1000, height: 800 }, { width: 1000, height: 800 })).toEqual(regions);
  });

  it('rescales regions from a different OCR pixel grid (e.g. a legacy source asset)', () => {
    const regions = [r({ x: 100, y: 50, width: 200, height: 40 })];
    const aligned = alignRegionsToDocument(regions, { width: 2000, height: 1000 }, { width: 1000, height: 500 });
    expect(aligned[0].bounds).toEqual({ x: 50, y: 25, width: 100, height: 20 });
    expect(aligned[0].style.fontSize).toBe(10);
  });

  it('the engine uses the preprocessing native path with the planned scale and aligns results', async () => {
    const withOptions = jest.fn().mockResolvedValue({
      fullText: 'Total 42',
      imageWidth: 640,
      imageHeight: 480,
      blocks: [
        { text: 'Total 42', boundingBox: { x: 10, y: 20, width: 200, height: 30 }, lines: [{ text: 'Total 42', boundingBox: { x: 10, y: 20, width: 200, height: 30 }, words: [] }] },
      ],
    });
    const legacy = jest.fn();
    (NativeModules as any).OcrNativeModule = { recognizeText: legacy, recognizeTextWithOptions: withOptions };
    const regions = await new OnDeviceOcrEngine().extractTextRegions('file:///w/working.png', 0, { imageSize: { width: 640, height: 480 } });
    expect(withOptions).toHaveBeenCalledWith('file:///w/working.png', { scale: 3, flattenAlpha: true });
    expect(legacy).not.toHaveBeenCalled();
    expect(regions).toHaveLength(1);
    expect(regions[0].bounds).toEqual({ x: 10, y: 20, width: 200, height: 30 });
    delete (NativeModules as any).OcrNativeModule;
  });

  it('falls back to the original native call when the preprocessing path is unavailable', async () => {
    const legacy = jest.fn().mockResolvedValue({ fullText: '', imageWidth: 100, imageHeight: 100, blocks: [] });
    (NativeModules as any).OcrNativeModule = { recognizeText: legacy };
    await new OnDeviceOcrEngine().extractTextRegions('file:///w/a.jpg', 0, { imageSize: { width: 100, height: 100 } });
    expect(legacy).toHaveBeenCalledWith('file:///w/a.jpg');
    delete (NativeModules as any).OcrNativeModule;
  });

  it('native preprocessing contract: EXIF upright decode, bounded sampling, alpha flatten, box mapping', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: { readFileSync(file: string, encoding: 'utf8'): string } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path: { join(...parts: string[]): string } = require('path');
    const kt = fs.readFileSync(
      path.join(__dirname, '..', 'android/app/src/main/java/com/com.pdfimageeditor/ocr/OcrModule.kt'),
      'utf8',
    );
    expect(kt).toContain('fun recognizeTextWithOptions(');
    expect(kt).toContain('InputImage.fromBitmap(image.bitmap, 0)');
    expect(kt).toContain('readExifOrientation(uri)');
    expect(kt).toContain('exifMatrix(orientation)');
    expect(kt).toContain('inSampleSize = sample');
    expect(kt).toContain('MAX_OCR_PIXELS = 16_000_000L');
    expect(kt).toContain('canvas.drawColor(contrastingBackground(bitmap))');
    expect(kt).toContain('rect.left / scaleX');
    expect(kt).not.toMatch(/http(s)?:\/\/(?!schemas)/); // no network endpoints
  });
});

describe('Fix — tolerant, iOS-like PDF text selection', () => {
  const obj = (id: string, x: number, y: number, w: number, h: number, path?: number[]): PdfTextObject => ({
    id,
    pageIndex: 0,
    objectIndex: 0,
    objectPath: path,
    text: id,
    bounds: { x, y, width: w, height: h },
    pdfBounds: { left: x, bottom: 0, right: x + w, top: h },
    fontSize: 12,
    fontName: 'Helvetica',
    color: '#000000',
    colorRgba: null,
    matrix: null,
    isEditable: true,
  });

  it('tolerance is a constant finger size on screen at every zoom', () => {
    expect(pdfTapToleranceDocPoints(0.55, 1)).toBeCloseTo(PDF_TAP_TOLERANCE_PT / 0.55, 9);
    expect(pdfTapToleranceDocPoints(0.55, 4)).toBeCloseTo(PDF_TAP_TOLERANCE_PT / 2.2, 9);
    expect(pdfTapToleranceDocPoints(0, 0)).toBe(PDF_TAP_TOLERANCE_PT);
  });

  it('a tap ON a line selects it even if a smaller neighbour is within the padding (was: smallest wins)', () => {
    const line = obj('long line of body text', 50, 100, 400, 14);
    const footnote = obj('¹', 455, 96, 6, 8); // tiny superscript right after the line
    expect(hitTestTextObjects([line, footnote], { x: 440, y: 107 }, 20)?.id).toBe('long line of body text');
  });

  it('a tap between two lines selects the nearer one, not the smaller one', () => {
    const upper = obj('Heading', 50, 100, 300, 20);
    const lower = obj('Sub', 50, 140, 40, 12);
    expect(hitTestTextObjects([upper, lower], { x: 200, y: 126 }, 20)?.id).toBe('Heading'); // 6 vs 14 away
    expect(hitTestTextObjects([upper, lower], { x: 60, y: 135 }, 20)?.id).toBe('Sub'); // 15 vs 5 away
  });

  it('near-ties favour the text on the tapped line', () => {
    const left = obj('Name:', 50, 100, 60, 14);
    const below = obj('Address', 114, 117, 80, 14);
    // 4.2 pt right of "Name:" (on its line) and 3 pt above "Address": not a near-tie -> nearer wins
    expect(hitTestTextObjects([left, below], { x: 114.2, y: 114 }, 20)?.id).toBe('Address');
    // 4.2 pt vs 4 pt (within 0.5 pt) -> the text on the tapped line wins the near-tie
    const below2 = obj('Address', 114, 118, 80, 14);
    expect(hitTestTextObjects([left, below2], { x: 114.2, y: 114 }, 20)?.id).toBe('Name:');
  });

  it('does not select unrelated text beyond the finger tolerance', () => {
    expect(hitTestTextObjects([obj('far', 400, 400, 50, 12)], { x: 100, y: 100 }, pdfTapToleranceDocPoints(0.55, 1))).toBeNull();
  });

  it('keeps nested Form XObject specificity for overlapping boxes', () => {
    const top = obj('top', 50, 50, 100, 20, [1]);
    const nested = obj('nested', 50, 50, 100, 20, [2, 0, 3]);
    expect(hitTestTextObjects([top, nested], { x: 60, y: 60 }, 20)?.id).toBe('nested');
  });

  it('works on rotated pages (display-space bounds)', () => {
    const m = rotationDisplayMatrix(90, { left: 0, bottom: 0, width: 612, height: 792 });
    const a = { ...obj('A', 0, 0, 0, 0), bounds: userBoundsToDisplayRect(m, { left: 72, bottom: 700, right: 272, top: 724 }) };
    const b = { ...obj('B', 0, 0, 0, 0), bounds: userBoundsToDisplayRect(m, { left: 72, bottom: 600, right: 272, top: 624 }) };
    const nearA = userToDisplayPoint(m, 172, 730); // 6 pt off A in user space
    expect(hitTestTextObjects([a, b], nearA, 20)?.id).toBe('A');
  });
});
