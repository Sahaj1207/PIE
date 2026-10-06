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
} from '../src/features/pdf/types';
import {
  PdfInvalidObjectIdError,
  PdfInvalidObjectPathError,
  PdfNonDeletableObjectError,
  PdfTextDeletionError,
  PdfDeletedObjectEditError,
  PdfBatchEditError,
} from '../src/errors';

describe('Phase 4B — PDF Existing Text Deletion', () => {
  const mockRootObject: PdfTextObject = {
    id: 'p0_o2',
    pageIndex: 0,
    objectIndex: 2,
    objectPath: [2],
    text: 'Root Heading To Delete',
    bounds: { x: 50, y: 100, width: 220, height: 26 },
    pdfBounds: { left: 50, bottom: 666, right: 270, top: 692 },
    fontSize: 20,
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
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 666 },
    isEditable: true,
  };

  const mockNestedObject: PdfTextObject = {
    id: 'p0_form1_form0_o3',
    pageIndex: 0,
    objectIndex: 3,
    objectPath: [1, 0, 3],
    text: 'Nested Text In Form XObject',
    bounds: { x: 72, y: 200, width: 190, height: 18 },
    pdfBounds: { left: 72, bottom: 574, right: 262, top: 592 },
    fontSize: 14,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#333333',
    colorRgba: { r: 51, g: 51, b: 51, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 72, f: 574 },
    isEditable: true,
  };

  const mockNonEditableObject: PdfTextObject = {
    ...mockRootObject,
    id: 'p0_o5',
    objectIndex: 5,
    objectPath: [5],
    text: 'Non-Editable Vector Text',
    isEditable: false,
  };

  let mockEngine: jest.Mocked<IPdfiumEngine>;
  let capturedBatchRequest: PdfBatchEditRequest | null = null;
  let batchShouldFailWith: string | null = null;
  let activeDocumentPath: string = '/mock/source.pdf';
  let deletedObjectIdsSet: Set<string>;

  beforeEach(() => {
    capturedBatchRequest = null;
    batchShouldFailWith = null;
    activeDocumentPath = '/mock/source.pdf';
    deletedObjectIdsSet = new Set<string>();

    mockEngine = {
      openDocument: jest.fn().mockImplementation((path: string) => {
        activeDocumentPath = path;
        return Promise.resolve({
          docHandle: 201,
          pageCount: 1,
          filePath: path,
        } as PdfDocumentHandle);
      }),
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
      getTextObjects: jest.fn().mockImplementation(() => {
        const remaining = [mockRootObject, mockNestedObject, mockNonEditableObject]
          .filter((o) => !deletedObjectIdsSet.has(o.id))
          .map((o) => {
            if (capturedBatchRequest && capturedBatchRequest.commands.length > 0) {
              const cmd = capturedBatchRequest.commands[0];
              if (cmd.type === 'replace' && cmd.objectId === o.id) {
                return { ...o, text: (cmd as any).newText };
              }
            }
            return o;
          });
        return Promise.resolve(remaining);
      }),
      extractAssetPdf: jest.fn().mockResolvedValue('/mock/asset.pdf'),
      replaceTextObject: jest.fn(),
      applyBatchEdits: jest.fn().mockImplementation((req: PdfBatchEditRequest): Promise<PdfMultiEditResult> => {
        capturedBatchRequest = req;
        const cmd = req.commands[0];

        if (batchShouldFailWith) {
          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: req.commands.length,
            appliedCommands: 0,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'sha256_before_hash',
            sourceChecksumAfter: 'sha256_before_hash',
            commands: [
              {
                type: cmd.type,
                objectId: cmd.objectId,
                pageIndex: cmd.pageIndex,
                objectIndex: (cmd as any).objectIndex,
                status: 'failed',
                error: batchShouldFailWith,
              },
            ],
            reopenedVerification: {
              allReplacementsVerified: true,
              allDeletionsVerified: false,
              verifiedReplacements: [],
              missingReplacements: [],
              residualDeletions: [cmd.objectId],
            },
            limitations: [batchShouldFailWith],
          });
        }

        if (cmd.type === 'delete') {
          deletedObjectIdsSet.add(cmd.objectId);
        }

        return Promise.resolve({
          outputPath: req.outputPdfPath,
          totalCommands: req.commands.length,
          appliedCommands: 1,
          pageCountBefore: 1,
          pageCountAfter: 1,
          sourceUnchanged: true,
          sourceChecksumBefore: 'sha256_before_hash',
          sourceChecksumAfter: 'sha256_before_hash',
          commands: [
            {
              type: 'delete',
              objectId: cmd.objectId,
              pageIndex: cmd.pageIndex,
              objectIndex: (cmd as any).objectIndex,
              status: 'applied',
              originalText: (cmd as any).originalText,
            },
          ],
          reopenedVerification: {
            allReplacementsVerified: true,
            allDeletionsVerified: true,
            verifiedReplacements: [],
            missingReplacements: [],
            residualDeletions: [],
          },
          limitations: [],
        });
      }),
      createEditor: jest.fn(),
      // Verified copy (Save with no queued commands). Test double only: emulates the native
      // copy through this mock's batch implementation so failure injection still applies.
      copyDocument: jest.fn((inputPdfPath: string, outputPdfPath: string) =>
        mockEngine.applyBatchEdits({ inputPdfPath, outputPdfPath, commands: [] }),
      ),
    };
  });

  // 1. Delete selected root-level text
  test('1. Delete selected root-level text executes native deletion', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf');

    expect(result.appliedCommands).toBe(1);
    expect(result.commands[0].status).toBe('applied');
    expect(result.commands[0].type).toBe('delete');
    expect(deletedObjectIdsSet.has(mockRootObject.id)).toBe(true);
  });

  // 2. Delete selected nested Form text
  test('2. Delete selected nested Form text preserves nested Form hierarchy and deletes only text', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextDeletion(mockNestedObject.id, '/mock/working.pdf');

    expect(result.appliedCommands).toBe(1);
    expect(result.commands[0].status).toBe('applied');
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 0, 3]);
    expect(deletedObjectIdsSet.has(mockNestedObject.id)).toBe(true);
  });

  // 3. Correct objectPath is passed
  test('3. Correct objectPath is passed in the deletion command', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextDeletion(mockNestedObject.id, '/mock/working.pdf');

    expect(capturedBatchRequest).not.toBeNull();
    expect((capturedBatchRequest!.commands[0] as any).objectPath).toEqual([1, 0, 3]);
  });

  // 4. Correct pageIndex is passed
  test('4. Correct pageIndex is passed in the deletion command', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf');

    expect(capturedBatchRequest).not.toBeNull();
    expect(capturedBatchRequest!.commands[0].pageIndex).toBe(0);
  });

  // 5. Correct objectId is passed
  test('5. Correct objectId is passed in the deletion command', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf');

    expect(capturedBatchRequest).not.toBeNull();
    expect(capturedBatchRequest!.commands[0].objectId).toBe(mockRootObject.id);
  });

  // 6. Delete cannot target another object
  test('6. Delete cannot target another object; only the designated target is affected', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextDeletion(mockNestedObject.id, '/mock/working.pdf');

    expect(capturedBatchRequest?.commands[0].objectId).toBe(mockNestedObject.id);
    expect(capturedBatchRequest?.commands[0].objectId).not.toBe(mockRootObject.id);
    expect(deletedObjectIdsSet.has(mockRootObject.id)).toBe(false);
  });

  // 7. Delete fails for invalid object ID
  test('7. Delete fails for empty or unknown object ID', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(editor.applyExistingTextDeletion('', '/mock/working.pdf')).rejects.toThrow(
      PdfInvalidObjectIdError,
    );
    await expect(editor.applyExistingTextDeletion('non_existent_obj', '/mock/working.pdf')).rejects.toThrow(
      PdfInvalidObjectIdError,
    );
  });

  // 8. Delete fails for invalid objectPath
  test('8. Delete fails when object locator path cannot be resolved natively', async () => {
    batchShouldFailWith = 'Object locator path could not be resolved';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextDeletion(mockNestedObject.id, '/mock/working.pdf'),
    ).rejects.toThrow(PdfInvalidObjectPathError);
  });

  // 9. Delete fails when object no longer exists
  test('9. Delete fails when object was already deleted', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    // First deletion succeeds
    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf');

    // Second deletion on the same object fails
    await expect(
      editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working2.pdf'),
    ).rejects.toThrow(PdfDeletedObjectEditError);
  });

  // 10. Delete fails for non-text object
  test('10. Delete fails with PdfNonDeletableObjectError for non-text or non-editable object', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextDeletion(mockNonEditableObject.id, '/mock/working.pdf'),
    ).rejects.toThrow(PdfNonDeletableObjectError);
  });

  // 11. Native deletion failure preserves original state
  test('11. Native deletion failure preserves original document state and caches', async () => {
    batchShouldFailWith = 'Native disk write failed';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf'),
    ).rejects.toThrow(PdfTextDeletionError);

    // Active document is still the original source
    expect(activeDocumentPath).toBe('/mock/source.pdf');
    // Object was not marked as deleted
    expect(deletedObjectIdsSet.has(mockRootObject.id)).toBe(false);
  });

  // 12. Source PDF remains immutable
  test('12. Source PDF path cannot be used as destination, ensuring immutability', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await expect(
      editor.applyExistingTextDeletion(mockRootObject.id, '/mock/source.pdf'),
    ).rejects.toThrow(PdfBatchEditError);

    // Source document remains untouched
    expect(activeDocumentPath).toBe('/mock/source.pdf');
  });

  // 13. Working copy becomes active only after success
  test('13. Working copy becomes active only after successful native persistence', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    expect(activeDocumentPath).toBe('/mock/source.pdf');

    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working_copy_v1.pdf');

    expect(activeDocumentPath).toBe('/mock/working_copy_v1.pdf');
  });

  // 14. Deleted object disappears after reconciliation
  test('14. Deleted object disappears from getTextObjects after reconciliation', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    let objects = await editor.getTextObjects(0);
    expect(objects.some((o) => o.id === mockRootObject.id)).toBe(true);

    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf');

    objects = await editor.getTextObjects(0);
    expect(objects.some((o) => o.id === mockRootObject.id)).toBe(false);
  });

  // 15. Selection is cleared after successful deletion
  test('15. Object is removed from textObjectsCache ensuring selection clearing', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    expect(editor.getOriginalObject(mockRootObject.id)).toBeDefined();

    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working.pdf');

    expect(editor.getOriginalObject(mockRootObject.id)).toBeUndefined();
  });

  // 16. Stale selection cannot delete another object
  test('16. Stale selection ID rejects subsequent operations and cannot delete another object', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working1.pdf');

    // Attempting delete with stale root object ID cannot mutate nested object
    await expect(
      editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working2.pdf'),
    ).rejects.toThrow(PdfDeletedObjectEditError);

    expect(deletedObjectIdsSet.has(mockNestedObject.id)).toBe(false);
  });

  // 17. Edit/replacement tests still pass alongside deletion
  test('17. Phase 4A text replacement continues to function alongside deletion', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    // Replacement works cleanly
    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockRootObject.id,
      'Replaced Before Any Delete',
      '/mock/replaced.pdf',
    );
    expect(result.appliedCommands).toBe(1);
    expect(reconciledObject.text).toBe('Replaced Before Any Delete');

    // Deletion works subsequently
    const delResult = await editor.applyExistingTextDeletion(mockNestedObject.id, '/mock/deleted.pdf');
    expect(delResult.result.appliedCommands).toBe(1);
  });

  // 18. Root-level and nested object identity remain deterministic
  test('18. Root-level and nested object identity remain distinct and deterministic', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    // Delete nested object
    await editor.applyExistingTextDeletion(mockNestedObject.id, '/mock/working1.pdf');
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 0, 3]);

    // Delete root object
    await editor.applyExistingTextDeletion(mockRootObject.id, '/mock/working2.pdf');
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([2]);
  });
});
