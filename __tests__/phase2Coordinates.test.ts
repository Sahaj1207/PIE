import {
  screenToViewport,
  viewportToScreen,
  viewportToDocument,
  documentToViewport,
  screenToDocument,
  documentToScreen,
  viewportToDocumentRect,
  documentToViewportRect,
  clampScale,
  sanitizeViewportTransform,
  calculateFocalZoom,
  MIN_VIEWPORT_SCALE,
  MAX_VIEWPORT_SCALE,
  rectContainsPoint,
  rectsIntersect,
  clamp,
} from '../src/utils/coordinates';
import {
  DocumentPoint,
  DocumentViewportLayout,
  ScreenPoint,
  ViewportOrigin,
  ViewportPoint,
  ViewportTransform,
} from '../src/types/geometry';

describe('Phase 2 — Shared Interaction & Coordinate Foundation Suite', () => {
  const viewportOrigin: ViewportOrigin = { x: 0, y: 100 }; // e.g. 100px top header/status bar

  describe('1. Authoritative Coordinate Transformations', () => {
    // A. scale = 1.0, no translation, identity layout
    it('transforms accurately when scale = 1.0 (identity)', () => {
      const transform: ViewportTransform = { scale: 1.0, translateX: 0, translateY: 0 };
      const docPoint: DocumentPoint = { x: 250, y: 350 };

      const vpPoint = documentToViewport(docPoint, transform);
      expect(vpPoint.x).toBeCloseTo(250, 4);
      expect(vpPoint.y).toBeCloseTo(350, 4);

      const roundTrip = viewportToDocument(vpPoint, transform);
      expect(roundTrip.x).toBeCloseTo(250, 4);
      expect(roundTrip.y).toBeCloseTo(350, 4);
    });

    // B. scale > 1.0 (Zoomed in, e.g. 2.5x)
    it('transforms accurately when scale > 1.0 (zoomed in)', () => {
      const transform: ViewportTransform = { scale: 2.5, translateX: 40, translateY: -60 };
      const docPoint: DocumentPoint = { x: 120, y: 180 };

      // vpX = 0 + 40 + 120 * 1.0 * 2.5 = 40 + 300 = 340
      // vpY = 0 - 60 + 180 * 1.0 * 2.5 = -60 + 450 = 390
      const vpPoint = documentToViewport(docPoint, transform);
      expect(vpPoint.x).toBeCloseTo(340, 4);
      expect(vpPoint.y).toBeCloseTo(390, 4);

      const roundTrip = viewportToDocument(vpPoint, transform);
      expect(roundTrip.x).toBeCloseTo(120, 4);
      expect(roundTrip.y).toBeCloseTo(180, 4);
    });

    // C. scale < 1.0 (Zoomed out, e.g. 0.6x)
    it('transforms accurately when scale < 1.0 (zoomed out)', () => {
      const transform: ViewportTransform = { scale: 0.6, translateX: 20, translateY: 30 };
      const docPoint: DocumentPoint = { x: 500, y: 600 };

      // vpX = 20 + 500 * 0.6 = 320
      // vpY = 30 + 600 * 0.6 = 390
      const vpPoint = documentToViewport(docPoint, transform);
      expect(vpPoint.x).toBeCloseTo(320, 4);
      expect(vpPoint.y).toBeCloseTo(390, 4);

      const roundTrip = viewportToDocument(vpPoint, transform);
      expect(roundTrip.x).toBeCloseTo(500, 4);
      expect(roundTrip.y).toBeCloseTo(600, 4);
    });

    // D. Translated Viewport with Centered Document (PDF layout)
    it('transforms correctly for centered document in translated viewport', () => {
      const layout: DocumentViewportLayout = {
        baseScale: 0.75, // PDF fit scale
        originX: 45, // page centered horizontally
        originY: 20, // page centered vertically
      };
      const transform: ViewportTransform = {
        scale: 1.5,
        translateX: 120,
        translateY: -80,
      };

      const docPoint: DocumentPoint = { x: 300, y: 400 };

      // Multiplier = 1.5 * 0.75 = 1.125
      // vpX = 45 + 120 + 300 * 1.125 = 165 + 337.5 = 502.5
      // vpY = 20 - 80 + 400 * 1.125 = -60 + 450 = 390
      const vpPoint = documentToViewport(docPoint, transform, layout);
      expect(vpPoint.x).toBeCloseTo(502.5, 4);
      expect(vpPoint.y).toBeCloseTo(390.0, 4);

      // Invert back to document
      const roundTrip = viewportToDocument(vpPoint, transform, layout);
      expect(roundTrip.x).toBeCloseTo(300, 4);
      expect(roundTrip.y).toBeCloseTo(400, 4);
    });
  });

  describe('2. Device Space Pipeline: Screen -> Viewport -> Document', () => {
    it('performs complete round-trip conversion from physical touch screen to document and back', () => {
      const layout: DocumentViewportLayout = {
        baseScale: 1.2,
        originX: 30,
        originY: 50,
      };
      const transform: ViewportTransform = {
        scale: 1.8,
        translateX: 60,
        translateY: 40,
      };

      // Physical device touch at (400, 600)
      const touchScreenPoint: ScreenPoint = { x: 400, y: 600 };

      // Screen -> Document
      const docPoint = screenToDocument(touchScreenPoint, viewportOrigin, transform, layout);

      // Document -> Screen
      const backToScreen = documentToScreen(docPoint, viewportOrigin, transform, layout);
      expect(backToScreen.x).toBeCloseTo(touchScreenPoint.x, 3);
      expect(backToScreen.y).toBeCloseTo(touchScreenPoint.y, 3);
    });

    it('transforms rectangles round-trip between document and viewport space', () => {
      const layout: DocumentViewportLayout = {
        baseScale: 0.8,
        originX: 25,
        originY: 35,
      };
      const transform: ViewportTransform = {
        scale: 2.0,
        translateX: 50,
        translateY: 70,
      };

      const docRect = { x: 50, y: 80, width: 200, height: 100 };
      const vpRect = documentToViewportRect(docRect, transform, layout);

      expect(vpRect.width).toBeCloseTo(200 * (0.8 * 2.0), 4);
      expect(vpRect.height).toBeCloseTo(100 * (0.8 * 2.0), 4);

      const roundTrip = viewportToDocumentRect(vpRect, transform, layout);
      expect(roundTrip.x).toBeCloseTo(docRect.x, 4);
      expect(roundTrip.y).toBeCloseTo(docRect.y, 4);
      expect(roundTrip.width).toBeCloseTo(docRect.width, 4);
      expect(roundTrip.height).toBeCloseTo(docRect.height, 4);
    });
  });

  describe('3. Specific Document Types & Aspect Ratios', () => {
    // Portrait Image (1080 x 1920)
    it('handles high-res portrait image document coordinate space', () => {
      const transform: ViewportTransform = { scale: 0.85, translateX: 15, translateY: 25 };
      const portraitPoint: DocumentPoint = { x: 1080, y: 1920 }; // bottom-right corner

      const vp = documentToViewport(portraitPoint, transform);
      const back = viewportToDocument(vp, transform);
      expect(back.x).toBeCloseTo(1080, 4);
      expect(back.y).toBeCloseTo(1920, 4);
    });

    // Landscape Image (2560 x 1440)
    it('handles high-res landscape image document coordinate space', () => {
      const transform: ViewportTransform = { scale: 0.6, translateX: -50, translateY: 10 };
      const landscapePoint: DocumentPoint = { x: 2560, y: 1440 };

      const vp = documentToViewport(landscapePoint, transform);
      const back = viewportToDocument(vp, transform);
      expect(back.x).toBeCloseTo(2560, 4);
      expect(back.y).toBeCloseTo(1440, 4);
    });

    // Standard PDF Page (A4: 595.28 x 841.89 pt)
    it('handles standard A4 PDF page aspect ratio and dimensions', () => {
      const a4Width = 595.28;
      const a4Height = 841.89;
      const layout: DocumentViewportLayout = {
        baseScale: 380 / a4Width, // fit width to 380 viewport width
        originX: 10,
        originY: 20,
      };
      const transform: ViewportTransform = { scale: 1.0, translateX: 0, translateY: 0 };
      const pdfCenter: DocumentPoint = { x: a4Width / 2, y: a4Height / 2 };

      const vp = documentToViewport(pdfCenter, transform, layout);
      const back = viewportToDocument(vp, transform, layout);
      expect(back.x).toBeCloseTo(pdfCenter.x, 3);
      expect(back.y).toBeCloseTo(pdfCenter.y, 3);
    });

    // US Letter PDF Page (612 x 792 pt)
    it('handles US Letter PDF page aspect ratio and dimensions', () => {
      const letterWidth = 612;
      const letterHeight = 792;
      const layout: DocumentViewportLayout = {
        baseScale: 380 / letterWidth,
        originX: 15,
        originY: 25,
      };
      const transform: ViewportTransform = { scale: 1.4, translateX: 30, translateY: -20 };
      const pdfPoint: DocumentPoint = { x: 100, y: 200 };

      const vp = documentToViewport(pdfPoint, transform, layout);
      const back = viewportToDocument(vp, transform, layout);
      expect(back.x).toBeCloseTo(pdfPoint.x, 3);
      expect(back.y).toBeCloseTo(pdfPoint.y, 3);
    });
  });

  describe('4. Viewport State Bounds & Sanitization', () => {
    it('strictly clamps scale to [0.5, 4.0]', () => {
      expect(clampScale(0.1)).toBe(MIN_VIEWPORT_SCALE); // 0.5
      expect(clampScale(0.5)).toBe(0.5);
      expect(clampScale(2.5)).toBe(2.5);
      expect(clampScale(4.0)).toBe(4.0);
      expect(clampScale(8.0)).toBe(MAX_VIEWPORT_SCALE); // 4.0
    });

    it('recovers gracefully from NaN, Infinity, and zero/negative scales', () => {
      expect(clampScale(NaN)).toBe(1.0);
      expect(clampScale(Infinity)).toBe(1.0);
      expect(clampScale(-Infinity)).toBe(1.0);
      expect(clampScale(0)).toBe(1.0);
      expect(clampScale(-2.5)).toBe(1.0);
    });

    it('sanitizes corrupt or malformed viewport transform objects', () => {
      const corrupted = {
        scale: NaN,
        translateX: NaN,
        translateY: Infinity,
      };
      const clean = sanitizeViewportTransform(corrupted);
      expect(clean.scale).toBe(1.0);
      expect(clean.translateX).toBe(0);
      expect(clean.translateY).toBe(0);
    });
  });

  describe('5. Focal Point Zoom Math', () => {
    it('preserves the document point under the pinch focal point', () => {
      const currentScale = 1.0;
      const targetScale = 2.0;
      const focalX = 200; // user pinched at (200, 300)
      const focalY = 300;
      const currentTx = 50;
      const currentTy = 80;

      const result = calculateFocalZoom({
        currentScale,
        targetScale,
        focalX,
        focalY,
        currentTx,
        currentTy,
      });

      expect(result.scale).toBe(2.0);
      // New Tx = focalX - (focalX - currentTx) * (2.0 / 1.0) = 200 - (150 * 2) = -100
      expect(result.translateX).toBe(-100);
      // New Ty = focalY - (focalY - currentTy) * (2.0 / 1.0) = 300 - (220 * 2) = -140
      expect(result.translateY).toBe(-140);

      // Verify invariant: document point under focal point before == document point under focal point after
      const docBefore = viewportToDocument({ x: focalX, y: focalY }, { scale: currentScale, translateX: currentTx, translateY: currentTy });
      const docAfter = viewportToDocument({ x: focalX, y: focalY }, { scale: result.scale, translateX: result.translateX, translateY: result.translateY });

      expect(docAfter.x).toBeCloseTo(docBefore.x, 4);
      expect(docAfter.y).toBeCloseTo(docBefore.y, 4);
    });
  });
});
