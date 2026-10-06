/**
 * Phase 10 — EXIF correctness and large-image / resource safety.
 */
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

import { NativeModules } from 'react-native';
import {
  MAX_IMAGE_PIXELS,
  PREVIEW_MAX_DIMENSION,
  assertImageWithinPixelBudget,
  createDocumentFromPickedImage,
  importImageIntoDocumentStorage,
} from '../src/features/image/importService';
import {
  calculateImageFocalZoom,
  calculateImageInitialFit,
  resolveImageZoomBounds,
  MIN_IMAGE_SCALE,
  MAX_IMAGE_SCALE,
} from '../src/features/image/imageViewportMath';
import { defaultReconstructionEngine } from '../src/features/image/reconstructionEngine';
import { buildImageRenderPlan } from '../src/features/image/imageRenderPlan';
import {
  ImageDecodeError,
  ImageInvalidDimensionsError,
  ImageTooLargeError,
  ImageWorkingCopyError,
} from '../src/errors';

const ROOT = '/data/app/files/pie';

function createMinimalFileStore() {
  return {
    getRootPath: jest.fn(async () => ROOT),
    writeFileAtomic: jest.fn(async () => undefined),
    readFile: jest.fn(async () => '{}'),
    exists: jest.fn(async () => true),
    copyFile: jest.fn(async () => undefined),
    deletePath: jest.fn(async () => undefined),
    listDirectory: jest.fn(async () => []),
    makeDirectory: jest.fn(async () => undefined),
  };
}

afterEach(() => {
  delete (NativeModules as any).ImageProcessingModule;
  delete (NativeModules as any).PieFileStoreModule;
});

