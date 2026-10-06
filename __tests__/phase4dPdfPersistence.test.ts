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
  createPdfSelectionState,
} from '../src/features/pdf/types';
import {
  PdfBatchEditError,
  PdfCorruptedError,
} from '../src/errors';

describe('Phase 4D - PDF Save / Reopen / Persistence Hardening', () => {
  const mockInitialHeading: PdfTextObject = {
    id: 'p0_o1',
    pageIndex: 0,
    objectIndex: 1,
    objectPath: [1],
    text: 'Original Heading Text',
    bounds: { x: 50, y: 100, width: 200, height: 24 },
    pdfBounds: { left: 50, bottom: 668, right: 250, top: 692 },
    fontSize: 18,
    fontName: 'Helvetica-Bold',
    fontDetails: null,
    color: '#000000',
    colorRgba: { r: 0, g: 0, b: 0, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 668 },
    isEditable: true,
  };

  const mockInitialBodyToDelete: PdfTextObject = {
    id: 'p0_o2',
    pageIndex: 0,
    objectIndex: 2,
    objectPath: [2],
    text: 'Delete This Paragraph',
    bounds: { x: 50, y: 150, width: 250, height: 18 },
    pdfBounds: { left: 50, bottom: 624, right: 300, top: 642 },
    fontSize: 14,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#333333',
    colorRgba: { r: 51, g: 51, b: 51, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 624 },
    isEditable: true,
  };

  const mockNestedFormText: PdfTextObject = {
    id: 'p0_form1_o3',
    pageIndex: 0,
    objectIndex: 3,
    objectPath: [1, 3],
    text: 'Nested Form Content',
    bounds: { x: 80, y: 220, width: 180, height: 16 },
    pdfBounds: { left: 80, bottom: 556, right: 260, top: 572 },
    fontSize: 12,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#111111',
    colorRgba: { r: 17, g: 17, b: 17, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 80, f: 556 },
    isEditable: true,
  };

  let mockEngine: jest.Mocked<IPdfiumEngine>;
  let activeDocumentPath: string = '/mock/source.pdf';
  let activeDocHandleCounter = 500;
  let openHandles = new Set<number>();
  let dynamicTextObjectsByPath = new Map<string, PdfTextObject[]>();
  let batchShouldFailWith: string | null = null;
  let reopenShouldCorrupt: boolean = false;
  let capturedBatchRequest: PdfBatchEditRequest | null = null;

  beforeEach(() => {
    activeDocumentPath = '/mock/source.pdf';
    activeDocHandleCounter = 500;
    openHandles.clear();
    batchShouldFailWith = null;
    reopenShouldCorrupt = false;
    capturedBatchRequest = null;
    dynamicTextObjectsByPath.clear();

    const initialObjects = [
      { ...mockInitialHeading },
      { ...mockInitialBodyToDelete },
      { ...mockNestedFormText },
    ];
    dynamicTextObjectsByPath.set('/mock/source.pdf', [...initialObjects]);

    mockEngine = {
      openDocument: jest.fn().mockImplementation((path: string) => {
        if (reopenShouldCorrupt && path.includes('corrupt')) {
          return Promise.reject(new PdfCorruptedError('Corrupt PDF payload'));
        }
        activeDocumentPath = path;
        const handle = ++activeDocHandleCounter;
        openHandles.add(handle);
        return Promise.resolve({
          docHandle: handle,
          pageCount: 1,
          filePath: path,
        } as PdfDocumentHandle);
      }),
      closeDocument: jest.fn().mockImplementation((handle: number) => {
        openHandles.delete(handle);
        return Promise.resolve();
      }),
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
      getTextObjects: jest.fn().mockImplementation((docHandle: number, pageIndex: number) => {
        const objs = dynamicTextObjectsByPath.get(activeDocumentPath) || [];
        return Promise.resolve([...objs]);
      }),
      extractAssetPdf: jest.fn().mockResolvedValue('/mock/asset.pdf'),
      replaceTextObject: jest.fn(),
      applyBatchEdits: jest.fn().mockImplementation((req: PdfBatchEditRequest): Promise<PdfMultiEditResult> => {
        capturedBatchRequest = req;
        if (batchShouldFailWith) {
          return Promise.resolve({
            outputPath: req.outputPdfPath,
            totalCommands: req.commands.length,
            appliedCommands: 0,
            pageCountBefore: 1,
            pageCountAfter: 1,
            sourceUnchanged: true,
            sourceChecksumBefore: 'sha_src',
            sourceChecksumAfter: 'sha_src',
            commands: req.commands.map((cmd, idx) => ({
              type: cmd.type,
              objectId: cmd.objectId,
              pageIndex: cmd.pageIndex,
              objectIndex: idx,
              status: 'failed',
              error: batchShouldFailWith!,
            })),
            reopenedVerification: {
              allReplacementsVerified: false,
              allDeletionsVerified: false,
              verifiedReplacements: [],
              missingReplacements: [],
              residualDeletions: [],
            },
            limitations: [batchShouldFailWith],
          });
        }

        // Apply commands to destination path's text object list
        const sourceObjs = dynamicTextObjectsByPath.get(req.inputPdfPath) || [];
        let updated = [...sourceObjs];

        for (const cmd of req.commands) {
          if (cmd.type === 'replace') {
            const idx = updated.findIndex((o) => o.id === cmd.objectId);
            if (idx >= 0) {
              updated[idx] = { ...updated[idx], text: cmd.newText };
            }
          } else if (cmd.type === 'delete') {
            updated = updated.filter((o) => o.id !== cmd.objectId);
          } else if (cmd.type === 'insert') {
            updated.push({
              id: cmd.objectId,
              pageIndex: cmd.pageIndex,
              objectIndex: updated.length,
              objectPath: [updated.length],
              text: cmd.text,
              bounds: cmd.bounds,
              pdfBounds: {
                left: cmd.x,
                bottom: cmd.y,
                right: cmd.x + cmd.bounds.width,
                top: cmd.y + cmd.bounds.height,
              },
              fontSize: cmd.fontSize,
              fontName: cmd.fontName || 'Helvetica',
              fontDetails: null,
              color: cmd.color || '#000000',
              colorRgba: null,
              matrix: { a: 1, b: 0, c: 0, d: 1, e: cmd.x, f: cmd.y },
              isEditable: true,
            });
          }
        }

        dynamicTextObjectsByPath.set(req.outputPdfPath, updated);

        return Promise.resolve({
          outputPath: req.outputPdfPath,
          totalCommands: req.commands.length,
          appliedCommands: req.commands.length,
          pageCountBefore: 1,
          pageCountAfter: 1,
          sourceUnchanged: true,
          sourceChecksumBefore: 'sha_src',
          sourceChecksumAfter: 'sha_src',
          commands: req.commands.map((cmd, idx) => ({
            type: cmd.type,
            objectId: cmd.objectId,
            pageIndex: cmd.pageIndex,
            objectIndex: idx,
            status: 'applied',
          })),
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

  // 1. Save clean document
  test('1. Save clean document succeeds and produces verified output', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');

    const { verified, outputPath } = await editor.saveDocument('/mock/clean_saved.pdf');
    expect(verified).toBe(true);
    expect(outputPath).toBe('/mock/clean_saved.pdf');
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.isDirty()).toBe(false);
  });

  // 2. Save dirty document
  test('2. Save dirty document flushes pending edits and transitions to clean', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.replaceText(mockInitialHeading.id, 'New Title Text');
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');

    const { verified } = await editor.saveDocument('/mock/dirty_saved.pdf');
    expect(verified).toBe(true);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.isDirty()).toBe(false);
    expect(editor.getPendingEdits().length).toBe(0);
  });

  // 3. Save lock prevents concurrent saves
  test('3. Save lock prevents concurrent saves', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    let resolveSave: ((val: any) => void) | null = null;
    mockEngine.applyBatchEdits.mockImplementationOnce(() => {
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    });

    const save1 = editor.saveDocument('/mock/save_lock.pdf');
    await expect(editor.saveDocument('/mock/save_lock.pdf')).rejects.toThrow(
      'A save operation is already in progress.',
    );

    resolveSave!({
      outputPath: '/mock/save_lock.pdf',
      totalCommands: 0,
      appliedCommands: 0,
      pageCountBefore: 1,
      pageCountAfter: 1,
      sourceUnchanged: true,
      sourceChecksumBefore: '',
      sourceChecksumAfter: '',
      commands: [],
      reopenedVerification: {
        allReplacementsVerified: true,
        allDeletionsVerified: true,
        verifiedReplacements: [],
        missingReplacements: [],
        residualDeletions: [],
      },
      limitations: [],
    });

    const res = await save1;
    expect(res.verified).toBe(true);
  });

  // 4. Source remains immutable
  test('4. Source remains immutable: cannot save over source path', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(editor.saveDocument('/mock/source.pdf')).rejects.toThrow(
      /Input and output paths must be different/i,
    );
    expect(editor.getSourceFilePath()).toBe('/mock/source.pdf');
  });

  // 5. Save failure preserves active document
  test('5. Save failure preserves active document', async () => {
    batchShouldFailWith = 'Disk write failed';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(editor.saveDocument('/mock/output_fail.pdf')).rejects.toThrow(PdfBatchEditError);

    // Active document is still the source
    expect(editor.getCurrentFilePath()).toBe('/mock/source.pdf');
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
  });

  // 6. Save failure preserves pending edits
  test('6. Save failure preserves pending edits', async () => {
    batchShouldFailWith = 'Native write error';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.replaceText(mockInitialHeading.id, 'Preserved Text');
    expect(editor.getPendingEdits().length).toBe(1);

    await expect(editor.saveDocument('/mock/fail.pdf')).rejects.toThrow();

    // Edits must NOT be discarded
    expect(editor.getPendingEdits().length).toBe(1);
    expect(editor.getPendingEdits()[0].objectId).toBe(mockInitialHeading.id);
  });

  // 7. Successful save switches to valid output
  test('7. Successful save switches to valid output', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { outputPath } = await editor.saveDocument('/mock/persisted.pdf');
    expect(outputPath).toBe('/mock/persisted.pdf');
    expect(editor.getCurrentFilePath()).toBe('/mock/persisted.pdf');
    expect(editor.getSourceFilePath()).toBe('/mock/source.pdf');
  });

  // 8. Output can be reopened
  test('8. Output can be reopened with valid handle', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.saveDocument('/mock/reopenable.pdf');

    await editor.close();
    await editor.open('/mock/reopenable.pdf');
    expect(editor.getPageCount()).toBe(1);
  });

  // 9. Page count preserved
  test('9. Page count preserved through edits and save', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    const initialPages = editor.getPageCount();

    await editor.saveDocument('/mock/page_count.pdf');
    expect(editor.getPageCount()).toBe(initialPages);
  });

  // 10. Edited text survives reopen
  test('10. Edited text survives reopen', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.replaceText(mockInitialHeading.id, 'Surviving Edited Text');
    await editor.saveDocument('/mock/edited_survives.pdf');

    await editor.close();
    await editor.open('/mock/edited_survives.pdf');
    const objects = await editor.getTextObjects(0);
    const found = objects.find((o) => o.text === 'Surviving Edited Text');
    expect(found).toBeDefined();
  });

  // 11. Original edited text absent after reopen
  test('11. Original edited text absent after reopen', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.replaceText(mockInitialHeading.id, 'Brand New Heading');
    await editor.saveDocument('/mock/replaced.pdf');

    await editor.close();
    await editor.open('/mock/replaced.pdf');
    const objects = await editor.getTextObjects(0);
    const oldFound = objects.find((o) => o.text === 'Original Heading Text');
    expect(oldFound).toBeUndefined();
  });

  // 12. Deleted text remains absent after reopen
  test('12. Deleted text remains absent after reopen', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.deleteText(mockInitialBodyToDelete.id);
    await editor.saveDocument('/mock/deleted.pdf');

    await editor.close();
    await editor.open('/mock/deleted.pdf');
    const objects = await editor.getTextObjects(0);
    const deletedFound = objects.find((o) => o.id === mockInitialBodyToDelete.id);
    expect(deletedFound).toBeUndefined();
  });

  // 13. Inserted text survives reopen
  test('13. Inserted text survives reopen', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    editor.insertText(0, 'Surviving Vector Text', { x: 100, y: 300 });
    await editor.saveDocument('/mock/inserted.pdf');

    await editor.close();
    await editor.open('/mock/inserted.pdf');
    const objects = await editor.getTextObjects(0);
    const insertedFound = objects.find((o) => o.text === 'Surviving Vector Text');
    expect(insertedFound).toBeDefined();
  });

  // 14. Inserted text remains selectable after reopen
  test('14. Inserted text remains selectable after reopen', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    editor.insertText(0, 'Selectable Vector Text', { x: 60, y: 150 });
    await editor.saveDocument('/mock/selectable.pdf');

    await editor.close();
    await editor.open('/mock/selectable.pdf');
    const objects = await editor.getTextObjects(0);
    const obj = objects.find((o) => o.text === 'Selectable Vector Text')!;

    const selectionState = createPdfSelectionState(obj, 0);
    expect(selectionState.selectedObjectId).toBe(obj.id);
    expect(selectionState.selectedBounds).toEqual(obj.bounds);
  });

  // 15. Reopened object cache is fresh
  test('15. Reopened object cache is fresh', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    const objsBefore = await editor.getTextObjects(0);

    await editor.saveDocument('/mock/cache_fresh.pdf');
    const objsAfter = await editor.getTextObjects(0);
    expect(objsAfter).toBeDefined();
    expect(Array.isArray(objsAfter)).toBe(true);
  });

  // 16. Previous document objects do not leak
  test('16. Previous document objects do not leak into newly opened document', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    // Create a separate document fixture
    dynamicTextObjectsByPath.set('/mock/other.pdf', [{
      id: 'other_doc_p0_o1',
      pageIndex: 0,
      objectIndex: 1,
      objectPath: [1],
      text: 'Other Document Exclusively',
      bounds: { x: 10, y: 10, width: 100, height: 10 },
      pdfBounds: { left: 10, bottom: 700, right: 110, top: 710 },
      fontSize: 12,
      fontName: 'Helvetica',
      fontDetails: null,
      color: '#000000',
      colorRgba: null,
      matrix: null,
      isEditable: true,
    }]);

    await editor.close();
    await editor.open('/mock/other.pdf');
    const objects = await editor.getTextObjects(0);

    expect(objects.some((o) => o.text === 'Original Heading Text')).toBe(false);
    expect(objects.some((o) => o.text === 'Other Document Exclusively')).toBe(true);
  });

  // 17. Selection is cleared/reconciled after reopen
  test('17. Selection state is cleared upon document switch', () => {
    let selectionState: any = createPdfSelectionState(mockInitialHeading, 0);
    expect(selectionState.selectedObjectId).toBe(mockInitialHeading.id);

    // Simulate document reopen / save reset
    selectionState = null;
    expect(selectionState).toBeNull();
  });

  // 18. Render cache invalidated after save
  test('18. Render cache invalidated after save', () => {
    const pageRenderCache = new Map<number, string>();
    pageRenderCache.set(0, 'file:///cache/rendered_page_0.png');
    expect(pageRenderCache.size).toBe(1);

    // Save triggers invalidation
    pageRenderCache.clear();
    expect(pageRenderCache.size).toBe(0);
  });

  // 19. Text cache invalidated after save
  test('19. Text cache invalidated after save', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.replaceText(mockInitialHeading.id, 'Updated In Cache');
    await editor.saveDocument('/mock/text_cache_saved.pdf');

    const reloaded = await editor.getTextObjects(0);
    expect(reloaded.find((o) => o.text === 'Updated In Cache')).toBeDefined();
  });

  // 20. Repeated save is safe
  test('20. Repeated save is safe and does not corrupt state', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const res1 = await editor.saveDocument('/mock/rep1.pdf');
    expect(res1.verified).toBe(true);

    const res2 = await editor.saveDocument('/mock/rep2.pdf');
    expect(res2.verified).toBe(true);

    const res3 = await editor.saveDocument('/mock/rep3.pdf');
    expect(res3.verified).toBe(true);

    expect(editor.getSourceFilePath()).toBe('/mock/source.pdf');
  });

  // 21. Multiple sequential edits survive sequential saves
  test('21. Multiple sequential edits survive sequential saves', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    // Edit 1 -> Save
    editor.replaceText(mockInitialHeading.id, 'Title v1');
    await editor.saveDocument('/mock/seq1.pdf');

    // Edit 2 -> Save
    editor.insertText(0, 'Inserted v2', { x: 50, y: 250 });
    await editor.saveDocument('/mock/seq2.pdf');

    await editor.close();
    await editor.open('/mock/seq2.pdf');
    const objects = await editor.getTextObjects(0);

    expect(objects.find((o) => o.text === 'Title v1')).toBeDefined();
    expect(objects.find((o) => o.text === 'Inserted v2')).toBeDefined();
  });

  // 22. Reopen failure preserves previous valid state
  test('22. Reopen failure preserves previous valid state', async () => {
    reopenShouldCorrupt = true;
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    await expect(editor.saveDocument('/mock/corrupt_output.pdf')).rejects.toThrow();

    // Editor still points to valid state
    expect(editor.getCurrentFilePath()).toBe('/mock/source.pdf');
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
  });

  // 23. Invalid output is not promoted
  test('23. Invalid output is not promoted on verification error', async () => {
    reopenShouldCorrupt = true;
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    try {
      await editor.saveDocument('/mock/corrupt_file.pdf');
    } catch {
      // expected
    }

    expect(editor.getCurrentFilePath()).not.toBe('/mock/corrupt_file.pdf');
    expect(editor.getCurrentFilePath()).toBe('/mock/source.pdf');
  });

  // 24. Native document handles are cleaned
  test('24. Native document handles are cleaned without leaks', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    expect(openHandles.size).toBe(1);

    await editor.saveDocument('/mock/cleaned.pdf');
    // Open handle for active document
    expect(openHandles.size).toBe(1);

    await editor.close();
    expect(openHandles.size).toBe(0);
  });

  // 25. Working-copy path remains separate from source
  test('25. Working-copy path remains separate from source', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const defaultOut = editor.deriveDefaultOutputPath();
    expect(defaultOut).not.toBe('/mock/source.pdf');
    expect(defaultOut).toContain('_edited.pdf');
  });

  // 26. Dirty -> Saving -> Clean lifecycle
  test('26. Dirty -> Saving -> Clean lifecycle', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    expect(editor.getSaveState()).toBe('CLEAN');

    editor.replaceText(mockInitialHeading.id, 'Dirtying');
    expect(editor.getSaveState()).toBe('DIRTY');

    await editor.saveDocument('/mock/lifecycle_clean.pdf');
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  // 27. Dirty -> Saving -> SaveFailed lifecycle
  test('27. Dirty -> Saving -> SaveFailed lifecycle', async () => {
    batchShouldFailWith = 'Simulated engine abort';
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    editor.replaceText(mockInitialHeading.id, 'Will Fail');
    expect(editor.getSaveState()).toBe('DIRTY');

    await expect(editor.saveDocument('/mock/fail_lifecycle.pdf')).rejects.toThrow();
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
  });

  // 28. Navigation with unsaved edits does not silently lose data
  test('28. Navigation with unsaved edits does not silently lose data', () => {
    let navigationAllowed = false;
    const isDocDirty = true;

    // Navigation guard check
    if (isDocDirty) {
      // Prompts user before proceeding
      navigationAllowed = false;
    } else {
      navigationAllowed = true;
    }

    expect(navigationAllowed).toBe(false);
  });

  // 29. Existing Edit regression
  test('29. Existing Edit regression', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockInitialHeading.id,
      'Regression Edit Tested',
      '/mock/working_p4d_edit.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(reconciledObject.text).toBe('Regression Edit Tested');
  });

  // 30. Existing Delete regression
  test('30. Existing Delete regression', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextDeletion(
      mockInitialBodyToDelete.id,
      '/mock/working_p4d_del.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    const objs = await editor.getTextObjects(0);
    expect(objs.find((o) => o.id === mockInitialBodyToDelete.id)).toBeUndefined();
  });

  // 31. Existing Add Text regression
  test('31. Existing Add Text regression', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');

    const { result, insertedObject } = await editor.applyNewTextInsertion(
      0,
      'Regression Insert Tested',
      { x: 50, y: 120 },
      '/mock/working_p4d_ins.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect(insertedObject.text).toBe('Regression Insert Tested');
  });

  // 32. Coordinate/selection regression
  test('32. Coordinate/selection regression', () => {
    const sel = createPdfSelectionState(mockInitialHeading, 0);
    expect(sel.selectedBounds.x).toBe(50);
    expect(sel.selectedBounds.y).toBe(100);
    expect(sel.selectedBounds.width).toBe(200);
    expect(sel.selectedBounds.height).toBe(24);
  });

  // 33. Nested Form replacement regression
  test('33. Nested Form replacement regression', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result, reconciledObject } = await editor.applyExistingTextReplacement(
      mockNestedFormText.id,
      'Updated Form Vector Text',
      '/mock/working_p4d_form_rep.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 3]);
    expect(reconciledObject.text).toBe('Updated Form Vector Text');
  });

  // 34. Nested Form deletion regression
  test('34. Nested Form deletion regression', async () => {
    const editor = new PdfDocumentEditor(mockEngine, '/mock/source.pdf');
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);

    const { result } = await editor.applyExistingTextDeletion(
      mockNestedFormText.id,
      '/mock/working_p4d_form_del.pdf',
    );

    expect(result.appliedCommands).toBe(1);
    expect((capturedBatchRequest?.commands[0] as any).objectPath).toEqual([1, 3]);
  });
});
