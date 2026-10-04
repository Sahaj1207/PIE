import { NativeModules } from 'react-native';
import {
  PdfiumEngine,
  documentToPdfBounds,
  documentToScreenRect,
  hitTestTextObjects,
  pdfToDocumentRect,
  screenToDocumentPoint,
} from '../src/features/pdf/pdfiumEngine';
import {
  PdfCorruptedError,
  PdfEngineNotLinkedError,
  PdfFileNotFoundError,
  PdfPageOutOfRangeError,
  PdfPasswordRequiredError,
  PdfRenderError,
  PdfTextExtractionError,
  PdfTextReplacementError,
  PdfBatchEditError,
  PdfInvalidObjectIdError,
  PdfDeletedObjectEditError,
  PdfInvalidReplacementError,
} from '../src/errors';
import {
  PdfTextObject,
  PdfTextReplacementRequest,
  PdfBatchEditRequest,
  PdfMultiEditResult,
} from '../src/features/pdf/types';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';

describe('PDF Coordinate System Normalization', () => {
  const pageHeight = 792; // Standard Letter height in points

  test('converts top-of-page PDF coordinates to top-left document coordinates', () => {
    // A header near the top of the page in PDF user space (origin bottom-left, Y upward)
    const rawPdf = {
      left: 54,
      bottom: 740,
      right: 250,
      top: 760,
    };

    const docRect = pdfToDocumentRect(rawPdf, pageHeight);

    expect(docRect.x).toBe(54);
    expect(docRect.y).toBe(pageHeight - 760); // 32 pt from top of page
    expect(docRect.width).toBe(196);
    expect(docRect.height).toBe(20);
  });

  test('converts bottom-of-page PDF coordinates to top-left document coordinates', () => {
    // A footer near the bottom of the page in PDF user space
    const rawPdf = {
      left: 54,
      bottom: 30,
      right: 200,
      top: 50,
    };

    const docRect = pdfToDocumentRect(rawPdf, pageHeight);

    expect(docRect.x).toBe(54);
    expect(docRect.y).toBe(pageHeight - 50); // 742 pt from top of page
    expect(docRect.width).toBe(146);
    expect(docRect.height).toBe(20);
  });

  test('round-trips document rectangle back to PDF coordinates accurately', () => {
    const rawPdf = {
      left: 72,
      bottom: 300,
      right: 300,
      top: 350,
    };

    const docRect = pdfToDocumentRect(rawPdf, pageHeight);
    const roundTrip = documentToPdfBounds(docRect, pageHeight);

    expect(roundTrip.left).toBeCloseTo(rawPdf.left);
    expect(roundTrip.bottom).toBeCloseTo(rawPdf.bottom);
    expect(roundTrip.right).toBeCloseTo(rawPdf.right);
    expect(roundTrip.top).toBeCloseTo(rawPdf.top);
  });

  test('handles inverted PDF bounding box coordinates gracefully', () => {
    // Inverted bounds where left > right or bottom > top
    const invertedPdf = {
      left: 200,
      bottom: 500,
      right: 100,
      top: 400,
    };

    const docRect = pdfToDocumentRect(invertedPdf, pageHeight);

    expect(docRect.x).toBe(100);
    expect(docRect.width).toBe(100);
    expect(docRect.y).toBe(pageHeight - 500);
    expect(docRect.height).toBe(100);
  });
});

describe('Document to Screen Geometry Transformations', () => {
  const docRect = { x: 50, y: 100, width: 200, height: 40 };

  test('scales document rect to screen rect at 1.5x zoom', () => {
    const screenRect = documentToScreenRect(docRect, 1.5, 1.5);

    expect(screenRect).toEqual({
      x: 75,
      y: 150,
      width: 300,
      height: 60,
    });
  });

  test('converts screen point back to document point accurately', () => {
    const screenPoint = { x: 75, y: 150 };
    const docPoint = screenToDocumentPoint(screenPoint.x, screenPoint.y, 1.5, 1.5);

    expect(docPoint).toEqual({
      x: 50,
      y: 100,
    });
  });
});

