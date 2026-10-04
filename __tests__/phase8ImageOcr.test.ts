import { NativeModules, Platform } from 'react-native';
import {
  OnDeviceOcrEngine,
  normalizeBoundingBox,
  normalizeVisionBoundingBox,
  normalizeToOcrDocument,
  normalizeRawNativeOcrResult,
  validateOcrBounds,
  ocrResultToTextRegions,
  OcrCache,
  hitTestOcrElement,
  hitTestOcrLine,
  hitTestOcrBlock,
  hitTestOcrHierarchy,
  createOcrSelectionState,
} from '../src/features/ocr';
import {
  OcrDocument,
  RawNativeOcrResult,
} from '../src/features/ocr/types';
import {
  OcrFailedError,
  OcrImageReadError,
  OcrUnavailableError,
} from '../src/errors';
import { DocumentPoint, DocumentRect, ViewportOrigin, ViewportTransform } from '../src/types/geometry';
import { screenToDocument } from '../src/features/image/imageViewportMath';
import { ImageDocumentSession } from '../src/features/image/imageDocumentSession';

describe('Phase 8: Image On-Device OCR, Text Detection & Selection', () => {
  const sampleDimensions = { width: 1080, height: 1920 };

  const sampleRawNativeResult: RawNativeOcrResult = {
    fullText: 'Hello World\nInvoice #12345',
    imageWidth: 1080,
    imageHeight: 1920,
    blocks: [
      {
        text: 'Hello World',
        boundingBox: { x: 100, y: 200, width: 400, height: 80 },
        lines: [
          {
            text: 'Hello World',
            confidence: 0.98,
            boundingBox: { x: 100, y: 200, width: 400, height: 80 },
            words: [
              {
                text: 'Hello',
                confidence: 0.99,
                boundingBox: { x: 100, y: 200, width: 180, height: 80 },
              },
              {
                text: 'World',
                confidence: 0.97,
                boundingBox: { x: 300, y: 200, width: 200, height: 80 },
              },
            ],
          },
        ],
      },
      {
        text: 'Invoice #12345',
        boundingBox: { x: 100, y: 400, width: 500, height: 60 },
        lines: [
          {
            text: 'Invoice #12345',
            confidence: 0.95,
            boundingBox: { x: 100, y: 400, width: 500, height: 60 },
            words: [
              {
                text: 'Invoice',
                confidence: 0.96,
                boundingBox: { x: 100, y: 400, width: 220, height: 60 },
              },
              {
                text: '#12345',
                confidence: 0.94,
                boundingBox: { x: 340, y: 400, width: 260, height: 60 },
              },
            ],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // 1. OCR Engine Architecture & Contract
  // ===========================================================================
  describe('1. OCR Engine Architecture & Contract', () => {
    it('calls native module and returns canonical OcrDocument', async () => {
      NativeModules.OcrNativeModule = {
        recognizeText: jest.fn().mockResolvedValue(sampleRawNativeResult),
      };

      const engine = new OnDeviceOcrEngine();
      const ocrDoc = await engine.recognizeOcrDocument('test-doc-1', 'file:///test.png');

      expect(ocrDoc.documentId).toBe('test-doc-1');
      expect(ocrDoc.imageWidth).toBe(1080);
      expect(ocrDoc.imageHeight).toBe(1920);
      expect(ocrDoc.blocks.length).toBe(2);
      expect(ocrDoc.fullText).toBe('Hello World\nInvoice #12345');
    });

    it('rejects empty or whitespace asset URI with OcrImageReadError', async () => {
      const engine = new OnDeviceOcrEngine();
      await expect(engine.recognizeOcrDocument('doc-1', '')).rejects.toThrow(OcrImageReadError);
      await expect(engine.recognizeOcrDocument('doc-1', '   ')).rejects.toThrow(OcrImageReadError);
    });

    it('rejects unlinked native module with OcrUnavailableError', async () => {
      const originalModule = NativeModules.OcrNativeModule;
      delete NativeModules.OcrNativeModule;

      const engine = new OnDeviceOcrEngine();
      await expect(engine.recognizeOcrDocument('doc-1', 'file:///test.jpg')).rejects.toThrow(
        OcrUnavailableError,
      );

      NativeModules.OcrNativeModule = originalModule;
    });

    it('maps native failure to OcrFailedError with informative message', async () => {
      NativeModules.OcrNativeModule = {
        recognizeText: jest.fn().mockRejectedValue(new Error('Out of memory')),
      };

      const engine = new OnDeviceOcrEngine();
      await expect(engine.recognizeOcrDocument('doc-fail', 'file:///corrupt.jpg')).rejects.toThrow(
        OcrFailedError,
      );
    });

    it('backwards-compatible recognizeText returns OcrResult', async () => {
      NativeModules.OcrNativeModule = {
        recognizeText: jest.fn().mockResolvedValue(sampleRawNativeResult),
      };

      const engine = new OnDeviceOcrEngine();
      const result = await engine.recognizeText('file:///test.png');

      expect(result.imageDimensions.width).toBe(1080);
      expect(result.imageDimensions.height).toBe(1920);
      expect(result.blocks.length).toBe(2);
    });

    it('extractTextRegions maps OCR lines to editable TextRegion array', async () => {
      NativeModules.OcrNativeModule = {
        recognizeText: jest.fn().mockResolvedValue(sampleRawNativeResult),
      };

      const engine = new OnDeviceOcrEngine();
      const regions = await engine.extractTextRegions('file:///test.png', 0);

      expect(regions.length).toBe(2);
      expect(regions[0].originalText).toBe('Hello World');
      expect(regions[0].status).toBe('detected');
      expect(regions[1].originalText).toBe('Invoice #12345');
    });
  });

  // ===========================================================================
  // 2. Android ML Kit Coordinate Normalization & Bounds
  // ===========================================================================
  describe('2. Android ML Kit Coordinate Normalization & Bounds', () => {
    it('converts ML Kit bounding boxes into canonical top-left document pixel space', () => {
      const box = { x: 50, y: 150, width: 300, height: 50 };
      const normalized = normalizeBoundingBox(box, sampleDimensions);

      expect(normalized.x).toBe(50);
      expect(normalized.y).toBe(150);
      expect(normalized.width).toBe(300);
      expect(normalized.height).toBe(50);
    });

    it('validates correct bounds satisfying canonical constraints', () => {
      const validBox: DocumentRect = { x: 100, y: 200, width: 400, height: 80 };
      expect(validateOcrBounds(validBox, sampleDimensions)).toBe(true);
    });

    it('clamps out-of-bound ML Kit coordinates to image width and height', () => {
      const box = { x: 1000, y: 1800, width: 200, height: 300 }; // Exceeds 1080x1920
      const clamped = normalizeBoundingBox(box, sampleDimensions);

      expect(clamped.x).toBe(1000);
      expect(clamped.y).toBe(1800);
      expect(clamped.width).toBe(80); // Clamped to 1080 - 1000
      expect(clamped.height).toBe(120); // Clamped to 1920 - 1800
      expect(validateOcrBounds(clamped, sampleDimensions)).toBe(true);
    });

    it('clamps negative coordinates gracefully to zero', () => {
      const box = { x: -30, y: -20, width: 200, height: 100 };
      const clamped = normalizeBoundingBox(box, sampleDimensions);

      expect(clamped.x).toBe(0);
      expect(clamped.y).toBe(0);
    });

    it('handles partially malformed/missing bounds by defaulting safely', () => {
      const empty = normalizeBoundingBox(undefined, sampleDimensions);
      expect(empty.x).toBe(0);
      expect(empty.y).toBe(0);
      expect(empty.width).toBe(0);
      expect(empty.height).toBe(0);

      const nanBox = normalizeBoundingBox({ x: NaN, y: 10, width: 50, height: 50 }, sampleDimensions);
      expect(nanBox.width).toBe(0);
    });

    it('handles full-width text spanning across image edge', () => {
      const box = { x: 0, y: 500, width: 1080, height: 100 };
      const normalized = normalizeBoundingBox(box, sampleDimensions);

      expect(normalized.x).toBe(0);
      expect(normalized.width).toBe(1080);
      expect(validateOcrBounds(normalized, sampleDimensions)).toBe(true);
    });

    it('validates very small text safely', () => {
      const smallBox: DocumentRect = { x: 10, y: 10, width: 5, height: 5 };
      expect(validateOcrBounds(smallBox, sampleDimensions)).toBe(true);
    });
  });

  // ===========================================================================
  // 3. iOS Vision Coordinate Normalization & Inversion
  // ===========================================================================
  describe('3. iOS Vision Coordinate Normalization & Inversion', () => {
    it('converts Vision bottom-left normalized [0,1] coordinates to top-left pixel space', () => {
      // Vision: x=0.1, y=0.5, w=0.4, h=0.1
      // Document 1000x2000
      // Pixel X = 0.1 * 1000 = 100
      // Pixel Y = (1.0 - 0.5 - 0.1) * 2000 = 0.4 * 2000 = 800
      // Pixel W = 0.4 * 1000 = 400
      // Pixel H = 0.1 * 2000 = 200
      const dims = { width: 1000, height: 2000 };
      const visionBox = { x: 0.1, y: 0.5, width: 0.4, height: 0.1 };

      const docBox = normalizeVisionBoundingBox(visionBox, dims);
      expect(docBox.x).toBe(100);
      expect(docBox.y).toBe(800);
      expect(docBox.width).toBe(400);
      expect(docBox.height).toBe(200);
    });

    it('correctly handles observation near top-left of image', () => {
      // Top-left in visual space means Vision Y is near 1.0
      // x=0.05, y=0.9, w=0.5, h=0.08
      // Document Y = (1.0 - 0.9 - 0.08) * 1000 = 0.02 * 1000 = 20
      const dims = { width: 1000, height: 1000 };
      const visionBox = { x: 0.05, y: 0.9, width: 0.5, height: 0.08 };

      const docBox = normalizeVisionBoundingBox(visionBox, dims);
      expect(docBox.y).toBe(20);
      expect(docBox.x).toBe(50);
      expect(docBox.height).toBe(80);
    });

    it('correctly handles observation near bottom-left of image', () => {
      // Bottom-left in visual space means Vision Y is near 0.0
      // x=0.05, y=0.02, w=0.5, h=0.08
      // Document Y = (1.0 - 0.02 - 0.08) * 1000 = 0.9 * 1000 = 900
      const dims = { width: 1000, height: 1000 };
      const visionBox = { x: 0.05, y: 0.02, width: 0.5, height: 0.08 };

      const docBox = normalizeVisionBoundingBox(visionBox, dims);
      expect(docBox.y).toBe(900);
    });

    it('multiplies normalized width and height by image dimensions', () => {
      const dims = { width: 1200, height: 1600 };
      const visionBox = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };

      const docBox = normalizeVisionBoundingBox(visionBox, dims);
      expect(docBox.width).toBe(600); // 0.5 * 1200
      expect(docBox.height).toBe(400); // 0.25 * 1600
    });

    it('clamps normalized coordinates exceeding [0, 1] range', () => {
      const dims = { width: 1000, height: 1000 };
      const visionBox = { x: 0.8, y: 0.1, width: 0.5, height: 0.2 }; // x + width = 1.3

      const docBox = normalizeVisionBoundingBox(visionBox, dims);
      expect(docBox.x).toBe(800);
      expect(docBox.width).toBe(200); // Clamped to 1000 - 800
      expect(validateOcrBounds(docBox, dims)).toBe(true);
    });

    it('handles null or undefined Vision box safely', () => {
      const docBox = normalizeVisionBoundingBox(undefined as any, sampleDimensions);
      expect(docBox.width).toBe(0);
      expect(docBox.height).toBe(0);
    });
  });

  // ===========================================================================
  // 4. Canonical OCR Domain Model & Deterministic Identity
  // ===========================================================================
  describe('4. Canonical OCR Domain Model & Deterministic Identity', () => {
    let ocrDoc: OcrDocument;

    beforeEach(() => {
      ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'receipt-99');
    });

    it('scopes block IDs deterministically', () => {
      expect(ocrDoc.blocks[0].id).toBe('ocr-receipt-99-b0');
      expect(ocrDoc.blocks[1].id).toBe('ocr-receipt-99-b1');
    });

    it('scopes line IDs deterministically with block parent ID', () => {
      expect(ocrDoc.blocks[0].lines[0].id).toBe('ocr-receipt-99-b0-l0');
      expect(ocrDoc.blocks[0].lines[0].blockId).toBe('ocr-receipt-99-b0');
    });

    it('scopes element IDs deterministically with line parent ID and index', () => {
      const line = ocrDoc.blocks[0].lines[0];
      expect(line.elements[0].id).toBe('ocr-receipt-99-b0-l0-e0');
      expect(line.elements[0].text).toBe('Hello');
      expect(line.elements[0].index).toBe(0);

      expect(line.elements[1].id).toBe('ocr-receipt-99-b0-l0-e1');
      expect(line.elements[1].text).toBe('World');
      expect(line.elements[1].index).toBe(1);
    });

    it('produces identical deterministic IDs for identical input across repeated calls', () => {
      const ocrDoc2 = normalizeToOcrDocument(sampleRawNativeResult, 'receipt-99');
      expect(ocrDoc.blocks[0].id).toBe(ocrDoc2.blocks[0].id);
      expect(ocrDoc.blocks[0].lines[0].elements[0].id).toBe(
        ocrDoc2.blocks[0].lines[0].elements[0].id,
      );
    });

    it('preserves confidence scores at line and element levels', () => {
      const line = ocrDoc.blocks[0].lines[0];
      expect(line.confidence).toBe(0.98);
      expect(line.elements[0].confidence).toBe(0.99);
      expect(line.elements[1].confidence).toBe(0.97);
    });

    it('populates both elements and words for backward compatibility', () => {
      const line = ocrDoc.blocks[0].lines[0];
      expect(line.elements).toBeDefined();
      expect(line.words).toBeDefined();
      expect(line.words.length).toBe(line.elements.length);
    });
  });

  // ===========================================================================
  // 5. Deterministic OCR Hit-Testing & Selection
  // ===========================================================================
  describe('5. Deterministic OCR Hit-Testing & Selection', () => {
    let ocrDoc: OcrDocument;

    beforeEach(() => {
      ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'test-doc');
    });

    it('exact hit: tap inside word element returns that element', () => {
      // 'Hello' is at x: 100, y: 200, width: 180, height: 80
      const tapPoint: DocumentPoint = { x: 150, y: 240 };
      const element = hitTestOcrElement(ocrDoc, tapPoint, 0);

      expect(element).not.toBeNull();
      expect(element!.text).toBe('Hello');
      expect(element!.id).toBe('ocr-test-doc-b0-l0-e0');
    });

    it('small text tolerance: tap within 4px padding of text selects the element', () => {
      // 'Hello' is at x: 100..280, y: 200..280. Tap at x: 97, y: 200 (3px left)
      const tapPoint: DocumentPoint = { x: 97, y: 200 };
      const element = hitTestOcrElement(ocrDoc, tapPoint, 6);

      expect(element).not.toBeNull();
      expect(element!.text).toBe('Hello');
    });

    it('closest element preference: chooses element whose center is closest to tap', () => {
      // 'Hello' (center: 190, 240) vs 'World' (center: 400, 240)
      // Tap at x: 285, y: 240 (5px right of Hello, 15px left of World)
      const tapPoint: DocumentPoint = { x: 285, y: 240 };
      const element = hitTestOcrElement(ocrDoc, tapPoint, 20);

      expect(element).not.toBeNull();
      expect(element!.text).toBe('Hello');
    });

    it('overlapping boxes: chooses smallest / most specific element', () => {
      // In hierarchy, element is smaller than line and block
      const tapPoint: DocumentPoint = { x: 350, y: 240 }; // Inside 'World'
      const element = hitTestOcrElement(ocrDoc, tapPoint);

      expect(element).not.toBeNull();
      expect(element!.text).toBe('World');
      expect(element!.bounds.width).toBeLessThan(400); // Element width 200 < line width 400
    });

    it('tap outside all elements returns null', () => {
      const tapPoint: DocumentPoint = { x: 900, y: 900 };
      const element = hitTestOcrElement(ocrDoc, tapPoint, 4);

      expect(element).toBeNull();
    });

    it('constructs canonical OcrSelectionState with full metadata', () => {
      const tapPoint: DocumentPoint = { x: 150, y: 240 };
      const element = hitTestOcrElement(ocrDoc, tapPoint)!;
      const selection = createOcrSelectionState(ocrDoc, element);

      expect(selection.documentId).toBe('test-doc');
      expect(selection.elementId).toBe('ocr-test-doc-b0-l0-e0');
      expect(selection.text).toBe('Hello');
      expect(selection.blockId).toBe('ocr-test-doc-b0');
      expect(selection.lineId).toBe('ocr-test-doc-b0-l0');
      expect(selection.confidence).toBe(0.99);
    });

    it('hitTestOcrLine resolves parent line of tapped point', () => {
      const tapPoint: DocumentPoint = { x: 350, y: 420 };
      const line = hitTestOcrLine(ocrDoc, tapPoint);

      expect(line).not.toBeNull();
      expect(line!.text).toBe('Invoice #12345');
    });

    it('hitTestOcrHierarchy resolves complete block, line, and element hierarchy', () => {
      const tapPoint: DocumentPoint = { x: 150, y: 240 };
      const hit = hitTestOcrHierarchy(ocrDoc, tapPoint);

      expect(hit).not.toBeNull();
      expect(hit!.block.id).toBe('ocr-test-doc-b0');
      expect(hit!.line.id).toBe('ocr-test-doc-b0-l0');
      expect(hit!.element.id).toBe('ocr-test-doc-b0-l0-e0');
    });
  });

  // ===========================================================================
  // 6. Viewport Independence, Zoom & Pan Invariance
  // ===========================================================================
  describe('6. Viewport Independence, Zoom & Pan Invariance', () => {
    let ocrDoc: OcrDocument;
    const origin: ViewportOrigin = { x: 0, y: 0 };

    beforeEach(() => {
      ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'zoom-test');
    });

    it('hit-testing succeeds at 0.5x zoom', () => {
      const transform: ViewportTransform = { scale: 0.5, translateX: 50, translateY: 50 };
      // Document pt (150, 240) in 'Hello' -> Screen = (150*0.5 + 50 = 125, 240*0.5 + 50 = 170)
      const screenPt = { x: 125, y: 170 };
      const docPt = screenToDocument(screenPt, origin, transform);

      const hit = hitTestOcrElement(ocrDoc, docPt);
      expect(hit).not.toBeNull();
      expect(hit!.text).toBe('Hello');
    });

    it('hit-testing succeeds at 1.0x zoom', () => {
      const transform: ViewportTransform = { scale: 1.0, translateX: 0, translateY: 0 };
      const screenPt = { x: 150, y: 240 };
      const docPt = screenToDocument(screenPt, origin, transform);

      const hit = hitTestOcrElement(ocrDoc, docPt);
      expect(hit).not.toBeNull();
      expect(hit!.text).toBe('Hello');
    });

    it('hit-testing succeeds at 2.0x zoom', () => {
      const transform: ViewportTransform = { scale: 2.0, translateX: 100, translateY: 100 };
      // Document pt (150, 240) -> Screen = (150*2 + 100 = 400, 240*2 + 100 = 580)
      const screenPt = { x: 400, y: 580 };
      const docPt = screenToDocument(screenPt, origin, transform);

      const hit = hitTestOcrElement(ocrDoc, docPt);
      expect(hit).not.toBeNull();
      expect(hit!.text).toBe('Hello');
    });

    it('hit-testing succeeds at 4.0x zoom', () => {
      const transform: ViewportTransform = { scale: 4.0, translateX: -200, translateY: -400 };
      // Document pt (150, 240) -> Screen = (150*4 - 200 = 400, 240*4 - 400 = 560)
      const screenPt = { x: 400, y: 560 };
      const docPt = screenToDocument(screenPt, origin, transform);

      const hit = hitTestOcrElement(ocrDoc, docPt);
      expect(hit).not.toBeNull();
      expect(hit!.text).toBe('Hello');
    });

    it('screen to document tap mapping aligns under arbitrary pan offsets', () => {
      const transform: ViewportTransform = { scale: 1.5, translateX: 375, translateY: -125 };
      // Document pt (350, 240) in 'World' -> Screen = (350*1.5 + 375 = 900, 240*1.5 - 125 = 235)
      const screenPt = { x: 900, y: 235 };
      const docPt = screenToDocument(screenPt, origin, transform);

      const hit = hitTestOcrElement(ocrDoc, docPt);
      expect(hit).not.toBeNull();
      expect(hit!.text).toBe('World');
    });

    it('OCR element bounds remain fixed in document coordinates across viewport changes', () => {
      const element = ocrDoc.blocks[0].lines[0].elements[0];
      const initialBounds = { ...element.bounds };

      // Simulate viewport zoom/pan in session
      const session = new ImageDocumentSession({
        documentId: 'zoom-test',
        sourceUri: 'file:///test.png',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
      });

      session.updateViewportTransform({ scale: 3.5, translateX: 500, translateY: 500 });
      expect(element.bounds).toEqual(initialBounds);
    });
  });

  // ===========================================================================
  // 7. OCR Caching, Invalidation & Execution Lifecycle
  // ===========================================================================
  describe('7. OCR Caching, Invalidation & Execution Lifecycle', () => {
    it('caches OCR result for same documentId and assetUri', () => {
      const cache = new OcrCache();
      const ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'cached-doc');

      cache.set('cached-doc', 'file:///img.png', ocrDoc);
      expect(cache.has('cached-doc', 'file:///img.png')).toBe(true);

      const retrieved = cache.get('cached-doc', 'file:///img.png');
      expect(retrieved).toBe(ocrDoc);
    });

    it('cache hit avoids duplicate native module processing', async () => {
      const cache = new OcrCache();
      const ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'cache-test');
      cache.set('cache-test', 'file:///img.png', ocrDoc);

      const mockNativeFn = jest.fn();
      NativeModules.OcrNativeModule = { recognizeText: mockNativeFn };

      // Engine with cache
      const cached = cache.get('cache-test', 'file:///img.png');
      expect(cached).toBeDefined();
      expect(mockNativeFn).not.toHaveBeenCalled();
    });

    it('invalidation by documentId removes cached entries for that document only', () => {
      const cache = new OcrCache();
      const doc1 = normalizeToOcrDocument(sampleRawNativeResult, 'doc-1');
      const doc2 = normalizeToOcrDocument(sampleRawNativeResult, 'doc-2');

      cache.set('doc-1', 'file:///img1.png', doc1);
      cache.set('doc-2', 'file:///img2.png', doc2);
      expect(cache.size()).toBe(2);

      cache.invalidate('doc-1');
      expect(cache.has('doc-1', 'file:///img1.png')).toBe(false);
      expect(cache.has('doc-2', 'file:///img2.png')).toBe(true);
      expect(cache.size()).toBe(1);
    });

    it('clearing cache empties all entries', () => {
      const cache = new OcrCache();
      cache.set('doc-1', 'file:///img.png', normalizeToOcrDocument(sampleRawNativeResult, 'doc-1'));
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('viewport changes do NOT invalidate OCR cache', () => {
      const cache = new OcrCache();
      const ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'vp-test');
      cache.set('vp-test', 'file:///img.png', ocrDoc);

      const session = new ImageDocumentSession({
        documentId: 'vp-test',
        sourceUri: 'file:///img.png',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
      });

      // Viewport change
      session.updateViewportTransform({ scale: 2.0, translateX: 50, translateY: 50 });

      // Cache remains valid
      expect(cache.has('vp-test', 'file:///img.png')).toBe(true);
    });

    it('stale document protection: results from previous document do not leak', () => {
      const cache = new OcrCache();
      const docA = normalizeToOcrDocument(sampleRawNativeResult, 'doc-A');
      cache.set('doc-A', 'file:///imgA.png', docA);

      // Querying doc-B with same or different URI returns undefined
      expect(cache.get('doc-B', 'file:///imgA.png')).toBeUndefined();
    });
  });

  // ===========================================================================
  // 8. Source Immutability & Dirty State Preservation
  // ===========================================================================
  describe('8. Source Immutability & Dirty State Preservation', () => {
    it('source image file URI remains unchanged after OCR detection', async () => {
      NativeModules.OcrNativeModule = {
        recognizeText: jest.fn().mockResolvedValue(sampleRawNativeResult),
      };

      const sourceUri = 'file:///data/user/0/documents/immutable.jpg';
      const engine = new OnDeviceOcrEngine();
      await engine.recognizeOcrDocument('doc-immut', sourceUri);

      // Source URI is untouched
      expect(sourceUri).toBe('file:///data/user/0/documents/immutable.jpg');
    });

    it('working representation file URI remains unchanged after detection', async () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-work',
        sourceUri: 'file:///original.png',
        workingUri: 'file:///cache/working.png',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
      });

      expect(session.model.workingUri).toBe('file:///cache/working.png');
      // Running OCR does not alter workingUri
      expect(session.model.workingUri).toBe('file:///cache/working.png');
    });

    it('running OCR detection does NOT mark the document dirty', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-clean-ocr',
        sourceUri: 'file:///test.png',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
      });

      expect(session.isDirty()).toBe(false);
      // OCR run is read-only detection; session remains clean
      expect(session.isDirty()).toBe(false);
      expect(session.model.dirtyState).toBe('CLEAN');
    });

    it('empty OCR result (0 text found) is handled gracefully without error', async () => {
      NativeModules.OcrNativeModule = {
        recognizeText: jest.fn().mockResolvedValue({
          fullText: '',
          imageWidth: 800,
          imageHeight: 600,
          blocks: [],
        }),
      };

      const engine = new OnDeviceOcrEngine();
      const doc = await engine.recognizeOcrDocument('empty-doc', 'file:///blank.png');

      expect(doc.blocks.length).toBe(0);
      expect(doc.fullText).toBe('');
      const regions = ocrResultToTextRegions(doc);
      expect(regions.length).toBe(0);
    });

    it('selecting OCR text does NOT mark the document dirty', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-select-clean',
        sourceUri: 'file:///test.png',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
      });

      const ocrDoc = normalizeToOcrDocument(sampleRawNativeResult, 'doc-select-clean');
      const element = hitTestOcrElement(ocrDoc, { x: 150, y: 240 })!;
      const selection = createOcrSelectionState(ocrDoc, element);

      expect(selection).toBeDefined();
      expect(session.isDirty()).toBe(false);
    });
  });
});
