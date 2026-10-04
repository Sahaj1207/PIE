import {
  AppError,
  UnsupportedDocumentError,
  CorruptedDocumentError,
  UnsupportedPdfFeatureError,
  OcrProcessingError,
  ExportError,
  InsufficientStorageError,
  PermissionError,
  NotImplementedError,
} from '../src/errors';

describe('Domain Error Hierarchy', () => {
  test('UnsupportedDocumentError has correct code and inheritance', () => {
    const error = new UnsupportedDocumentError('Document format not supported');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(UnsupportedDocumentError);
    expect(error.code).toBe('UNSUPPORTED_DOCUMENT');
    expect(error.message).toBe('Document format not supported');
  });

  test('CorruptedDocumentError retains underlying cause', () => {
    const cause = new Error('EOF reached unexpectedly');
    const error = new CorruptedDocumentError('File is corrupted', cause);
    expect(error.code).toBe('CORRUPTED_DOCUMENT');
    expect(error.cause).toBe(cause);
  });

  test('NotImplementedError formats feature message clearly', () => {
    const error = new NotImplementedError('Neural Inpainting');
    expect(error.code).toBe('NOT_IMPLEMENTED');
    expect(error.message).toContain('Neural Inpainting is not yet implemented');
  });

  test('Other specific errors instantiate with expected codes', () => {
    expect(new UnsupportedPdfFeatureError('XFA Forms').code).toBe(
      'UNSUPPORTED_PDF_FEATURE',
    );
    expect(new OcrProcessingError('OCR Failed').code).toBe(
      'OCR_PROCESSING_FAILED',
    );
    expect(new ExportError('Render failed').code).toBe('EXPORT_FAILED');
    expect(new InsufficientStorageError('Disk full').code).toBe(
      'INSUFFICIENT_STORAGE',
    );
    expect(new PermissionError('Read denied').code).toBe('PERMISSION_DENIED');
  });
});