describe('Vector Text Hit Testing', () => {
  const sampleObjects: PdfTextObject[] = [
    {
      id: 'p0_obj0',
      pageIndex: 0,
      objectIndex: 0,
      text: 'Title Text',
      bounds: { x: 50, y: 50, width: 200, height: 30 },
      pdfBounds: { left: 50, bottom: 712, right: 250, top: 742 },
      fontSize: 24,
      fontName: 'Helvetica-Bold',
      color: '#000000',
      colorRgba: { r: 0, g: 0, b: 0, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 50 },
      isEditable: true,
    },
    {
      id: 'p0_obj1',
      pageIndex: 0,
      objectIndex: 1,
      text: 'Body Paragraph Text',
      bounds: { x: 50, y: 120, width: 400, height: 80 },
      pdfBounds: { left: 50, bottom: 592, right: 450, top: 672 },
      fontSize: 12,
      fontName: 'Times-Roman',
      color: '#333333',
      colorRgba: { r: 51, g: 51, b: 51, a: 255 },
      matrix: null,
      isEditable: true,
    },
  ];

  test('detects click directly inside first text object', () => {
    const hit = hitTestTextObjects(sampleObjects, { x: 100, y: 65 });
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe('p0_obj0');
    expect(hit?.text).toBe('Title Text');
  });

  test('detects click directly inside second text object', () => {
    const hit = hitTestTextObjects(sampleObjects, { x: 200, y: 150 });
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe('p0_obj1');
    expect(hit?.text).toBe('Body Paragraph Text');
  });

  test('returns null when click is in empty margin', () => {
    const hit = hitTestTextObjects(sampleObjects, { x: 500, y: 500 });
    expect(hit).toBeNull();
  });

  test('detects click near edge with hit padding tolerance', () => {
    // 2 pt above bounds.y (48 vs 50)
    const hit = hitTestTextObjects(sampleObjects, { x: 60, y: 48 }, 4);
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe('p0_obj0');
  });
});

