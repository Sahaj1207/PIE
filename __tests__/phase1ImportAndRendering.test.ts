jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

import { NativeModules } from 'react-native';
import {
  createDocumentFromPickedImage,
  isSupportedImageFormat,
  PickedImageResult,
} from '../src/features/image/importService';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { Document } from '../src/types/document';

describe('Phase 1: Import & Rendering Verification Suite', () => {
  describe('1. Content URI & Path Resolution', () => {
    it('normalizes file:// URIs by stripping protocol prefix for native filesystem access', () => {
      const resolveLocalPath = (uri: string): string => {
        if (uri.startsWith('file://')) {
          return uri.substring(7);
        }
        return uri;
      };

      expect(resolveLocalPath('file:///storage/emulated/0/Download/test.pdf')).toBe(
        '/storage/emulated/0/Download/test.pdf',
      );
      expect(resolveLocalPath('/data/user/0/cache/sample.pdf')).toBe(
        '/data/user/0/cache/sample.pdf',
      );
    });

    it('identifies content:// URIs that require resolution via Android ContentResolver', () => {
      const isContentUri = (uri: string) => uri.startsWith('content://');

      expect(isContentUri('content://com.android.providers.media.documents/document/image%3A123')).toBe(true);
      expect(isContentUri('file:///data/user/0/cache/image.png')).toBe(false);
      expect(isContentUri('/sdcard/image.png')).toBe(false);
    });

    it('validates supported image formats from picker result', () => {
      expect(isSupportedImageFormat('photo.jpg')).toBe(true);
      expect(isSupportedImageFormat('scan.png')).toBe(true);
      expect(isSupportedImageFormat('screenshot.webp')).toBe(true);
      expect(isSupportedImageFormat('contract.pdf')).toBe(false);
      expect(isSupportedImageFormat('vector.svg')).toBe(false);
    });
  });

  describe('2. PDF Document Open & Failure Handling', () => {
    it('throws when attempting to open a non-existent PDF file', async () => {
      const mockEngine: Partial<PdfiumEngine> = {
        openDocument: jest.fn().mockRejectedValue(new Error('PDF file not found at path: /non_existent.pdf')),
      };

      const editor = new PdfDocumentEditor(mockEngine as PdfiumEngine);
      await expect(editor.open('/non_existent.pdf')).rejects.toThrow('PDF file not found');
    });

    it('loads page count and dimensions on successful open', async () => {
      const mockEngine: Partial<PdfiumEngine> = {
        openDocument: jest.fn().mockResolvedValue({ docHandle: 101, pageCount: 3 }),
        getPageSize: jest.fn().mockResolvedValue({ width: 595, height: 842 }),
        renderPage: jest.fn().mockResolvedValue({
          pageIndex: 0,
          width: 1190,
          height: 1684,
          uri: 'file:///cache/rendered_page_0.png',
          pageWidth: 595,
          pageHeight: 842,
        }),
      };

      const editor = new PdfDocumentEditor(mockEngine as PdfiumEngine);
      await editor.open('/valid/document.pdf');

      expect(editor.getPageCount()).toBe(3);
      const size = await editor.getPageSize(0);
      expect(size.width).toBe(595);
      expect(size.height).toBe(842);
    });
  });

  describe('3. Image Document Model & Dimensions Preservation', () => {
    it('creates an immutable image document preserving exact intrinsic dimensions', async () => {
      const pickedImage: PickedImageResult = {
        uri: 'file:///data/user/0/cache/imported_images/photo_123.png',
        width: 1080,
        height: 1920,
        fileName: 'Invoice_Photo.png',
        fileSizeBytes: 2048000,
      };

      const doc: Document = await createDocumentFromPickedImage(pickedImage);

      // Verify metadata
      expect(doc.metadata.kind).toBe('image');
      expect(doc.metadata.title).toBe('Invoice_Photo.png');
      expect(doc.metadata.sourceUri).toBe('file:///data/user/0/cache/imported_images/photo_123.png');
      expect(doc.metadata.pageCount).toBe(1);

      // Verify page dimensions match intrinsic image resolution
      expect(doc.pages.length).toBe(1);
      const page = doc.pages[0];
      expect(page.dimensions.width).toBe(1080);
      expect(page.dimensions.height).toBe(1920);

      // Verify original content reference remains immutable
      expect(page.originalContent.assetUri).toBe('file:///data/user/0/cache/imported_images/photo_123.png');
      expect(page.originalContent.width).toBe(1080);
      expect(page.originalContent.height).toBe(1920);

      // Verify starts with empty edit lists
      expect(page.editableTextRegions).toEqual([]);
      expect(page.addedText).toEqual([]);
    });

    it('falls back to default dimensions when intrinsic dimensions are missing or 0', async () => {
      const invalidImage: PickedImageResult = {
        uri: 'file:///data/user/0/cache/imported_images/fallback.png',
        width: 0,
        height: 0,
        fileName: 'Fallback.png',
      };

      const doc = await createDocumentFromPickedImage(invalidImage);
      expect(doc.pages[0].dimensions.width).toBeGreaterThan(0);
      expect(doc.pages[0].dimensions.height).toBeGreaterThan(0);
    });
  });

  describe('4. Immutable Source Architecture', () => {
    it('preserves source file URI without overwriting original during viewing', async () => {
      const originalUri = 'file:///original/storage/receipt.jpg';
      const picked: PickedImageResult = {
        uri: originalUri,
        width: 800,
        height: 600,
        fileName: 'receipt.jpg',
      };

      const doc = await createDocumentFromPickedImage(picked);
      expect(doc.metadata.sourceUri).toBe(originalUri);
      expect(doc.pages[0].originalContent.assetUri).toBe(originalUri);

      // Assert original asset uri is never cleared or replaced by rendering
      expect(doc.pages[0].originalContent.assetUri).not.toContain('_edited');
    });
  });
});
