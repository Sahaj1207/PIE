import React from 'react';
import {
  PdfDocumentEditor,
} from '../src/features/pdf/pdfDocumentEditor';
import {
  IPdfiumEngine,
  PdfBatchEditRequest,
  PdfMultiEditResult,
  PdfTextObject,
  PdfDocumentHandle,
  PdfPageSize,
  PdfRenderedPage,
  PdfTextReplacementRequest,
  PdfTextReplacementResult,
} from '../src/features/pdf/types';
import {
  PdfInvalidReplacementError,
  PdfInvalidObjectIdError,
  PdfInvalidObjectPathError,
  PdfFontLimitationError,
  PdfTextReplacementError,
  PdfBatchEditError,
  PdfDocumentNotOpenError,
} from '../src/errors';

describe('Phase 4A — PDF Existing Text Replacement', () => {
  const mockRootObject: PdfTextObject = {
    id: 'p0_o2',
    pageIndex: 0,
    objectIndex: 2,
    objectPath: [2],
    text: 'Original Root Text',
    bounds: { x: 50, y: 100, width: 200, height: 24 },
    pdfBounds: { left: 50, bottom: 668, right: 250, top: 692 },
    fontSize: 18,
    fontName: 'Helvetica-Bold',
    fontDetails: {
      baseFontName: 'Helvetica-Bold',
      familyName: 'Helvetica',
      isEmbedded: false,
      isSubset: false,
      weight: 700,
      flags: 0,
    },
    color: '#000000',
    colorRgba: { r: 0, g: 0, b: 0, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 668 },
    isEditable: true,
  };

  const mockNestedObject: PdfTextObject = {
    id: 'p0_form1_form0_o3',
    pageIndex: 0,
    objectIndex: 3,
    objectPath: [1, 0, 3],
    text: 'Nested Form Header',
    bounds: { x: 72, y: 150, width: 180, height: 20 },
    pdfBounds: { left: 72, bottom: 622, right: 252, top: 642 },
    fontSize: 14,
    fontName: 'CustomSubset-Regular',
    fontDetails: {
      baseFontName: 'CustomSubset-Regular',
      familyName: 'CustomFont',
      isEmbedded: true,
      isSubset: true,
      weight: 400,
      flags: 4,
    },
    color: '#112233',
    colorRgba: { r: 17, g: 34, b: 51, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 72, f: 622 },
    isEditable: true,
  };

  const mockNonEditableObject: PdfTextObject = {
    ...mockRootObject,
    id: 'p0_o5',
    objectIndex: 5,
    objectPath: [5],
    isEditable: false,
  };

  let mockEngine: jest.Mocked<IPdfiumEngine>;
  let capturedBatchRequest: PdfBatchEditRequest | null = null;
  let batchShouldFailWith: string | null = null;

  beforeEach(() => {
    capturedBatchRequest = null;
    batchShouldFailWith = null;

    mockEngine = {
      openDocument: jest.fn().mockResolvedValue({
        docHandle: 101,
        pageCount: 1,
        filePath: '/mock/source.pdf',
      } as PdfDocumentHandle),
      closeDocument: jest.fn().mockResolvedValue(undefined),
      getPageCount: jest.fn().mockResolvedValue(1),
      getPageSize: jest.fn().mockResolvedValue({
        pageIndex: 0,
        width: 612,
        height: 792,
      } as PdfPageSize),
      renderPage: jest.fn().mockResolvedValue({
        filePath: '/mock/page0.png',
        uri: 'file:///mock/page0.png',
        width: 1224,
        height: 1584,
      } as PdfRenderedPage),
      getTextObjects: jest.fn().mockImplementation((docHandle: number, pageIdx: number) => {
        // Return updated text if a replacement was captured
        if (capturedBatchRequest && capturedBatchRequest.commands.length > 0) {
          const cmd = capturedBatchRequest.commands[0];
          if (cmd.type === 'replace') {
            return Promise.resolve([
              cmd.objectId === mockRootObject.id
                ? { ...mockRootObject, text: cmd.newText }
                : mockRootObject,
              cmd.objectId === mockNestedObject.id
                ? { ...mockNestedObject, text: cmd.newText }
                : mockNestedObject,
            ]);
          }
        }
        return Promise.resolve([mockRootObject, mockNestedObject, mockNonEditableObject]);
      }),
      extractAssetPdf: jest.fn().mockResolvedValue('/mock/asset.pdf'),
      replaceTextObject: jest.fn(),
      applyBatchEdits: jest.fn().mockImplementation((req: PdfBatchEditRequest): Promise<PdfMultiEditResult> => {
        capturedBatchRequest = req;
        if (batchShouldFailWith) {
          const isFont = batchShouldFailWith.toLowerCase().includes('font') || batchShouldFailWith.toLowerCase().includes('glyph');
          const isPath = batchShouldFailWith.toLowerCase().includes('path') || batchShouldFailWith.toLowerCase().includes('locator');
          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: req.commands.length,
            appliedCommands: 0,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'hash_abc123',
            sourceChecksumAfter: 'hash_abc123',
            commands: [
              {
                type: 'replace',
                objectId: req.commands[0].objectId,
                pageIndex: req.commands[0].pageIndex,
                objectIndex: (req.commands[0] as any).objectIndex,
                status: 'failed',
                error: batchShouldFailWith,
              },
            ],
            reopenedVerification: {
              allReplacementsVerified: false,
              allDeletionsVerified: true,
              verifiedReplacements: [],
              missingReplacements: [req.commands[0].objectId],
              residualDeletions: [],
            },
            limitations: [batchShouldFailWith],
          });
        }

        return Promise.resolve({
          outputPath: req.outputPdfPath,
          totalCommands: req.commands.length,
          appliedCommands: 1,
          pageCountBefore: 1,
          pageCountAfter: 1,
          sourceUnchanged: true,
          sourceChecksumBefore: 'hash_abc123',
          sourceChecksumAfter: 'hash_abc123',
          commands: [
            {
              type: 'replace',
              objectId: req.commands[0].objectId,
              pageIndex: req.commands[0].pageIndex,
              objectIndex: (req.commands[0] as any).objectIndex,
              status: 'applied',
              originalText: (req.commands[0] as any).originalText,
              newText: (req.commands[0] as any).newText,
              fontReused: true,
              fontStrategy: 'REUSED_ORIGINAL',
            },
          ],
          reopenedVerification: {
            allReplacementsVerified: true,
            allDeletionsVerified: true,
            verifiedReplacements: [(req.commands[0] as any).newText],
            missingReplacements: [],
            residualDeletions: [],
          },
          limitations: [],
        });
      }),
      createEditor: jest.fn(),
    };
  });

  // 1. Edit action opens selected text
  test('1. Edit action targets selected text and provides authoritative target metadata', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    const objects = await editor.getTextObjects(0);
    const selected = objects.find((o) => o.id === mockRootObject.id);

    expect(selected).toBeDefined();
    expect(selected?.text).toBe('Original Root Text');
    expect(selected?.bounds).toEqual(mockRootObject.bounds);
    expect(selected?.objectPath).toEqual([2]);
  });

  // 2. Existing text is prefilled
  test('2. Target object text is prefilled for modification', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);
    const original = editor.getOriginalObject(mockRootObject.id);

    expect(original?.text).toBe('Original Root Text');
    expect(original?.fontSize).toBe(18);
  });

  // 3. Empty replacement rejected
  test('3. Empty replacement is rejected with PdfInvalidReplacementError', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextReplacement(mockRootObject.id, '', '/mock/working.pdf'),
    ).rejects.toThrow(PdfInvalidReplacementError);
  });

  // 4. Whitespace-only replacement rejected
  test('4. Whitespace-only replacement is rejected with PdfInvalidReplacementError', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextReplacement(mockRootObject.id, '   \t\n  ', '/mock/working.pdf'),
    ).rejects.toThrow(PdfInvalidReplacementError);
  });

  // 5. Replacement command contains target identity
  test('5. Replacement command contains pageIndex, objectId, objectPath, originalText, and newText', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextReplacement(mockRootObject.id, 'Updated Text', '/mock/working.pdf');

    expect(capturedBatchRequest).not.toBeNull();
    const cmd = capturedBatchRequest!.commands[0];
    expect(cmd.type).toBe('replace');
    expect(cmd.objectId).toBe(mockRootObject.id);
    expect(cmd.pageIndex).toBe(0);
    expect((cmd as any).objectIndex).toBe(2);
    expect((cmd as any).objectPath).toEqual([2]);
    expect((cmd as any).originalText).toBe('Original Root Text');
    expect((cmd as any).newText).toBe('Updated Text');
  });

  // 6. Root-level text replacement
  test('6. Root-level text replacement executes successfully via native batch engine', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockRootObject.id,
      'New Root Value',
      '/mock/working.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(result.commands[0].status).toBe('applied');
    expect(reconciledObject.text).toBe('New Root Value');
  });

  // 7. Nested Form XObject replacement
  test('7. Nested Form XObject replacement preserves nested objectPath and executes', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockNestedObject.id,
      'New Nested Value',
      '/mock/working.pdf',
    );

    expect(capturedBatchRequest).not.toBeNull();
    const cmd = capturedBatchRequest!.commands[0];
    expect((cmd as any).objectPath).toEqual([1, 0, 3]);
    expect(reconciledObject.objectPath).toEqual([1, 0, 3]);
    expect(reconciledObject.text).toBe('New Nested Value');
  });

  // 8. Correct objectPath resolution
  test('8. Failure to resolve objectPath throws PdfInvalidObjectPathError', async () => {
    batchShouldFailWith = 'Object locator path could not be resolved';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextReplacement(mockNestedObject.id, 'Failing Path Text', '/mock/working.pdf'),
    ).rejects.toThrow(PdfInvalidObjectPathError);
  });

  // 9. Original bounds/position preserved
  test('9. Original bounds and transformation geometry are preserved after replacement', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { reconciledObject } = await editor.applyExistingTextReplacement(
      mockRootObject.id,
      'Geometry Preserved Text',
      '/mock/working.pdf',
    );

    expect(reconciledObject.bounds).toEqual(mockRootObject.bounds);
    expect(reconciledObject.pdfBounds).toEqual(mockRootObject.pdfBounds);
    expect(reconciledObject.matrix).toEqual(mockRootObject.matrix);
  });

  // 10. Original font retained when safe
  test('10. Original font strategy is REUSED_ORIGINAL when replacement characters are supported', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextReplacement(
      mockRootObject.id,
      'Safe Ascii Text',
      '/mock/working.pdf',
    );

    expect(result.commands[0].fontReused).toBe(true);
    expect(result.commands[0].fontStrategy).toBe('REUSED_ORIGINAL');
  });

  // 11. Font/glyph limitation produces typed error
  test('11. Font/glyph limitation on subset throws typed PdfFontLimitationError', async () => {
    batchShouldFailWith = 'PDF_FONT_LIMITATION: replacement glyphs not available in embedded font subset';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextReplacement(mockNestedObject.id, 'Unsupported 🚀 Glyphs', '/mock/working.pdf'),
    ).rejects.toThrow(PdfFontLimitationError);
  });

  // 12. Native replacement failure preserves original state
  test('12. Native replacement failure leaves original document and cache recoverable', async () => {
    batchShouldFailWith = 'Native write error';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextReplacement(mockRootObject.id, 'Failing Text', '/mock/working.pdf'),
    ).rejects.toThrow(PdfTextReplacementError);

    // Verify original object in cache is unaffected
    const original = editor.getOriginalObject(mockRootObject.id);
    expect(original?.text).toBe('Original Root Text');
  });

  // 13. Successful replacement reconciles selected object
  test('13. Successful replacement reconciles selected object identity, text and bounds', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { reconciledObject } = await editor.applyExistingTextReplacement(
      mockRootObject.id,
      'Reconciled Final Text',
      '/mock/working.pdf',
    );

    expect(reconciledObject.id).toBe(mockRootObject.id);
    expect(reconciledObject.text).toBe('Reconciled Final Text');
    expect(reconciledObject.objectPath).toEqual([2]);
  });

  // 14. Preview does not mutate source PDF
  test('14. Optimistic preview command does not mutate source PDF path', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    // Same input and output path rejected to guarantee source immutability
    await expect(
      editor.applyExistingTextReplacement(mockRootObject.id, 'New Text', '/mock/source.pdf'),
    ).rejects.toThrow(PdfBatchEditError);

    // Captured request verifies output is distinct working copy
    await editor.applyExistingTextReplacement(mockRootObject.id, 'New Text', '/mock/working_copy.pdf');
    expect(capturedBatchRequest?.inputPdfPath).toBe('/mock/source.pdf');
    expect(capturedBatchRequest?.outputPdfPath).toBe('/mock/working_copy.pdf');
    expect(capturedBatchRequest?.inputPdfPath).not.toBe(capturedBatchRequest?.outputPdfPath);
  });

  // 15. Replacement target cannot accidentally become another object
  test('15. Target cannot become another object even if another object has similar text', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextReplacement(mockNestedObject.id, 'Updated Nested', '/mock/working.pdf');

    expect(capturedBatchRequest?.commands[0].objectId).toBe(mockNestedObject.id);
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 0, 3]);
  });

  // 16. Multiple replacement operations target their correct objects
  test('16. Multiple replacements target their correct respective root and nested objects', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    // First replacement: Root object
    await editor.applyExistingTextReplacement(mockRootObject.id, 'First Root Update', '/mock/working1.pdf');
    expect(capturedBatchRequest?.commands[0].objectId).toBe(mockRootObject.id);
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([2]);

    // Second replacement: Nested Form XObject
    await editor.applyExistingTextReplacement(mockNestedObject.id, 'Second Nested Update', '/mock/working2.pdf');
    expect(capturedBatchRequest?.commands[0].objectId).toBe(mockNestedObject.id);
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 0, 3]);
  });
});
