import { ImageExportEngine } from '../src/features/export/imageExportEngine';
import { Document } from '../src/types/document';
import { ExportError } from '../src/errors';
import { NativeModules } from 'react-native';

const createExportTestDocument = (overrides?: Partial<Document>): Document => ({
  id: 'doc-export-test',
  metadata: {
    id: 'doc-export-test',
    title: 'Export Test Image',
    kind: 'image',
    sourceUri: 'file:///data/original_2400x1800.png',
    pageCount: 1,
    createdAt: 1000,
    updatedAt: 1000,
  },
  pages: [
    {
      id: 'page-1',
      pageIndex: 0,
      dimensions: { width: 2400, height: 1800 },
      rotation: 0,
      originalContent: {
        pageIndex: 0,
        assetUri: 'file:///data/original_2400x1800.png',
        width: 2400,
        height: 1800,
      },
      editableTextRegions: [
        {
          id: 'region-unmodified',
          pageIndex: 0,
          bounds: { x: 100, y: 100, width: 400, height: 80 },
          originalText: 'Unmodified Text',
          currentText: 'Unmodified Text',
          status: 'detected',
          style: { fontSize: 40, color: '#000000' },
        },
        {
          id: 'region-modified-1',
          pageIndex: 0,
          bounds: { x: 600, y: 300, width: 500, height: 100 },
          originalText: 'Old Headline',
          currentText: 'New Replaced Headline',
          status: 'modified',
          style: { fontSize: 50, color: '#2563EB', fontWeight: 'bold' },
          reconstructedPatchUri: 'file:///cache/patch_1.png',
          reconstructedPatchBounds: { x: 595, y: 295, width: 510, height: 110 },
        },
      ],
      addedText: [],
    },
  ],
  ...overrides,
});

describe('Phase 2C: High-Quality Image Export', () => {
  let exportEngine: ImageExportEngine;

  beforeEach(() => {
    exportEngine = new ImageExportEngine();
    jest.clearAllMocks();
  });

  describe('Resolution & Coordinate Preservation', () => {
    it('passes exact intrinsic document dimensions and 1:1 coordinates without viewport scaling', async () => {
      const mockExportPage = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/export_test.png',
        format: 'png',
        fileSizeBytes: 2048500,
        width: 2400,
        height: 1800,
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: mockExportPage,
        shareFile: jest.fn().mockResolvedValue(true),
      };

      const doc = createExportTestDocument();
      const result = await exportEngine.exportDocument(doc, { format: 'png' });

      expect(mockExportPage).toHaveBeenCalledTimes(1);
      const params = mockExportPage.mock.calls[0][0];

      // Verify original source image is passed
      expect(params.sourceImageUri).toBe('file:///data/original_2400x1800.png');

      // Verify layer compositing: only modified patches are passed to layer 2
      expect(params.patches).toHaveLength(1);
      expect(params.patches[0].patchUri).toBe('file:///cache/patch_1.png');
      expect(params.patches[0].bounds).toEqual({
        x: 595,
        y: 295,
        width: 510,
        height: 110,
      });

      // Verify replacement text layer: text element coordinates are in 1:1 document space
      expect(params.textElements).toHaveLength(1);
      expect(params.textElements[0].text).toBe('New Replaced Headline');
      expect(params.textElements[0].bounds).toEqual({
        x: 600,
        y: 300,
        width: 500,
        height: 100,
      });
      expect(params.textElements[0].color).toBe('#2563EB');
      expect(params.textElements[0].fontWeight).toBe('bold');

      // Verify output result
      expect(result.destinationUri).toBe('file:///cache/exports/export_test.png');
      expect(result.format).toBe('png');
      expect(result.fileSizeBytes).toBe(2048500);
    });
  });

  describe('Format and Quality Options', () => {
    it('supports lossless PNG export with default 100% quality', async () => {
      const mockExportPage = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/export_test.png',
        format: 'png',
        fileSizeBytes: 3000000,
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: mockExportPage,
      };

      const doc = createExportTestDocument();
      await exportEngine.exportDocument(doc, { format: 'png' });

      const params = mockExportPage.mock.calls[0][0];
      expect(params.format).toBe('png');
      expect(params.quality).toBe(100);
    });

    it('supports JPEG export and clamps quality within 1-100', async () => {
      const mockExportPage = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/export_test.jpg',
        format: 'jpeg',
        fileSizeBytes: 850000,
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: mockExportPage,
      };

      const doc = createExportTestDocument();
      await exportEngine.exportDocument(doc, { format: 'jpeg', quality: 92 });

      const params = mockExportPage.mock.calls[0][0];
      expect(params.format).toBe('jpeg');
      expect(params.quality).toBe(92);
    });
  });

  describe('Export Error Handling', () => {
    it('throws ExportError if document kind is not image', async () => {
      const pdfDoc = createExportTestDocument({
        metadata: {
          id: 'pdf-1',
          title: 'PDF Document',
          kind: 'pdf',
          sourceUri: 'file:///test.pdf',
          pageCount: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      });

      await expect(
        exportEngine.exportDocument(pdfDoc, { format: 'png' }),
      ).rejects.toThrow(ExportError);
    });

    it('throws ExportError if page assetUri is missing', async () => {
      const missingUriDoc = createExportTestDocument({
        pages: [
          {
            id: 'p-1',
            pageIndex: 0,
            dimensions: { width: 500, height: 500 },
            rotation: 0,
            originalContent: { pageIndex: 0, width: 500, height: 500 },
            editableTextRegions: [],
            addedText: [],
          },
        ],
      });

      await expect(
        exportEngine.exportDocument(missingUriDoc, { format: 'png' }),
      ).rejects.toThrow('Source image asset URI is missing');
    });

    it('throws ExportError if unsupported format is requested', async () => {
      const doc = createExportTestDocument();
      await expect(
        // @ts-expect-error test invalid format at runtime
        exportEngine.exportDocument(doc, { format: 'tiff' }),
      ).rejects.toThrow('Unsupported export format');
    });

    it('wraps native bridge failure in ExportError', async () => {
      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockRejectedValue(new Error('Out of memory')),
      };

      const doc = createExportTestDocument();
      await expect(
        exportEngine.exportDocument(doc, { format: 'png' }),
      ).rejects.toThrow(ExportError);
    });
  });

  describe('Native Share Integration', () => {
    it('invokes native shareFile with correct MIME type', async () => {
      const mockShare = jest.fn().mockResolvedValue(true);
      NativeModules.ImageProcessingModule = {
        shareFile: mockShare,
      };

      const success = await exportEngine.shareExportedFile(
        'file:///cache/exports/exported.png',
        'png',
        'Share Title',
      );

      expect(success).toBe(true);
      expect(mockShare).toHaveBeenCalledWith(
        'file:///cache/exports/exported.png',
        'image/png',
        'Share Title',
      );
    });
  });
});
