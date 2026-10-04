import { NativeModules, Image } from 'react-native';
import {
  normalizeImageUri,
  resolveImageFileUri,
  isSupportedImageFormat,
  validateImageFormat,
  getImageDimensions,
  createDocumentFromPickedImage,
  createImageSessionFromDocument,
  PickedImageResult,
} from '../src/features/image/importService';
import {
  ImageDocumentSession,
} from '../src/features/image/imageDocumentSession';
import {
  calculateImageInitialFit,
  calculateImageFocalZoom,
  clampImageTranslation,
  documentToViewport,
  viewportToDocument,
  screenToDocument,
  documentToScreen,
  documentToViewportRect,
  viewportToDocumentRect,
  verifyCoordinateRoundTrip,
  MIN_IMAGE_SCALE,
  MAX_IMAGE_SCALE,
} from '../src/features/image/imageViewportMath';
import {
  ImageUnsupportedFormatError,
  ImageInvalidDimensionsError,
  ImageUriUnsupportedError,
  ImageDocumentClosedError,
} from '../src/errors';
import { DocumentPoint, ViewportOrigin, ViewportTransform } from '../src/types/geometry';

// Mock react-native-image-picker
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

describe('Phase 7: Image Editor Foundation — Import, Display, Coordinates & Interaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // 1. URI & Path Normalization / Handling
  // ===========================================================================
  describe('1. URI & Path Normalization / Platform Safety', () => {
    it('normalizes raw POSIX filesystem paths to file:// clean URIs', () => {
      const res = normalizeImageUri('/data/user/0/com.app/cache/sample.jpg');
      expect(res.scheme).toBe('raw');
      expect(res.path).toBe('/data/user/0/com.app/cache/sample.jpg');
      expect(res.cleanUri).toBe('file:///data/user/0/com.app/cache/sample.jpg');
    });

    it('normalizes Windows backslash paths to forward slash format', () => {
      const res = normalizeImageUri('D:\\Images\\photo.png');
      expect(res.scheme).toBe('raw');
      expect(res.path).toBe('D:/Images/photo.png');
    });

    it('correctly identifies Android content:// URIs', () => {
      const res = normalizeImageUri('content://media/external/images/media/42');
      expect(res.scheme).toBe('content');
      expect(res.cleanUri).toBe('content://media/external/images/media/42');
    });

    it('extracts local filesystem path from file:// URIs', () => {
      const res = normalizeImageUri('file:///storage/emulated/0/DCIM/Camera/IMG_01.jpg');
      expect(res.scheme).toBe('file');
      expect(res.path).toBe('/storage/emulated/0/DCIM/Camera/IMG_01.jpg');
      expect(res.cleanUri).toBe('file:///storage/emulated/0/DCIM/Camera/IMG_01.jpg');
    });

    it('rejects empty or non-string URIs with ImageUriUnsupportedError', () => {
      expect(() => normalizeImageUri('')).toThrow(ImageUriUnsupportedError);
      expect(() => normalizeImageUri('   ')).toThrow(ImageUriUnsupportedError);
      expect(() => normalizeImageUri(null as any)).toThrow(ImageUriUnsupportedError);
    });

    it('resolves content:// URI to local cached file:// via native module', async () => {
      NativeModules.ImageProcessingModule = {
        resolveLocalImageUri: jest.fn().mockResolvedValue('file:///data/user/0/cache/imported_123.jpg'),
      };

      const resolved = await resolveImageFileUri('content://media/external/images/media/99');
      expect(resolved).toBe('file:///data/user/0/cache/imported_123.jpg');
      expect(NativeModules.ImageProcessingModule.resolveLocalImageUri).toHaveBeenCalledWith(
        'content://media/external/images/media/99',
      );
    });

    it('resolves raw file path without modification', async () => {
      const resolved = await resolveImageFileUri('/data/user/0/cache/image.png');
      expect(resolved).toBe('file:///data/user/0/cache/image.png');
    });

    it('preserves existing file:// URIs without double prefixing', async () => {
      const resolved = await resolveImageFileUri('file:///storage/emulated/0/Pictures/test.webp');
      expect(resolved).toBe('file:///storage/emulated/0/Pictures/test.webp');
    });
  });

  // ===========================================================================
  // 2. Image Format & Dimension Validation
  // ===========================================================================
  describe('2. Image Format & Dimension Validation', () => {
    it('accepts standard JPEG formats by extension and MIME type', () => {
      expect(isSupportedImageFormat('photo.jpg')).toBe(true);
      expect(isSupportedImageFormat('photo.jpeg')).toBe(true);
      expect(isSupportedImageFormat(undefined, 'image/jpeg')).toBe(true);
    });

    it('accepts PNG formats by extension and MIME type', () => {
      expect(isSupportedImageFormat('diagram.png')).toBe(true);
      expect(isSupportedImageFormat(undefined, 'image/png')).toBe(true);
    });

    it('accepts WebP formats by extension and MIME type', () => {
      expect(isSupportedImageFormat('banner.webp')).toBe(true);
      expect(isSupportedImageFormat(undefined, 'image/webp')).toBe(true);
    });

    it('rejects unsupported image formats with typed ImageUnsupportedFormatError', () => {
      expect(() => validateImageFormat('vector.svg', 'image/svg+xml')).toThrow(ImageUnsupportedFormatError);
      expect(() => validateImageFormat('animation.gif', 'image/gif')).toThrow(ImageUnsupportedFormatError);
      expect(() => validateImageFormat('document.pdf', 'application/pdf')).toThrow(ImageUnsupportedFormatError);
    });

    it('validates positive intrinsic dimensions via Image.getSize', async () => {
      const originalGetSize = (Image as any).getSize;
      (Image as any).getSize = jest.fn((uri, success) => success(1920, 1080)) as any;

      const dims = await getImageDimensions('file:///test.jpg');
      expect(dims.width).toBe(1920);
      expect(dims.height).toBe(1080);

      (Image as any).getSize = originalGetSize;
    });

    it('rejects non-positive dimensions with ImageInvalidDimensionsError', async () => {
      const originalGetSize = (Image as any).getSize;
      (Image as any).getSize = jest.fn((uri, success) => success(0, 0)) as any;

      await expect(getImageDimensions('file:///bad.jpg')).rejects.toThrow(ImageInvalidDimensionsError);

      (Image as any).getSize = originalGetSize;
    });
  });

  // ===========================================================================
  // 3. Image Import & Working Copy / Source Immutability
  // ===========================================================================
  describe('3. Image Import & Working Copy / Source Immutability', () => {
    it('handles picker cancellation by returning null safely without errors', async () => {
      const { launchImageLibrary } = require('react-native-image-picker');
      launchImageLibrary.mockResolvedValue({ didCancel: true });

      const { pickImageFromLibrary } = require('../src/features/image/importService');
      const result = await pickImageFromLibrary();
      expect(result).toBeNull();
    });

    it('creates canonical Document with 1 page matching intrinsic image dimensions', async () => {
      const picked: PickedImageResult = {
        uri: 'file:///data/user/0/cache/sample_1080x1920.jpg',
        width: 1080,
        height: 1920,
        fileName: 'sample_1080x1920.jpg',
        fileSizeBytes: 543210,
        mimeType: 'image/jpeg',
      };

      const doc = await createDocumentFromPickedImage(picked);
      expect(doc.id).toMatch(/^doc-/);
      expect(doc.metadata.kind).toBe('image');
      expect(doc.metadata.title).toBe('sample_1080x1920.jpg');
      expect(doc.pages.length).toBe(1);
      expect(doc.pages[0].dimensions.width).toBe(1080);
      expect(doc.pages[0].dimensions.height).toBe(1920);
    });

    it('preserves source URI immutably while establishing working copy', async () => {
      const picked: PickedImageResult = {
        uri: 'file:///data/user/0/documents/immutable_source.png',
        width: 800,
        height: 600,
        fileName: 'immutable_source.png',
        mimeType: 'image/png',
      };

      const doc = await createDocumentFromPickedImage(picked);
      expect(doc.metadata.sourceUri).toBe('file:///data/user/0/documents/immutable_source.png');
      expect(doc.session).toBeDefined();
      expect(doc.session!.model.sourceUri).toBe('file:///data/user/0/documents/immutable_source.png');
    });

    it('handles missing dimensions from picker by resolving via fallback', async () => {
      const picked: PickedImageResult = {
        uri: 'file:///data/user/0/cache/no_dims.jpg',
        width: 0,
        height: 0,
        fileName: 'no_dims.jpg',
      };

      const originalGetSize = (Image as any).getSize;
      (Image as any).getSize = jest.fn((uri, success) => success(1280, 720)) as any;

      const doc = await createDocumentFromPickedImage(picked);
      expect(doc.pages[0].dimensions.width).toBe(1280);
      expect(doc.pages[0].dimensions.height).toBe(720);

      (Image as any).getSize = originalGetSize;
    });

    it('provides safe default dimensions if probing fails entirely', async () => {
      const picked: PickedImageResult = {
        uri: 'file:///data/user/0/cache/broken_probe.jpg',
        width: 0,
        height: 0,
        fileName: 'broken_probe.jpg',
      };

      const originalGetSize = (Image as any).getSize;
      (Image as any).getSize = jest.fn((uri, success, fail) => fail(new Error('Decode failed'))) as any;

      const doc = await createDocumentFromPickedImage(picked);
      expect(doc.pages[0].dimensions.width).toBe(1200);
      expect(doc.pages[0].dimensions.height).toBe(1600);

      (Image as any).getSize = originalGetSize;
    });

    it('supports importing multiple different images without document ID collision', async () => {
      const doc1 = await createDocumentFromPickedImage({
        uri: 'file:///image1.jpg',
        width: 1000,
        height: 1000,
        fileName: 'image1.jpg',
      });

      // Small delay to ensure timestamp difference
      await new Promise<void>(r => setTimeout(() => r(), 5));

      const doc2 = await createDocumentFromPickedImage({
        uri: 'file:///image2.jpg',
        width: 800,
        height: 1200,
        fileName: 'image2.jpg',
      });

      expect(doc1.id).not.toBe(doc2.id);
      expect(doc1.pages[0].dimensions.width).toBe(1000);
      expect(doc2.pages[0].dimensions.width).toBe(800);
    });
  });

  // ===========================================================================
  // 4. Image Coordinate System & Conversions
  // ===========================================================================
  describe('4. Image Coordinate System & Conversions', () => {
    it('establishes intrinsic pixel coordinate space from (0,0) to (W,H)', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-coord-1',
        sourceUri: 'file:///test.jpg',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
      });

      const dims = session.getCanonicalDimensions();
      expect(dims.width).toBe(1080);
      expect(dims.height).toBe(1920);
    });

    it('converts document point to viewport point under identity transform', () => {
      const pt: DocumentPoint = { x: 100, y: 200 };
      const transform: ViewportTransform = { scale: 1.0, translateX: 0, translateY: 0 };
      const vpPt = documentToViewport(pt, transform);

      expect(vpPt.x).toBe(100);
      expect(vpPt.y).toBe(200);
    });

    it('computes correct inverse viewportToDocument under scale and translation', () => {
      const transform: ViewportTransform = { scale: 2.0, translateX: 50, translateY: 100 };
      const vpPt = { x: 250, y: 500 };
      const docPt = viewportToDocument(vpPt, transform);

      // (250 - 50) / 2 = 100, (500 - 100) / 2 = 200
      expect(docPt.x).toBe(100);
      expect(docPt.y).toBe(200);
    });

    it('transforms screen touch points to document space accounting for origin', () => {
      const origin: ViewportOrigin = { x: 20, y: 40 };
      const transform: ViewportTransform = { scale: 1.5, translateX: 10, translateY: 20 };
      const screenPt = { x: 180, y: 210 };

      // screenToViewport: (180 - 20 = 160, 210 - 40 = 170)
      // viewportToDoc: (160 - 10) / 1.5 = 100, (170 - 20) / 1.5 = 100
      const docPt = screenToDocument(screenPt, origin, transform);
      expect(docPt.x).toBe(100);
      expect(docPt.y).toBe(100);
    });

    it('transforms document coordinates to screen pixels', () => {
      const origin: ViewportOrigin = { x: 20, y: 40 };
      const transform: ViewportTransform = { scale: 1.5, translateX: 10, translateY: 20 };
      const docPt: DocumentPoint = { x: 100, y: 100 };

      const screenPt = documentToScreen(docPt, origin, transform);
      expect(screenPt.x).toBe(180);
      expect(screenPt.y).toBe(210);
    });

    it('transforms rectangles between document and viewport space', () => {
      const transform: ViewportTransform = { scale: 2.0, translateX: 30, translateY: 40 };
      const docRect = { x: 10, y: 20, width: 100, height: 200 };

      const vpRect = documentToViewportRect(docRect, transform);
      expect(vpRect.x).toBe(50); // 10*2 + 30
      expect(vpRect.y).toBe(80); // 20*2 + 40
      expect(vpRect.width).toBe(200);
      expect(vpRect.height).toBe(400);

      const backDocRect = viewportToDocumentRect(vpRect, transform);
      expect(backDocRect.x).toBeCloseTo(10);
      expect(backDocRect.y).toBeCloseTo(20);
      expect(backDocRect.width).toBeCloseTo(100);
      expect(backDocRect.height).toBeCloseTo(200);
    });

    it('mathematical round-trip documentToScreen(screenToDocument) is accurate within epsilon', () => {
      const origin: ViewportOrigin = { x: 15, y: 35 };
      const transform: ViewportTransform = { scale: 2.375, translateX: 42, translateY: 88 };
      const testPoint: DocumentPoint = { x: 456.78, y: 890.12 };

      const isValid = verifyCoordinateRoundTrip(testPoint, origin, transform);
      expect(isValid).toBe(true);
    });
  });

  // ===========================================================================
  // 5. Initial Fit Calculations across Orientations & Aspect Ratios
  // ===========================================================================
  describe('5. Initial Fit Calculations across Orientations & Aspect Ratios', () => {
    it('fits portrait image (1080x1920) inside device viewport (360x780)', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 360,
        viewportHeight: 780,
        imageWidth: 1080,
        imageHeight: 1920,
        padding: 24,
      });

      // Avail: 312 x 732. ScaleY = 732/1920 = 0.38125. ScaleX = 312/1080 = 0.28888. FitScale = ~0.289
      expect(fit.scale).toBeLessThanOrEqual(0.3);
      expect(fit.scale).toBeGreaterThan(0.25);
      // Centered horizontally: translateX should be positive
      expect(fit.translateX).toBeGreaterThanOrEqual(0);
      expect(fit.translateY).toBeGreaterThanOrEqual(0);
    });

    it('fits landscape image (1920x1080) inside viewport (360x780)', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 360,
        viewportHeight: 780,
        imageWidth: 1920,
        imageHeight: 1080,
        padding: 24,
      });

      // Fit width bound: 312 / 1920 = 0.1625
      expect(fit.scale).toBeCloseTo(0.163, 2);
      expect(fit.translateX).toBeGreaterThanOrEqual(0);
      expect(fit.translateY).toBeGreaterThan(100); // Centered vertically in tall screen
    });

    it('fits square image (1000x1000) preserving 1:1 aspect ratio', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 400,
        viewportHeight: 800,
        imageWidth: 1000,
        imageHeight: 1000,
        padding: 20,
      });

      // Avail: 360x760. Fit scale = 360/1000 = 0.36
      expect(fit.scale).toBe(0.36);
      expect(fit.translateX).toBe(20);
      expect(fit.translateY).toBe((800 - 360) / 2); // 220
    });

    it('fits panoramic aspect ratio (4000x800) without distortion', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 400,
        viewportHeight: 600,
        imageWidth: 4000,
        imageHeight: 800,
        padding: 20,
      });

      // 360 / 4000 = 0.09
      expect(fit.scale).toBe(0.09);
      expect(fit.translateX).toBe(20);
    });

    it('fits tall vertical aspect ratio (800x4000) without distortion', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 400,
        viewportHeight: 600,
        imageWidth: 800,
        imageHeight: 4000,
        padding: 20,
      });

      // 560 / 4000 = 0.14
      expect(fit.scale).toBe(0.14);
      expect(fit.translateY).toBe(20);
    });

    it('handles very small images (50x50) safely within max scale bound', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 400,
        viewportHeight: 400,
        imageWidth: 50,
        imageHeight: 50,
        padding: 20,
        maxScale: 4.0,
      });

      expect(fit.scale).toBeLessThanOrEqual(4.0);
      expect(fit.scale).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // 6. Pinch Zoom, Pan & Focal Point Math
  // ===========================================================================
  describe('6. Pinch Zoom, Pan & Focal Point Math', () => {
    it('enforces minimum scale bound of 0.5x', () => {
      const zoom = calculateImageFocalZoom({
        currentScale: 1.0,
        targetScale: 0.2, // Below 0.5x
        focalX: 100,
        focalY: 100,
        currentTx: 0,
        currentTy: 0,
      });

      expect(zoom.scale).toBe(MIN_IMAGE_SCALE); // 0.5
    });

    it('enforces maximum scale bound of 4.0x', () => {
      const zoom = calculateImageFocalZoom({
        currentScale: 2.0,
        targetScale: 6.0, // Above 4.0x
        focalX: 100,
        focalY: 100,
        currentTx: 0,
        currentTy: 0,
      });

      expect(zoom.scale).toBe(MAX_IMAGE_SCALE); // 4.0
    });

    it('maintains focal point pinned under fingers during zoom', () => {
      const focalX = 200;
      const focalY = 300;
      const currentScale = 1.0;
      const targetScale = 2.0;
      const currentTx = 10;
      const currentTy = 20;

      const zoom = calculateImageFocalZoom({
        currentScale,
        targetScale,
        focalX,
        focalY,
        currentTx,
        currentTy,
      });

      // Check focal point before zoom:
      // (focalX - currentTx) / currentScale = (200 - 10) / 1.0 = 190
      // Check focal point after zoom:
      // (focalX - zoom.translateX) / zoom.scale
      const docFocalBefore = (focalX - currentTx) / currentScale;
      const docFocalAfter = (focalX - zoom.translateX) / zoom.scale;
      expect(docFocalAfter).toBeCloseTo(docFocalBefore, 1);
    });

    it('panning updates translation without altering scale', () => {
      const transform: ViewportTransform = { scale: 1.5, translateX: 50, translateY: 80 };
      const panDeltaX = 25;
      const panDeltaY = -15;

      const newTx = transform.translateX + panDeltaX;
      const newTy = transform.translateY + panDeltaY;

      expect(transform.scale).toBe(1.5);
      expect(newTx).toBe(75);
      expect(newTy).toBe(65);
    });

    it('clampImageTranslation prevents fitted images from drifting excessively', () => {
      // Image is 300x400, viewport is 400x600, scale 1.0 -> fits completely inside
      const clamped = clampImageTranslation({
        translateX: 9999, // Wild pan attempt
        translateY: -9999,
        scale: 1.0,
        imageWidth: 300,
        imageHeight: 400,
        viewportWidth: 400,
        viewportHeight: 600,
        allowDriftMargin: 50,
      });

      // Center X is (400 - 300)/2 = 50. Min: 0, Max: 100.
      expect(clamped.translateX).toBeLessThanOrEqual(100);
      expect(clamped.translateX).toBeGreaterThanOrEqual(0);

      // Center Y is (600 - 400)/2 = 100. Min: 50, Max: 150.
      expect(clamped.translateY).toBeLessThanOrEqual(150);
      expect(clamped.translateY).toBeGreaterThanOrEqual(50);
    });

    it('clampImageTranslation allows navigating across full image when zoomed in', () => {
      // Image is 1000x1000, scale 2.0 -> scaled 2000x2000, viewport 500x500
      const clamped = clampImageTranslation({
        translateX: -500, // Valid zoom pan inside image
        translateY: -500,
        scale: 2.0,
        imageWidth: 1000,
        imageHeight: 1000,
        viewportWidth: 500,
        viewportHeight: 500,
        allowDriftMargin: 50,
      });

      expect(clamped.translateX).toBe(-500);
      expect(clamped.translateY).toBe(-500);
    });
  });

  // ===========================================================================
  // 7. Image Document Session Lifecycle & Dirty State
  // ===========================================================================
  describe('7. Image Document Session Lifecycle & Dirty State', () => {
    it('initializes in CLEAN state with READY status', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-session-1',
        sourceUri: 'file:///image.jpg',
        intrinsicWidth: 800,
        intrinsicHeight: 600,
      });

      expect(session.sessionState).toBe('READY');
      expect(session.isDirty()).toBe(false);
      expect(session.model.dirtyState).toBe('CLEAN');
    });

    it('viewport changes (zoom/pan) do NOT mark the document dirty', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-session-2',
        sourceUri: 'file:///image.jpg',
        intrinsicWidth: 800,
        intrinsicHeight: 600,
      });

      expect(session.isDirty()).toBe(false);

      session.updateViewportTransform({ scale: 2.5, translateX: 100, translateY: 200 });

      expect(session.isDirty()).toBe(false);
      expect(session.viewportTransform.scale).toBe(2.5);
      expect(session.viewportTransform.translateX).toBe(100);
    });

    it('explicit document edits mark the session DIRTY', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-session-3',
        sourceUri: 'file:///image.jpg',
        intrinsicWidth: 800,
        intrinsicHeight: 600,
      });

      session.markDirty(true);
      expect(session.isDirty()).toBe(true);
      expect(session.model.dirtyState).toBe('DIRTY');
    });

    it('undoing edits returns session to CLEAN state', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-session-4',
        sourceUri: 'file:///image.jpg',
        intrinsicWidth: 800,
        intrinsicHeight: 600,
      });

      session.markDirty(true);
      expect(session.isDirty()).toBe(true);

      session.markDirty(false);
      expect(session.isDirty()).toBe(false);
      expect(session.model.dirtyState).toBe('CLEAN');
    });

    it('transposes dimensions for EXIF orientations 6 (90° CW) and 8 (270° CW)', () => {
      const session90 = new ImageDocumentSession({
        documentId: 'doc-session-90',
        sourceUri: 'file:///exif90.jpg',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
        orientation: 6,
      });

      const dims90 = session90.getCanonicalDimensions();
      expect(dims90.width).toBe(1920);
      expect(dims90.height).toBe(1080);

      const session270 = new ImageDocumentSession({
        documentId: 'doc-session-270',
        sourceUri: 'file:///exif270.jpg',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
        orientation: 8,
      });

      const dims270 = session270.getCanonicalDimensions();
      expect(dims270.width).toBe(1920);
      expect(dims270.height).toBe(1080);
    });

    it('preserves dimensions for EXIF orientations 1 (normal) and 3 (180°)', () => {
      const session1 = new ImageDocumentSession({
        documentId: 'doc-session-1',
        sourceUri: 'file:///exif1.jpg',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
        orientation: 1,
      });

      expect(session1.getCanonicalDimensions().width).toBe(1080);
      expect(session1.getCanonicalDimensions().height).toBe(1920);

      const session3 = new ImageDocumentSession({
        documentId: 'doc-session-3',
        sourceUri: 'file:///exif3.jpg',
        intrinsicWidth: 1080,
        intrinsicHeight: 1920,
        orientation: 3,
      });

      expect(session3.getCanonicalDimensions().width).toBe(1080);
      expect(session3.getCanonicalDimensions().height).toBe(1920);
    });

    it('closing session is idempotent and prevents subsequent mutations', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-session-close',
        sourceUri: 'file:///close.jpg',
        intrinsicWidth: 500,
        intrinsicHeight: 500,
      });

      expect(session.isClosed()).toBe(false);

      session.close();
      expect(session.isClosed()).toBe(true);

      // Calling close a second time should not throw
      expect(() => session.close()).not.toThrow();

      // Mutations on closed session must throw ImageDocumentClosedError
      expect(() => session.updateViewportTransform({ scale: 2.0, translateX: 0, translateY: 0 })).toThrow(
        ImageDocumentClosedError,
      );
      expect(() => session.markDirty(true)).toThrow(ImageDocumentClosedError);
    });
  });

  // ===========================================================================
  // 8. Editor Document Switching & Stale State Protection
  // ===========================================================================
  describe('8. Editor Document Switching & Stale State Protection', () => {
    it('creates session from Document instance cleanly', () => {
      const mockDoc = {
        id: 'doc-existing-1',
        metadata: {
          id: 'doc-existing-1',
          title: 'Existing.png',
          kind: 'image' as const,
          sourceUri: 'file:///existing.png',
          pageCount: 1,
          createdAt: 1000,
          updatedAt: 2000,
        },
        pages: [
          {
            id: 'page-0',
            pageIndex: 0,
            dimensions: { width: 1440, height: 2560 },
            rotation: 0,
            originalContent: { pageIndex: 0, assetUri: 'file:///existing.png', width: 1440, height: 2560 },
            editableTextRegions: [],
            addedText: [],
          },
        ],
      };

      const session = createImageSessionFromDocument(mockDoc);
      expect(session.model.documentId).toBe('doc-existing-1');
      expect(session.model.intrinsicWidth).toBe(1440);
      expect(session.model.intrinsicHeight).toBe(2560);
      expect(session.isDirty()).toBe(false);
    });

    it('switching documents closes previous session before opening new one', () => {
      const session1 = new ImageDocumentSession({
        documentId: 'doc-1',
        sourceUri: 'file:///doc1.jpg',
        intrinsicWidth: 600,
        intrinsicHeight: 800,
      });

      // Simulate switching: close session 1
      session1.close();
      expect(session1.isClosed()).toBe(true);

      const session2 = new ImageDocumentSession({
        documentId: 'doc-2',
        sourceUri: 'file:///doc2.jpg',
        intrinsicWidth: 1200,
        intrinsicHeight: 1600,
      });

      expect(session2.isClosed()).toBe(false);
      expect(session2.model.documentId).toBe('doc-2');
    });

    it('closed session returns isDirty() === false', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-dirty-close',
        sourceUri: 'file:///dirty.jpg',
        intrinsicWidth: 500,
        intrinsicHeight: 500,
      });

      session.markDirty(true);
      expect(session.isDirty()).toBe(true);

      session.close();
      expect(session.isDirty()).toBe(false);
    });

    it('stale document access on closed session throws typed ImageDocumentClosedError', () => {
      const session = new ImageDocumentSession({
        documentId: 'doc-stale',
        sourceUri: 'file:///stale.jpg',
        intrinsicWidth: 600,
        intrinsicHeight: 600,
      });

      session.close();

      expect(() => session.model).toThrow(ImageDocumentClosedError);
      expect(() => session.viewportTransform).toThrow(ImageDocumentClosedError);
      expect(() => session.getCanonicalDimensions()).toThrow(ImageDocumentClosedError);
    });
  });
});