describe('PdfiumEngine Service Layer', () => {
  let engine: PdfiumEngine;

  beforeEach(() => {
    engine = new PdfiumEngine();
    jest.clearAllMocks();
  });

  test('throws PdfEngineNotLinkedError if native module is missing', async () => {
    const originalModule = NativeModules.PdfiumNativeModule;
    delete NativeModules.PdfiumNativeModule;

    await expect(engine.openDocument('/path/to/doc.pdf')).rejects.toThrow(
      PdfEngineNotLinkedError,
    );

    NativeModules.PdfiumNativeModule = originalModule;
  });

  test('throws PdfFileNotFoundError when given empty file path', async () => {
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn(),
    };

    await expect(engine.openDocument('')).rejects.toThrow(PdfFileNotFoundError);
    expect(NativeModules.PdfiumNativeModule.openDocument).not.toHaveBeenCalled();
  });

  test('opens valid PDF and returns document handle and page count', async () => {
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockResolvedValue({
        docHandle: 42,
        pageCount: 3,
        filePath: '/data/sample.pdf',
      }),
    };

    const handle = await engine.openDocument('/data/sample.pdf');
    expect(handle).toEqual({
      docHandle: 42,
      pageCount: 3,
      filePath: '/data/sample.pdf',
    });
  });

  test('maps native PDF_FILE_NOT_FOUND error to PdfFileNotFoundError', async () => {
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockRejectedValue({
        code: 'PDF_FILE_NOT_FOUND',
        message: 'File not found at /missing.pdf',
      }),
    };

    await expect(engine.openDocument('/missing.pdf')).rejects.toThrow(PdfFileNotFoundError);
  });

  test('maps native PDF_FORMAT_CORRUPT error to PdfCorruptedError', async () => {
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockRejectedValue({
        code: 'PDF_FORMAT_CORRUPT',
        message: 'Corrupted or invalid PDF format',
      }),
    };

    await expect(engine.openDocument('/corrupt.pdf')).rejects.toThrow(PdfCorruptedError);
  });

  test('maps native PDF_PASSWORD_REQUIRED error to PdfPasswordRequiredError', async () => {
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockRejectedValue({
        code: 'PDF_PASSWORD_REQUIRED',
        message: 'Password required',
      }),
    };

    await expect(engine.openDocument('/locked.pdf')).rejects.toThrow(PdfPasswordRequiredError);
  });

  test('closes document via native handle', async () => {
    NativeModules.PdfiumNativeModule = {
      closeDocument: jest.fn().mockResolvedValue(true),
    };

    const result = await engine.closeDocument(42);
    expect(result).toBe(true);
    expect(NativeModules.PdfiumNativeModule.closeDocument).toHaveBeenCalledWith(42);
  });

  test('gets page size with pageIndex and point dimensions', async () => {
    NativeModules.PdfiumNativeModule = {
      getPageSize: jest.fn().mockResolvedValue({
        pageIndex: 0,
        width: 612,
        height: 792,
      }),
    };

    const size = await engine.getPageSize(42, 0);
    expect(size).toEqual({
      pageIndex: 0,
      width: 612,
      height: 792,
    });
  });

  test('rejects negative pageIndex for getPageSize', async () => {
    NativeModules.PdfiumNativeModule = {
      getPageSize: jest.fn(),
    };

    await expect(engine.getPageSize(42, -1)).rejects.toThrow(PdfPageOutOfRangeError);
  });

  test('renders page and returns dimensions, scale, and cached image URI', async () => {
    NativeModules.PdfiumNativeModule = {
      renderPage: jest.fn().mockResolvedValue({
        filePath: '/cache/page_0.png',
        uri: 'file:///cache/page_0.png',
        width: 918,
        height: 1188,
        pageWidth: 612,
        pageHeight: 792,
        scale: 1.5,
        pageIndex: 0,
      }),
    };

    const rendered = await engine.renderPage(42, 0, { scale: 1.5 });
    expect(rendered.uri).toBe('file:///cache/page_0.png');
    expect(rendered.width).toBe(918);
    expect(rendered.height).toBe(1188);
    expect(rendered.scale).toBe(1.5);
  });

  test('extracts vector text objects and preserves null for unavailable metadata', async () => {
    const mockJson = JSON.stringify([
      {
        id: 'p0_obj0',
        pageIndex: 0,
        objectIndex: 0,
        text: 'Header Text',
        bounds: { x: 54, y: 32, width: 200, height: 24 },
        pdfBounds: { left: 54, bottom: 736, right: 254, top: 760 },
        fontSize: 18,
        fontName: 'Helvetica',
        color: '#111827',
        colorRgba: { r: 17, g: 24, b: 39, a: 255 },
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 54, f: 32 },
      },
      {
        id: 'p0_obj1',
        pageIndex: 0,
        objectIndex: 1,
        text: 'Minimal Metadata Text',
        bounds: { x: 54, y: 100, width: 150, height: 16 },
        pdfBounds: { left: 54, bottom: 676, right: 204, top: 692 },
        fontSize: null,
        fontName: null,
        color: null,
        colorRgba: null,
        matrix: null,
      },
    ]);

    NativeModules.PdfiumNativeModule = {
      getTextObjects: jest.fn().mockResolvedValue(mockJson),
    };

    const objects = await engine.getTextObjects(42, 0);
    expect(objects).toHaveLength(2);

    // Object with full metadata
    expect(objects[0].id).toBe('p0_obj0');
    expect(objects[0].text).toBe('Header Text');
    expect(objects[0].fontName).toBe('Helvetica');
    expect(objects[0].fontSize).toBe(18);
    expect(objects[0].color).toBe('#111827');
    expect(objects[0].matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 54, f: 32 });

    // Object with unavailable metadata returns null, not invented values
    expect(objects[1].id).toBe('p0_obj1');
    expect(objects[1].text).toBe('Minimal Metadata Text');
    expect(objects[1].fontName).toBeNull();
    expect(objects[1].fontSize).toBeNull();
    expect(objects[1].color).toBeNull();
    expect(objects[1].matrix).toBeNull();
  });

  test('maps native PDF_TEXT_EXTRACTION_ERROR to PdfTextExtractionError', async () => {
    NativeModules.PdfiumNativeModule = {
      getTextObjects: jest.fn().mockRejectedValue({
        code: 'PDF_TEXT_EXTRACTION_ERROR',
        message: 'Native failure reading page objects',
      }),
    };

    await expect(engine.getTextObjects(42, 0)).rejects.toThrow(PdfTextExtractionError);
  });

  test('extracts bundled test asset PDF', async () => {
    NativeModules.PdfiumNativeModule = {
      extractAssetPdf: jest.fn().mockResolvedValue('/data/pdfium_spike_sample.pdf'),
    };

    const path = await engine.extractAssetPdf('pdfium_spike_sample.pdf');
    expect(path).toBe('/data/pdfium_spike_sample.pdf');
    expect(NativeModules.PdfiumNativeModule.extractAssetPdf).toHaveBeenCalledWith(
      'pdfium_spike_sample.pdf',
    );
  });
});