describe('Phase 10 — Large images & EXIF', () => {
  describe('1. Fit-aware zoom bounds (no jump on first pinch)', () => {
    it('extends the minimum below 0.5 for images that fit at small scales', () => {
      const fit = calculateImageInitialFit({
        viewportWidth: 400,
        viewportHeight: 700,
        imageWidth: 4032,
        imageHeight: 3024,
        padding: 24,
      });
      expect(fit.scale).toBeLessThan(MIN_IMAGE_SCALE);

      const bounds = resolveImageZoomBounds(fit.scale);
      expect(bounds.minScale).toBeLessThanOrEqual(fit.scale);
      expect(bounds.maxScale).toBe(MAX_IMAGE_SCALE);

      // A small pinch from fit stays near fit instead of snapping up to 0.5
      const zoomed = calculateImageFocalZoom({
        currentScale: fit.scale,
        targetScale: fit.scale * 1.1,
        focalX: 200,
        focalY: 350,
        currentTx: fit.translateX,
        currentTy: fit.translateY,
        minScale: bounds.minScale,
        maxScale: bounds.maxScale,
      });
      expect(zoomed.scale).toBeCloseTo(fit.scale * 1.1, 2);
      expect(zoomed.scale).toBeLessThan(MIN_IMAGE_SCALE);
    });

    it('keeps the established bounds for images that fit at normal scales', () => {
      expect(resolveImageZoomBounds(1.5)).toEqual({ minScale: MIN_IMAGE_SCALE, maxScale: MAX_IMAGE_SCALE });
      expect(resolveImageZoomBounds(6).maxScale).toBe(6);
      expect(resolveImageZoomBounds(NaN)).toEqual({ minScale: MIN_IMAGE_SCALE, maxScale: MAX_IMAGE_SCALE });
      expect(resolveImageZoomBounds(0)).toEqual({ minScale: MIN_IMAGE_SCALE, maxScale: MAX_IMAGE_SCALE });
    });

    it('existing focal zoom defaults are unchanged (0.5 – 4.0)', () => {
      const z = calculateImageFocalZoom({
        currentScale: 1,
        targetScale: 0.1,
        focalX: 0,
        focalY: 0,
        currentTx: 0,
        currentTy: 0,
      });
      expect(z.scale).toBe(0.5);
    });
  });

  describe('2. Pixel budget', () => {
    it('accepts typical phone photos and rejects images beyond the budget', () => {
      expect(() => assertImageWithinPixelBudget(4032, 3024)).not.toThrow();
      expect(() => assertImageWithinPixelBudget(9000, 9000)).toThrow(ImageTooLargeError);
      expect(() => assertImageWithinPixelBudget(9000, 9000)).toThrow(ImageInvalidDimensionsError);
      expect(MAX_IMAGE_PIXELS).toBe(50_000_000);
    });

    it('legacy import path (no native durable import) enforces the budget', async () => {
      await expect(
        createDocumentFromPickedImage({
          uri: 'file:///cache/huge.png',
          width: 12000,
          height: 9000,
          fileName: 'huge.png',
        }),
      ).rejects.toBeInstanceOf(ImageTooLargeError);
    });
  });

  describe('3. Durable import with EXIF normalization', () => {
    it('stores an upright working copy, records the source orientation and keeps the source untouched', async () => {
      (NativeModules as any).PieFileStoreModule = createMinimalFileStore();
      const importImageDocument = jest.fn().mockImplementation(async (_src: string, destDir: string) => ({
        workingUri: `file://${destDir}/working.jpg`,
        previewUri: `file://${destDir}/preview.jpg`,
        width: 3024, // EXIF 6 (90° CW): raw 4032x3024 stored upright as 3024x4032
        height: 4032,
        mimeType: 'image/jpeg',
        exifOrientation: 6,
        fileSizeBytes: 3500000,
      }));
      (NativeModules as any).ImageProcessingModule = { importImageDocument };

      const doc = await createDocumentFromPickedImage({
        uri: 'content://media/external/images/media/55',
        width: 4032,
        height: 3024,
        fileName: 'IMG_0055.jpg',
        mimeType: 'image/jpeg',
      });

      const [srcArg, destArg, maxPixelsArg, previewArg] = importImageDocument.mock.calls[0] as unknown[];
      expect(srcArg).toBe('content://media/external/images/media/55');
      expect(destArg).toBe(`${ROOT}/documents/${doc.id}/assets`);
      expect(maxPixelsArg).toBe(MAX_IMAGE_PIXELS);
      expect(previewArg).toBe(PREVIEW_MAX_DIMENSION);

      const page = doc.pages[0];
      expect(page.dimensions).toEqual({ width: 3024, height: 4032 });
      expect(page.originalContent.assetUri).toBe(`file://${ROOT}/documents/${doc.id}/assets/working.jpg`);
      expect(page.originalContent.previewUri).toBe(`file://${ROOT}/documents/${doc.id}/assets/preview.jpg`);
      expect(page.originalContent.sourceOrientation).toBe(6);
      // The original source reference is preserved, never replaced
      expect(doc.metadata.sourceUri).toBe('content://media/external/images/media/55');

      // Session sees the upright working copy (orientation 1) with canonical dimensions
      expect(doc.session!.model.orientation).toBe(1);
      expect(doc.session!.getCanonicalDimensions()).toEqual({ width: 3024, height: 4032 });
      expect(doc.session!.model.sourceMetadata?.exifOrientation).toBe(6);
    });

    it('maps native import failures to typed errors', async () => {
      (NativeModules as any).PieFileStoreModule = createMinimalFileStore();
      const fail = (code: string) =>
        jest.fn().mockRejectedValue(Object.assign(new Error(code), { code }));

      (NativeModules as any).ImageProcessingModule = { importImageDocument: fail('IMAGE_TOO_LARGE') };
      await expect(importImageIntoDocumentStorage('file:///a.jpg', 'doc-a')).rejects.toBeInstanceOf(ImageTooLargeError);

      (NativeModules as any).ImageProcessingModule = { importImageDocument: fail('IMAGE_DECODE_FAILED') };
      await expect(importImageIntoDocumentStorage('file:///a.jpg', 'doc-a')).rejects.toBeInstanceOf(ImageDecodeError);

      (NativeModules as any).ImageProcessingModule = { importImageDocument: fail('IMAGE_IMPORT_FAILED') };
      await expect(importImageIntoDocumentStorage('file:///a.jpg', 'doc-a')).rejects.toBeInstanceOf(ImageWorkingCopyError);
    });

    it('rejects an invalid native import result', async () => {
      (NativeModules as any).PieFileStoreModule = createMinimalFileStore();
      (NativeModules as any).ImageProcessingModule = {
        importImageDocument: jest.fn().mockResolvedValue({ workingUri: '', width: 0, height: 0 }),
      };
      await expect(importImageIntoDocumentStorage('file:///a.jpg', 'doc-a')).rejects.toBeInstanceOf(
        ImageWorkingCopyError,
      );
    });

    it('returns null (legacy path) when the durable import is not linked', async () => {
      (NativeModules as any).ImageProcessingModule = {};
      expect(await importImageIntoDocumentStorage('file:///a.jpg', 'doc-a')).toBeNull();

      (NativeModules as any).ImageProcessingModule = { importImageDocument: jest.fn() };
      // No native file store -> no document directory -> legacy path
      expect(await importImageIntoDocumentStorage('file:///a.jpg', 'doc-a')).toBeNull();
    });
  });

  describe('4. Display preview vs full-resolution editing', () => {
    it('render plan and document geometry are independent of the display preview', () => {
      const base = {
        editableTextRegions: [
          {
            id: 'r1',
            pageIndex: 0,
            bounds: { x: 100, y: 100, width: 500, height: 60 },
            originalText: 'a',
            currentText: 'b',
            status: 'modified' as const,
            style: { fontSize: 40, color: '#000' },
            reconstructedPatchUri: 'file:///p.png',
          },
        ],
        addedText: [],
      };
      expect(buildImageRenderPlan(base)).toEqual(buildImageRenderPlan(JSON.parse(JSON.stringify(base))));
    });

    it('reconstruction writes into the session directory when one is provided', async () => {
      const toDir = jest.fn().mockResolvedValue({
        patchUri: `file://${ROOT}/sessions/doc-1/patches/patch_1.png`,
        bounds: { x: 95, y: 95, width: 510, height: 70 },
        estimatedBackgroundColor: '#FFFFFF',
        estimatedTextColor: '#000000',
        confidence: 0.92,
      });
      const legacy = jest.fn();
      (NativeModules as any).ImageProcessingModule = {
        reconstructBackground: legacy,
        reconstructBackgroundToDirectory: toDir,
      };

      const region = { x: 100, y: 100, width: 500, height: 60 };
      const res = await defaultReconstructionEngine.reconstructBackground(
        'file:///app/working.jpg',
        region,
        { outputDir: `${ROOT}/sessions/doc-1/patches` },
      );
      expect(toDir).toHaveBeenCalledWith('file:///app/working.jpg', 100, 100, 500, 60, `${ROOT}/sessions/doc-1/patches`);
      expect(legacy).not.toHaveBeenCalled();
      expect(res.patchUri).toContain('/sessions/doc-1/patches/');
    });

    it('reconstruction keeps the original native call when no directory is provided', async () => {
      const legacy = jest.fn().mockResolvedValue({
        patchUri: 'file:///cache/patch.png',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      });
      (NativeModules as any).ImageProcessingModule = {
        reconstructBackground: legacy,
        reconstructBackgroundToDirectory: jest.fn(),
      };
      await defaultReconstructionEngine.reconstructBackground('file:///app/working.jpg', {
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      });
      expect(legacy).toHaveBeenCalledWith('file:///app/working.jpg', 1, 2, 3, 4);
    });
  });
});
