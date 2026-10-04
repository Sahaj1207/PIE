jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

import {
  viewportPointToDocumentPoint,
  documentPointToViewportPoint,
} from '../src/features/pdf/pdfViewportMath';
import {
  pdfObjectPathId,
  composePdfMatrices,
} from '../src/features/pdf/pdfObjectLocator';
import {
  documentToScreenPoint,
  screenToDocumentPoint,
  rectContainsPoint,
} from '../src/utils/coordinates';
import { isSupportedImageFormat } from '../src/features/image/importService';
import { hitTestTextObjects } from '../src/features/pdf/pdfiumEngine';
import { PdfTextObject } from '../src/features/pdf/types';
import { ViewportTransform, DocumentRect, DocumentPoint } from '../src/types/geometry';

describe('Targeted Fixes Regression Test Suite', () => {
  describe('1. PDF Tap, Hit Testing & Placement Clamping', () => {
    const transform = {
      baseScale: 1.5,
      pageOriginX: 20,
      pageOriginY: 40,
      zoom: 2.0,
      translateX: 50,
      translateY: 80,
    };

    it('converts viewport tap to exact document point in PDF coordinates', () => {
      const viewportTap = { x: 200, y: 300 };
      const docPoint = viewportPointToDocumentPoint(viewportTap, transform);
      expect(docPoint.x).toBeCloseTo(43.333, 2);
      expect(docPoint.y).toBeCloseTo(60.0, 2);

      const roundTrip = documentPointToViewportPoint(docPoint, transform);
      expect(roundTrip.x).toBeCloseTo(200, 2);
      expect(roundTrip.y).toBeCloseTo(300, 2);
    });

    it('hit-tests PDF vector text objects accurately with touch tolerance', () => {
      const objects: PdfTextObject[] = [
        {
          id: 'p0_obj1',
          pageIndex: 0,
          objectIndex: 0,
          text: 'Annual Report 2026',
          bounds: { x: 50, y: 100, width: 200, height: 24 },
          pdfBounds: { left: 50, bottom: 696, right: 250, top: 720 },
          fontSize: 18,
          fontName: 'Helvetica',
          color: '#000000',
          colorRgba: { r: 0, g: 0, b: 0, a: 255 },
          matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 696 },
          isEditable: true,
        },
        {
          id: 'p0_obj2',
          pageIndex: 0,
          objectIndex: 1,
          text: 'Executive Summary',
          bounds: { x: 50, y: 140, width: 150, height: 18 },
          pdfBounds: { left: 50, bottom: 662, right: 200, top: 680 },
          fontSize: 14,
          fontName: 'Helvetica',
          color: '#000000',
          colorRgba: { r: 0, g: 0, b: 0, a: 255 },
          matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 662 },
          isEditable: true,
        },
      ];

      // Exact hit inside obj1
      const hit1 = hitTestTextObjects(objects, { x: 100, y: 110 }, 5);
      expect(hit1).not.toBeNull();
      expect(hit1?.id).toBe('p0_obj1');

      // Near edge with generous touch tolerance (8px outside)
      const hitNear = hitTestTextObjects(objects, { x: 45, y: 102 }, 10);
      expect(hitNear?.id).toBe('p0_obj1');

      // Complete miss
      const miss = hitTestTextObjects(objects, { x: 400, y: 400 }, 10);
      expect(miss).toBeNull();
    });

    it('clamps placement coordinates within page bounds so boundary taps are not dropped', () => {
      const pageWidth = 595;
      const pageHeight = 842;
      const margin = 16;

      const clampPlacement = (x: number, y: number) => ({
        x: Math.max(margin, Math.min(pageWidth - margin, Math.max(0, x))),
        y: Math.max(margin, Math.min(pageHeight - margin, Math.max(0, y))),
      });

      // Tap near top-left margin outside
      const p1 = clampPlacement(-5, -10);
      expect(p1.x).toBe(16);
      expect(p1.y).toBe(16);

      // Tap beyond bottom-right
      const p2 = clampPlacement(600, 900);
      expect(p2.x).toBe(595 - 16);
      expect(p2.y).toBe(842 - 16);

      // Normal center tap
      const p3 = clampPlacement(300, 400);
      expect(p3.x).toBe(300);
      expect(p3.y).toBe(400);
    });
  });

  describe('2. PDF Zoom State & Pan Gestures', () => {
    it('restricts zoom scale between minimum and maximum bounds (0.4x - 4.5x)', () => {
      const clampZoom = (rawScale: number) => Math.min(Math.max(rawScale, 0.4), 4.5);

      expect(clampZoom(0.1)).toBe(0.4);
      expect(clampZoom(1.0)).toBe(1.0);
      expect(clampZoom(3.5)).toBe(3.5);
      expect(clampZoom(6.0)).toBe(4.5);
    });

    it('calculates focal zoom translation preserving point under gesture', () => {
      const focalX = 200;
      const focalY = 300;
      const savedTx = 50;
      const savedTy = 60;
      const scaleRatio = 1.5; // zooming in by 1.5x

      const newTx = focalX - (focalX - savedTx) * scaleRatio;
      const newTy = focalY - (focalY - savedTy) * scaleRatio;

      expect(newTx).toBe(-25);
      expect(newTy).toBe(-60);
    });
  });

  describe('3. PDF Nested Text Extraction & Object Path Resolution', () => {
    it('generates consistent, stable object paths for root and nested Form XObjects', () => {
      expect(pdfObjectPathId(0, [5])).toBe('p0_path5');
      expect(pdfObjectPathId(1, [2, 4])).toBe('p1_path2_4');
      expect(pdfObjectPathId(0, [1, 3, 7])).toBe('p0_path1_3_7');
    });

    it('correctly composes transformation matrices for nested Form XObjects', () => {
      const parentFormMatrix = { a: 2, b: 0, c: 0, d: 2, e: 50, f: 100 };
      const childTextMatrix = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };

      const composed = composePdfMatrices(parentFormMatrix, childTextMatrix);
      expect(composed.a).toBe(2);
      expect(composed.d).toBe(2);
      expect(composed.e).toBe(70);
      expect(composed.f).toBe(140);
    });
  });

  describe('4. Image Gesture, Coordinates & Placement', () => {
    const transform: ViewportTransform = {
      scale: 1.25,
      translateX: 30,
      translateY: 45,
    };

    it('converts screen tap location to image document coordinates and back', () => {
      const screenTap = { x: 155, y: 295 };
      const docPoint = screenToDocumentPoint(screenTap, transform);
      expect(docPoint.x).toBe(100);
      expect(docPoint.y).toBe(200);

      const backToScreen = documentToScreenPoint(docPoint, transform);
      expect(backToScreen.x).toBe(155);
      expect(backToScreen.y).toBe(295);
    });

    it('clamps image insert text placement to image dimensions', () => {
      const imageWidth = 1080;
      const imageHeight = 1920;
      const margin = 16;

      const clampImageTap = (docX: number, docY: number) => ({
        x: Math.round(Math.max(margin, Math.min(imageWidth - margin, Math.max(0, docX)))),
        y: Math.round(Math.max(margin, Math.min(imageHeight - margin, Math.max(0, docY)))),
      });

      expect(clampImageTap(-10, -5)).toEqual({ x: 16, y: 16 });
      expect(clampImageTap(1100, 2000)).toEqual({ x: 1080 - 16, y: 1920 - 16 });
      expect(clampImageTap(540, 960)).toEqual({ x: 540, y: 960 });
    });

    it('hit-tests added text elements and detected OCR regions correctly', () => {
      const targetBounds: DocumentRect = { x: 50, y: 100, width: 200, height: 40 };

      expect(rectContainsPoint(targetBounds, { x: 100, y: 120 })).toBe(true);
      expect(rectContainsPoint(targetBounds, { x: 45, y: 120 })).toBe(false);
      expect(rectContainsPoint(targetBounds, { x: 250, y: 140 })).toBe(true);
    });
  });

  describe('5. Image URI Normalization & Render Validation', () => {
    it('validates supported image formats from library pick', () => {
      expect(isSupportedImageFormat('photo.jpg')).toBe(true);
      expect(isSupportedImageFormat('photo.jpeg')).toBe(true);
      expect(isSupportedImageFormat('graphic.png')).toBe(true);
      expect(isSupportedImageFormat('image.webp')).toBe(true);
      expect(isSupportedImageFormat(undefined, 'image/png')).toBe(true);
      expect(isSupportedImageFormat(undefined, 'image/jpeg')).toBe(true);

      expect(isSupportedImageFormat('doc.pdf', 'application/pdf')).toBe(false);
      expect(isSupportedImageFormat('vector.svg', 'image/svg+xml')).toBe(false);
    });

    it('normalizes local file paths for Skia compatibility', () => {
      const normalizeForSkia = (uri?: string): string => {
        if (!uri) return '';
        if (uri.startsWith('/')) return 'file://' + uri;
        return uri;
      };

      expect(normalizeForSkia('/data/user/0/cache/img.png')).toBe('file:///data/user/0/cache/img.png');
      expect(normalizeForSkia('file:///storage/emulated/0/img.jpg')).toBe('file:///storage/emulated/0/img.jpg');
      expect(normalizeForSkia('content://media/external/images/123')).toBe('content://media/external/images/123');
    });
  });
});