describe('PdfiumEngine Text Replacement Spike (Phase 3B-A)', () => {
  let engine: PdfiumEngine;

  const validRequest: PdfTextReplacementRequest = {
    inputPdfPath: '/data/user/0/com.pdfimageeditor/files/pdfium_spike_sample.pdf',
    outputPdfPath: '/data/user/0/com.pdfimageeditor/files/pdfium_replacement_test.pdf',
    pageIndex: 0,
    objectIndex: 0,
    replacementText: 'PDFium Replacement Test',
  };

  const mockSuccessJson = JSON.stringify({
    outputPath: '/data/user/0/com.pdfimageeditor/files/pdfium_replacement_test.pdf',
    pageIndex: 0,
    objectIndex: 0,
    oldText: 'PDFium Native Spike',
    newText: 'PDFium Replacement Test',
    replacementFound: true,
    oldTextStillPresent: false,
    pageCountBefore: 2,
    pageCountAfter: 2,
    sourceUnchanged: true,
    sourceChecksumBefore: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    sourceChecksumAfter: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    fontReused: true,
    fontStrategy: 'REUSED_ORIGINAL',
    originalFont: {
      baseFontName: 'Helvetica-Bold',
      familyName: 'Helvetica',
      isEmbedded: false,
      isSubset: false,
      weight: 700,
      flags: 32,
    },
    reopenedFont: {
      baseFontName: 'Helvetica-Bold',
      familyName: 'Helvetica',
      isEmbedded: false,
      isSubset: false,
      weight: 700,
      flags: 32,
    },
    preservedProperties: {
      bounds: { x: 54, y: 54, width: 232, height: 28 },
      pdfBounds: { left: 54, bottom: 710, right: 286, top: 738 },
      fontSize: 24,
      fontName: 'Helvetica-Bold',
      fontResourceReused: true,
      fontStrategy: 'REUSED_ORIGINAL',
      color: '#1E293B',
      colorRgba: { r: 30, g: 41, b: 59, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 54, f: 54 },
    },
    limitations: [
      'Original font resource (Helvetica-Bold) successfully preserved and reused in-place. Embedded: false, Subset: false.',
    ],
  });

  beforeEach(() => {
    engine = new PdfiumEngine();
    jest.clearAllMocks();
  });

  test('correctly forms and executes a valid replacement request', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockResolvedValue(mockSuccessJson),
    };

    const result = await engine.replaceTextObject(validRequest);

    expect(NativeModules.PdfiumNativeModule.replaceTextObject).toHaveBeenCalledWith(
      validRequest.inputPdfPath,
      validRequest.outputPdfPath,
      validRequest.pageIndex,
      validRequest.objectIndex,
      validRequest.replacementText,
    );
    expect(result.outputPath).toBe(validRequest.outputPdfPath);
    expect(result.oldText).toBe('PDFium Native Spike');
    expect(result.newText).toBe('PDFium Replacement Test');
  });

  test('rejects negative page index', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn(),
    };

    await expect(
      engine.replaceTextObject({ ...validRequest, pageIndex: -1 }),
    ).rejects.toThrow(PdfPageOutOfRangeError);
    expect(NativeModules.PdfiumNativeModule.replaceTextObject).not.toHaveBeenCalled();
  });

  test('rejects negative object index', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn(),
    };

    await expect(
      engine.replaceTextObject({ ...validRequest, objectIndex: -1 }),
    ).rejects.toThrow(PdfTextReplacementError);
    expect(NativeModules.PdfiumNativeModule.replaceTextObject).not.toHaveBeenCalled();
  });

  test('rejects empty or whitespace-only replacement text', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn(),
    };

    await expect(
      engine.replaceTextObject({ ...validRequest, replacementText: '' }),
    ).rejects.toThrow(PdfTextReplacementError);

    await expect(
      engine.replaceTextObject({ ...validRequest, replacementText: '   ' }),
    ).rejects.toThrow(PdfTextReplacementError);

    expect(NativeModules.PdfiumNativeModule.replaceTextObject).not.toHaveBeenCalled();
  });

  test('rejects identical input and output paths to guarantee source immutability', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn(),
    };

    await expect(
      engine.replaceTextObject({
        ...validRequest,
        outputPdfPath: validRequest.inputPdfPath,
      }),
    ).rejects.toThrow(PdfTextReplacementError);
    expect(NativeModules.PdfiumNativeModule.replaceTextObject).not.toHaveBeenCalled();
  });

  test('rejects empty input or output paths', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn(),
    };

    await expect(
      engine.replaceTextObject({ ...validRequest, inputPdfPath: '' }),
    ).rejects.toThrow(PdfFileNotFoundError);

    await expect(
      engine.replaceTextObject({ ...validRequest, outputPdfPath: '' }),
    ).rejects.toThrow(PdfTextReplacementError);

    expect(NativeModules.PdfiumNativeModule.replaceTextObject).not.toHaveBeenCalled();
  });

  test('parses and validates structured replacement result and preserved visual properties', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockResolvedValue(mockSuccessJson),
    };

    const result = await engine.replaceTextObject(validRequest);

    // Source immutability
    expect(result.sourceUnchanged).toBe(true);
    expect(result.sourceChecksumBefore).toBe(result.sourceChecksumAfter);

    // Page count preservation
    expect(result.pageCountBefore).toBe(2);
    expect(result.pageCountAfter).toBe(2);

    // Preserved properties
    expect(result.preservedProperties.fontSize).toBe(24);
    expect(result.preservedProperties.fontName).toBe('Helvetica-Bold');
    expect(result.preservedProperties.color).toBe('#1E293B');
    expect(result.preservedProperties.colorRgba).toEqual({ r: 30, g: 41, b: 59, a: 255 });
    expect(result.preservedProperties.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 54, f: 54 });
    expect(result.preservedProperties.bounds).toEqual({ x: 54, y: 54, width: 232, height: 28 });

    // Limitations documented
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).toContain('Helvetica-Bold');
  });

  test('verifies reopened document confirms replacement text exists and old text is absent', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockResolvedValue(mockSuccessJson),
    };

    const result = await engine.replaceTextObject(validRequest);

    expect(result.replacementFound).toBe(true);
    expect(result.oldTextStillPresent).toBe(false);
  });

  test('maps native PDF_TEXT_REPLACEMENT_ERROR to PdfTextReplacementError', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockRejectedValue({
        code: 'PDF_TEXT_REPLACEMENT_ERROR',
        message: 'Target object is not a text object (type 1)',
      }),
    };

    await expect(engine.replaceTextObject(validRequest)).rejects.toThrow(
      PdfTextReplacementError,
    );
  });

  test('identifies font metadata including base font, family, embedded status, and subset status', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockResolvedValue(mockSuccessJson),
    };

    const result = await engine.replaceTextObject(validRequest);

    expect(result.originalFont).not.toBeNull();
    expect(result.originalFont?.baseFontName).toBe('Helvetica-Bold');
    expect(result.originalFont?.familyName).toBe('Helvetica');
    expect(result.originalFont?.isEmbedded).toBe(false);
    expect(result.originalFont?.isSubset).toBe(false);
    expect(result.originalFont?.weight).toBe(700);
    expect(result.originalFont?.flags).toBe(32);
  });

  test('verifies original font resource reuse when replacement characters are compatible (Experiment A)', async () => {
    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockResolvedValue(mockSuccessJson),
    };

    const result = await engine.replaceTextObject({
      ...validRequest,
      replacementText: 'PDFium Vector Test',
    });

    // In-place reuse preserves exact original font resource
    expect(result.fontReused).toBe(true);
    expect(result.fontStrategy).toBe('REUSED_ORIGINAL');
    expect(result.reopenedFont?.baseFontName).toBe('Helvetica-Bold');
    expect(result.preservedProperties.fontResourceReused).toBe(true);
    expect(result.preservedProperties.fontStrategy).toBe('REUSED_ORIGINAL');
    expect(result.limitations[0]).toContain('successfully preserved and reused in-place');
  });

  test('reports subset font limitations accurately without fabricating support for missing glyphs (Experiment B)', async () => {
    const mockSubsetJson = JSON.stringify({
      outputPath: '/data/user/0/com.pdfimageeditor/files/subset_replacement_test.pdf',
      pageIndex: 0,
      objectIndex: 0,
      oldText: 'License Notice',
      newText: 'PDFium Replacement Test 123',
      replacementFound: true,
      oldTextStillPresent: false,
      pageCountBefore: 1,
      pageCountAfter: 1,
      sourceUnchanged: true,
      sourceChecksumBefore: 'abc',
      sourceChecksumAfter: 'abc',
      fontReused: false,
      fontStrategy: 'LOADED_STANDARD',
      originalFont: {
        baseFontName: 'AAAAAA+Archivo-Bold',
        familyName: 'Archivo',
        isEmbedded: true,
        isSubset: true,
        weight: 700,
        flags: 32,
      },
      reopenedFont: {
        baseFontName: 'Helvetica-Bold',
        familyName: 'Helvetica',
        isEmbedded: false,
        isSubset: false,
        weight: 700,
        flags: 32,
      },
      preservedProperties: {
        bounds: { x: 50, y: 50, width: 200, height: 20 },
        pdfBounds: { left: 50, bottom: 700, right: 250, top: 720 },
        fontSize: 16,
        fontName: 'Helvetica-Bold',
        fontResourceReused: false,
        fontStrategy: 'LOADED_STANDARD',
        color: '#000000',
        colorRgba: { r: 0, g: 0, b: 0, a: 255 },
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 50 },
      },
      limitations: [
        'Font could not be reused directly in-place (Strategy: LOADED_STANDARD). Used fallback font (Helvetica-Bold) while preserving font size, color, and affine transformation matrix.',
        'Original font is an embedded subset (AAAAAA+Archivo-Bold). Embedded subsets lack glyph outlines for characters not originally used; PDFium does not generate new glyph bezier curves for subset fonts.',
      ],
    });

    NativeModules.PdfiumNativeModule = {
      replaceTextObject: jest.fn().mockResolvedValue(mockSubsetJson),
    };

    const result = await engine.replaceTextObject({
      ...validRequest,
      replacementText: 'PDFium Replacement Test 123',
    });

    // Validates subset identification and limitation reporting
    expect(result.originalFont?.isSubset).toBe(true);
    expect(result.originalFont?.isEmbedded).toBe(true);
    expect(result.fontReused).toBe(false);
    expect(result.fontStrategy).toBe('LOADED_STANDARD');
    expect(result.limitations.some(l => l.includes('subset'))).toBe(true);
  });
});

