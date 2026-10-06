/**
 * Phase 10 — User-visible image export.
 *
 * - The on-screen canvas and the native exporter consume one shared ImageRenderPlan.
 * - Export always composites the full-resolution working image in document coordinates.
 * - Gallery publishing (Android 10+) and Share are explicit destinations.
 * - Simulated native results are only allowed in the Jest environment.
 */
import { NativeModules } from 'react-native';
import { Document, DocumentPage } from '../src/types/document';
import { ImageExportEngine, MAX_EXPORT_PIXELS } from '../src/features/export/imageExportEngine';
import {
  buildImageRenderPlan,
  DEFAULT_ADDED_TEXT_FONT_SIZE,
  REPLACEMENT_TEXT_X_INSET,
} from '../src/features/image/imageRenderPlan';
import { fitTextToBoundingBox } from '../src/features/text/textFitting';
import { ExportError, ImageExportUnavailableError } from '../src/errors';

function createPage(): DocumentPage {
  return {
    id: 'page-0',
    pageIndex: 0,
    dimensions: { width: 4000, height: 3000 },
    rotation: 0,
    originalContent: {
      pageIndex: 0,
      assetUri: 'file:///app/pie/documents/doc-exp/assets/working.jpg',
      previewUri: 'file:///app/pie/documents/doc-exp/assets/preview.jpg',
      width: 4000,
      height: 3000,
    },
    editableTextRegions: [
      {
        id: 'r-detected',
        pageIndex: 0,
        bounds: { x: 10, y: 10, width: 300, height: 40 },
        originalText: 'Untouched',
        currentText: 'Untouched',
        status: 'detected',
        style: { fontSize: 30, color: '#000000' },
      },
      {
        id: 'r-modified',
        pageIndex: 0,
        bounds: { x: 200, y: 150, width: 600, height: 80 },
        originalText: 'OLD HEADER',
        currentText: 'NEW HEADER',
        status: 'modified',
        style: {
          fontSize: 64,
          color: '#1D4ED8',
          fontWeight: 'bold',
          fontStyle: 'italic',
          fontFamily: 'serif',
        },
        reconstructedPatchUri: 'file:///app/pie/documents/doc-exp/patches/p-mod.png',
        reconstructedPatchBounds: { x: 195, y: 145, width: 610, height: 90 },
      },
      {
        id: 'r-deleted',
        pageIndex: 0,
        bounds: { x: 200, y: 600, width: 400, height: 50 },
        originalText: 'REMOVE ME',
        currentText: '',
        status: 'deleted',
        style: { fontSize: 40, color: '#000000' },
        reconstructedPatchUri: 'file:///app/pie/documents/doc-exp/patches/p-del.png',
        reconstructedPatchBounds: { x: 195, y: 595, width: 410, height: 60 },
      },
      {
        id: 'r-modified-no-patch',
        pageIndex: 0,
        bounds: { x: 200, y: 900, width: 400, height: 50 },
        originalText: 'PATCH LOST',
        currentText: 'STILL EDITED',
        status: 'modified',
        style: { fontSize: 40, color: '#000000' },
        patchUnavailable: true,
      },
    ],
    addedText: [
      {
        id: 'added-1',
        pageIndex: 0,
        text: 'PAID',
        bounds: { x: 3000, y: 2500, width: 200, height: 60 },
        style: { fontSize: 47.6, color: '#DC2626', fontWeight: 'bold', fontStyle: 'normal' },
      },
      {
        id: 'added-default',
        pageIndex: 0,
        text: 'note',
        bounds: { x: 100, y: 2800, width: 80, height: 20 },
        style: { fontSize: 0, color: '' },
      },
      {
        id: 'added-blank',
        pageIndex: 0,
        text: '   ',
        bounds: { x: 1, y: 1, width: 1, height: 1 },
        style: { fontSize: 12, color: '#000' },
      },
    ],
  };
}