describe('Phase 3C — PDFium Multi-Object Editing Engine', () => {
  let engine: PdfiumEngine;

  const mockPage0Objects = [
    {
      id: 'p0_obj0',
      pageIndex: 0,
      objectIndex: 0,
      text: 'PDFium Native Spike',
      bounds: { x: 54, y: 50, width: 300, height: 28 },
      pdfBounds: { left: 54, bottom: 714, right: 354, top: 742 },
      fontSize: 24,
      fontName: 'Helvetica-Bold',
      color: '#1E293B',
      colorRgba: { r: 30, g: 41, b: 59, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 54, f: 714 },
      isEditable: true,
    },
    {
      id: 'p0_obj1',
      pageIndex: 0,
      objectIndex: 1,
      text: 'Technical Proof of Concept',
      bounds: { x: 54, y: 90, width: 220, height: 16 },
      pdfBounds: { left: 54, bottom: 686, right: 274, top: 702 },
      fontSize: 14,
      fontName: 'Helvetica',
      color: '#475569',
      colorRgba: { r: 71, g: 85, b: 105, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 54, f: 686 },
      isEditable: true,
    },
    {
      id: 'p0_obj2',
      pageIndex: 0,
      objectIndex: 2,
      text: 'License Notice: Apache-2.0',
      bounds: { x: 54, y: 730, width: 180, height: 12 },
      pdfBounds: { left: 54, bottom: 50, right: 234, top: 62 },
      fontSize: 10,
      fontName: 'Helvetica',
      color: '#94A3B8',
      colorRgba: { r: 148, g: 163, b: 184, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 54, f: 50 },
      isEditable: true,
    },
  ];

  const mockBatchSuccessResult = {
    outputPath: '/data/user/0/com.pdfimageeditor/files/output.pdf',
    totalCommands: 3,
    appliedCommands: 3,
    pageCountBefore: 2,
    pageCountAfter: 2,
    sourceUnchanged: true,
    sourceChecksumBefore: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    sourceChecksumAfter: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    commands: [
      {
        type: 'replace',
        objectId: 'p0_obj0',
        pageIndex: 0,
        objectIndex: 0,
        status: 'applied',
        originalText: 'PDFium Native Spike',
        newText: 'Replaced Spike Title',
        fontReused: true,
        fontStrategy: 'IN_PLACE_FONT_REUSED',
      },
      {
        type: 'replace',
        objectId: 'p0_obj1',
        pageIndex: 0,
        objectIndex: 1,
        status: 'applied',
        originalText: 'Technical Proof of Concept',
        newText: 'Replaced Subtitle',
        fontReused: true,
        fontStrategy: 'IN_PLACE_FONT_REUSED',
      },
      {
        type: 'delete',
        objectId: 'p0_obj2',
        pageIndex: 0,
        objectIndex: 2,
        status: 'applied',
        originalText: 'License Notice: Apache-2.0',
      },
    ],
    reopenedVerification: {
      allReplacementsVerified: true,
      allDeletionsVerified: true,
      verifiedReplacements: ['Replaced Spike Title', 'Replaced Subtitle'],
      missingReplacements: [],
      residualDeletions: [],
    },
    limitations: [],
  };

  beforeEach(() => {
    engine = new PdfiumEngine();
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockResolvedValue({
        docHandle: 100,
        pageCount: 2,
        filePath: '/data/input.pdf',
      }),
      closeDocument: jest.fn().mockResolvedValue(true),
      getPageCount: jest.fn().mockResolvedValue(2),
      getTextObjects: jest.fn().mockResolvedValue(JSON.stringify(mockPage0Objects)),
      applyBatchEdits: jest.fn().mockResolvedValue(JSON.stringify(mockBatchSuccessResult)),
    };
  });

  afterEach(() => {
    delete NativeModules.PdfiumNativeModule;
  });

  test('1. Enumerate multiple text objects with complete metadata', async () => {
    const objects = await engine.getTextObjects(100, 0);
    expect(objects.length).toBe(3);
    expect(objects[0].text).toBe('PDFium Native Spike');
    expect(objects[0].fontSize).toBe(24);
    expect(objects[0].color).toBe('#1E293B');
    expect(objects[0].bounds).toBeDefined();
    expect(objects[0].pdfBounds).toBeDefined();
    expect(objects[0].matrix).toBeDefined();
    expect(objects[0].isEditable).toBe(true);
  });

  test('2. Stable object IDs derived from page and object indices', async () => {
    const objects = await engine.getTextObjects(100, 0);
    expect(objects[0].id).toBe('p0_obj0');
    expect(objects[1].id).toBe('p0_obj1');
    expect(objects[2].id).toBe('p0_obj2');
  });

  test('3, 4, 5, 6. Sequence of multiple edits (Replace A, Replace B, Delete C) before single save', async () => {
    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');

    const objs = await editor.getTextObjects(0);
    expect(objs.length).toBe(3);

    // Edit commands queued
    editor.replaceText('p0_obj0', 'Replaced Spike Title');
    editor.replaceText('p0_obj1', 'Replaced Subtitle');
    editor.deleteText('p0_obj2');

    const pending = editor.getPendingEdits();
    expect(pending.length).toBe(3);
    expect(pending[0]).toEqual({
      type: 'replace',
      objectId: 'p0_obj0',
      pageIndex: 0,
      objectIndex: 0,
      newText: 'Replaced Spike Title',
    });
    expect(pending[1]).toEqual({
      type: 'replace',
      objectId: 'p0_obj1',
      pageIndex: 0,
      objectIndex: 1,
      newText: 'Replaced Subtitle',
    });
    expect(pending[2]).toEqual({
      type: 'delete',
      objectId: 'p0_obj2',
      pageIndex: 0,
      objectIndex: 2,
    });

    // Save once
    const result = await editor.saveEdits('/data/output.pdf');

    expect(NativeModules.PdfiumNativeModule.applyBatchEdits).toHaveBeenCalledTimes(1);
    expect(editor.getPendingEdits().length).toBe(0); // cleared after save
    expect(result.appliedCommands).toBe(3);
  });

  test('7, 8, 9. Reopened PDF verification confirms replacements exist and deletions are absent', async () => {
    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');
    await editor.getTextObjects(0);

    editor.replaceText('p0_obj0', 'Replaced Spike Title');
    editor.deleteText('p0_obj2');

    const result = await editor.saveEdits('/data/output.pdf');

    expect(result.reopenedVerification.allReplacementsVerified).toBe(true);
    expect(result.reopenedVerification.verifiedReplacements).toContain('Replaced Spike Title');
    expect(result.reopenedVerification.allDeletionsVerified).toBe(true);
    expect(result.reopenedVerification.residualDeletions.length).toBe(0);
  });

  test('10. Verify unrelated text objects remain present in document', async () => {
    const customBatchResult = {
      ...mockBatchSuccessResult,
      commands: [
        {
          type: 'replace',
          objectId: 'p0_obj0',
          pageIndex: 0,
          objectIndex: 0,
          status: 'applied',
          originalText: 'PDFium Native Spike',
          newText: 'Replaced Spike Title',
        },
        {
          type: 'delete',
          objectId: 'p0_obj2',
          pageIndex: 0,
          objectIndex: 2,
          status: 'applied',
          originalText: 'License Notice: Apache-2.0',
        },
      ],
    };
    NativeModules.PdfiumNativeModule.applyBatchEdits = jest
      .fn()
      .mockResolvedValue(JSON.stringify(customBatchResult));

    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');
    const beforeObjs = await editor.getTextObjects(0);
    const untouchedBefore = beforeObjs.find((o) => o.id === 'p0_obj1');
    expect(untouchedBefore).toBeDefined();

    // Only edit obj0 and delete obj2; obj1 is untouched
    editor.replaceText('p0_obj0', 'Replaced Spike Title');
    editor.deleteText('p0_obj2');

    const result = await editor.saveEdits('/data/output.pdf');
    // Ensure p0_obj1 was never in command list
    expect(result.commands.find((c) => c.objectId === 'p0_obj1')).toBeUndefined();

    // In reopened document, mock that p0_obj1 remains intact
    NativeModules.PdfiumNativeModule.getTextObjects = jest.fn().mockResolvedValue(
      JSON.stringify([
        { ...mockPage0Objects[0], text: 'Replaced Spike Title' },
        mockPage0Objects[1], // p0_obj1 untouched
      ]),
    );

    const reopenedEditor = new PdfDocumentEditor(engine);
    await reopenedEditor.open('/data/output.pdf');
    const afterObjs = await reopenedEditor.getTextObjects(0);
    const untouchedAfter = afterObjs.find((o) => o.id === 'p0_obj1');
    expect(untouchedAfter).toBeDefined();
    expect(untouchedAfter?.text).toBe('Technical Proof of Concept');
  });

  test('11. Verify page count remains unchanged before and after batch edits', async () => {
    const result = await engine.applyBatchEdits({
      inputPdfPath: '/data/input.pdf',
      outputPdfPath: '/data/output.pdf',
      commands: [
        { type: 'delete', objectId: 'p0_obj2', pageIndex: 0, objectIndex: 2 },
      ],
    });

    expect(result.pageCountBefore).toBe(2);
    expect(result.pageCountAfter).toBe(2);
    expect(result.pageCountBefore).toEqual(result.pageCountAfter);
  });

  test('12. Verify source PDF SHA-256 immutability is preserved', async () => {
    const result = await engine.applyBatchEdits({
      inputPdfPath: '/data/input.pdf',
      outputPdfPath: '/data/output.pdf',
      commands: [
        { type: 'replace', objectId: 'p0_obj0', pageIndex: 0, objectIndex: 0, newText: 'Test' },
      ],
    });

    expect(result.sourceUnchanged).toBe(true);
    expect(result.sourceChecksumBefore).toBe(result.sourceChecksumAfter);
  });

  test('13. Reject unknown object ID with typed error', async () => {
    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');
    await editor.getTextObjects(0);

    expect(() => editor.replaceText('p0_obj999', 'New Text')).toThrow(PdfInvalidObjectIdError);
    expect(() => editor.deleteText('unknown_id')).toThrow(PdfInvalidObjectIdError);
  });

  test('14. Reject invalid page index with typed error', async () => {
    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');

    await expect(editor.getTextObjects(-1)).rejects.toThrow(PdfPageOutOfRangeError);
    await expect(editor.getTextObjects(99)).rejects.toThrow(PdfPageOutOfRangeError);
  });

  test('15. Reject invalid replacement (empty text and editing deleted object)', async () => {
    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');
    await editor.getTextObjects(0);

    // Empty replacement
    expect(() => editor.replaceText('p0_obj0', '')).toThrow(PdfInvalidReplacementError);
    expect(() => editor.replaceText('p0_obj0', '   ')).toThrow(PdfInvalidReplacementError);

    // Editing a deleted object
    editor.deleteText('p0_obj1');
    expect(() => editor.replaceText('p0_obj1', 'Should Fail')).toThrow(PdfDeletedObjectEditError);
    // Deleting already deleted object
    expect(() => editor.deleteText('p0_obj1')).toThrow(PdfDeletedObjectEditError);
  });

  test('16. Image object is not exposed as editable vector text', async () => {
    // Mock page with an image object (isEditable: false)
    NativeModules.PdfiumNativeModule.getTextObjects = jest.fn().mockResolvedValue(
      JSON.stringify([
        ...mockPage0Objects,
        {
          id: 'p0_obj3',
          pageIndex: 0,
          objectIndex: 3,
          text: '',
          bounds: { x: 100, y: 100, width: 200, height: 200 },
          pdfBounds: { left: 100, bottom: 500, right: 300, top: 700 },
          fontSize: null,
          fontName: null,
          color: null,
          colorRgba: null,
          matrix: null,
          isEditable: false,
        },
      ]),
    );

    const editor = new PdfDocumentEditor(engine);
    await editor.open('/data/input.pdf');
    const objects = await editor.getTextObjects(0);

    const imgObj = objects.find(o => o.id === 'p0_obj3');
    expect(imgObj).toBeDefined();
    expect(imgObj?.isEditable).toBe(false);

    // Attempting to replace non-editable object throws
    expect(() => editor.replaceText('p0_obj3', 'New Image Text')).toThrow(
      PdfInvalidReplacementError,
    );
  });
});