function createDoc(): Document {
  return {
    id: 'doc-exp',
    metadata: {
      id: 'doc-exp',
      title: 'Holiday Photo (final).jpg',
      kind: 'image',
      sourceUri: 'content://media/external/images/media/7',
      pageCount: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    pages: [createPage()],
  };
}

describe('Phase 10 — Image Export', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    delete (NativeModules as any).ImageProcessingModule;
  });

  describe('1. Shared render plan', () => {
    it('includes patches only for modified/deleted regions that have a patch file', () => {
      const plan = buildImageRenderPlan(createPage());
      expect(plan.patches.map((p) => p.regionId)).toEqual(['r-modified', 'r-deleted']);
      expect(plan.patches[0].bounds).toEqual({ x: 195, y: 145, width: 610, height: 90 });
    });

    it('produces replacement and added text layers with canvas-identical metrics', () => {
      const page = createPage();
      const plan = buildImageRenderPlan(page);
      const ids = plan.textElements.map((t) => t.sourceId);
      expect(ids).toEqual(['r-modified', 'r-modified-no-patch', 'added-1', 'added-default']);

      const replacement = plan.textElements[0];
      const fit = fitTextToBoundingBox(
        page.editableTextRegions[1].bounds,
        'OLD HEADER',
        'NEW HEADER',
        page.editableTextRegions[1].style,
      );
      expect(replacement.fittedFontSize).toBe(Math.max(7, Math.round(fit.fittedFontSize)));
      expect(Number.isInteger(replacement.fittedFontSize)).toBe(true);
      expect(replacement.baselineY).toBe(fit.baselineY);
      expect(replacement.drawX).toBe(200 + REPLACEMENT_TEXT_X_INSET);
      expect(replacement.fontStyle).toBe('italic');
      expect(replacement.fontWeight).toBe('bold');
      expect(replacement.fontFamily).toBe('serif');

      const added = plan.textElements[2];
      expect(added.fittedFontSize).toBe(48);
      expect(added.baselineY).toBeCloseTo(2500 + 47.6 * 0.85, 6);
      expect(added.drawX).toBe(3000);

      const fallback = plan.textElements[3];
      expect(fallback.fittedFontSize).toBe(DEFAULT_ADDED_TEXT_FONT_SIZE);
      expect(fallback.color).toBe('#111827');
      expect(fallback.fontFamily).toBe('sans-serif');
    });

    it('tolerates legacy added text persisted without a bounds object', () => {
      const page = createPage();
      const legacyAdded = { id: 'legacy', pageIndex: 0, text: 'Old', x: 5, y: 7, width: 30, height: 10, style: { fontSize: 20, color: '#000' } };
      const plan = buildImageRenderPlan({
        editableTextRegions: [],
        addedText: [legacyAdded as any],
      });
      expect(plan.textElements[0].bounds).toEqual({ x: 5, y: 7, width: 30, height: 10 });
      expect(page.addedText).toHaveLength(3);
    });
  });

  describe('2. Export payload', () => {
    it('sends exactly the render plan, full-resolution working image and export options', async () => {
      const mockExport = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/export_1.png',
        format: 'png',
        fileSizeBytes: 123,
        width: 4000,
        height: 3000,
        savedToGallery: false,
      });
      (NativeModules as any).ImageProcessingModule = { exportImagePage: mockExport };

      const doc = createDoc();
      const engine = new ImageExportEngine();
      const result = await engine.exportDocument(doc, { format: 'png' });

      const params = mockExport.mock.calls[0][0];
      // Full-resolution working image, never the display preview
      expect(params.sourceImageUri).toBe('file:///app/pie/documents/doc-exp/assets/working.jpg');
      expect(params.destination).toBe('file');
      expect(params.maxPixels).toBe(MAX_EXPORT_PIXELS);
      expect(params.displayName).toBe('Holiday_Photo_final');

      const plan = buildImageRenderPlan(doc.pages[0]);
      expect(params.patches).toEqual(plan.patches.map((p) => ({ patchUri: p.patchUri, bounds: p.bounds })));
      expect(params.textElements).toEqual(
        plan.textElements.map((t) => ({
          text: t.text,
          bounds: t.bounds,
          fittedFontSize: t.fittedFontSize,
          baselineY: t.baselineY,
          drawX: t.drawX,
          color: t.color,
          fontWeight: t.fontWeight,
          fontStyle: t.fontStyle,
          fontFamily: t.fontFamily,
          // Phase 14: the planned lines are sent as-is (multi-line parity with the canvas)
          lines: t.lines.map((l) => ({ text: l.text, x: l.x, baselineY: l.baselineY })),
        })),
      );
      // No viewport/selection state ever reaches the exporter
      expect(JSON.stringify(params)).not.toContain('translateX');
      expect(JSON.stringify(params)).not.toContain('selected');

      expect(result.width).toBe(4000);
      expect(result.savedToGallery).toBe(false);
    });

    it('requests gallery publishing and reports the gallery result', async () => {
      const mockExport = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/export_2.jpg',
        format: 'jpeg',
        fileSizeBytes: 456,
        savedToGallery: true,
        galleryUri: 'content://media/external_primary/images/media/99',
      });
      (NativeModules as any).ImageProcessingModule = { exportImagePage: mockExport };

      const result = await new ImageExportEngine().exportDocument(createDoc(), {
        format: 'jpeg',
        quality: 92,
        destination: 'gallery',
      });

      expect(mockExport.mock.calls[0][0].destination).toBe('gallery');
      expect(mockExport.mock.calls[0][0].quality).toBe(92);
      expect(result.savedToGallery).toBe(true);
      expect(result.galleryUri).toBe('content://media/external_primary/images/media/99');
      expect(result.destinationUri).toBe('file:///cache/exports/export_2.jpg');
    });

    it('reports savedToGallery=false when the platform cannot publish to the gallery', async () => {
      (NativeModules as any).ImageProcessingModule = {
        exportImagePage: jest.fn().mockResolvedValue({
          destinationUri: 'file:///cache/exports/export_3.png',
          format: 'png',
          fileSizeBytes: 1,
          savedToGallery: false,
        }),
      };
      const result = await new ImageExportEngine().exportDocument(createDoc(), {
        format: 'png',
        destination: 'gallery',
      });
      expect(result.savedToGallery).toBe(false);
      expect(result.galleryUri).toBeUndefined();
    });

    it('does not mutate the document being exported', async () => {
      (NativeModules as any).ImageProcessingModule = {
        exportImagePage: jest.fn().mockResolvedValue({
          destinationUri: 'file:///cache/exports/x.png',
          format: 'png',
          fileSizeBytes: 1,
        }),
      };
      const doc = createDoc();
      const snapshot = JSON.stringify(doc);
      await new ImageExportEngine().exportDocument(doc, { format: 'png' });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  describe('3. Failure handling and honest fallbacks', () => {
    it('wraps native failures (e.g. out of memory) in ExportError and allows a retry', async () => {
      const mockExport = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Not enough memory'), { code: 'EXPORT_OUT_OF_MEMORY' }))
        .mockResolvedValueOnce({ destinationUri: 'file:///cache/exports/retry.png', format: 'png', fileSizeBytes: 1 });
      (NativeModules as any).ImageProcessingModule = { exportImagePage: mockExport };

      const engine = new ImageExportEngine();
      await expect(engine.exportDocument(createDoc(), { format: 'png' })).rejects.toBeInstanceOf(ExportError);
      const retry = await engine.exportDocument(createDoc(), { format: 'png' });
      expect(retry.destinationUri).toBe('file:///cache/exports/retry.png');
    });

    it('never simulates an export outside the test environment', async () => {
      process.env.NODE_ENV = 'production';
      const engine = new ImageExportEngine();
      await expect(engine.exportDocument(createDoc(), { format: 'png' })).rejects.toBeInstanceOf(
        ImageExportUnavailableError,
      );
      await expect(
        engine.shareExportedFile('file:///cache/exports/x.png', 'png'),
      ).rejects.toBeInstanceOf(ImageExportUnavailableError);
    });

    it('still simulates inside Jest (keeps existing regression tests deterministic)', async () => {
      const result = await new ImageExportEngine().exportDocument(createDoc(), { format: 'jpeg' });
      expect(result.destinationUri).toMatch(/^file:\/\/\/simulated\/exports\/export_\d+\.jpg$/);
      expect(result.savedToGallery).toBe(false);
    });

    it('ImageExportUnavailableError is an ExportError', () => {
      expect(new ImageExportUnavailableError('x')).toBeInstanceOf(ExportError);
    });
  });
});
