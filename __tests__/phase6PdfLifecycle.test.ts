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
  PdfSaveError,
  PdfSaveAsError,
  PdfConcurrentSaveError,
  PdfValidationFailureError,
  PdfDocumentClosedError,
  PdfCorruptedError,
} from '../src/errors';

describe('Phase 6 - PDF Document Lifecycle & Final Save/Export Hardening', () => {
  const mockInitialObj1: PdfTextObject = {
    id: 'p0_o1',
    pageIndex: 0,
    objectIndex: 1,
    objectPath: [1],
    text: 'Lifecycle Title Heading',
    bounds: { x: 50, y: 100, width: 220, height: 26 },
    pdfBounds: { left: 50, bottom: 666, right: 270, top: 692 },
    fontSize: 18,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#1C1C1E',
    colorRgba: { r: 28, g: 28, b: 30, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 666 },
    isEditable: true,
  };

  const mockInitialObj2: PdfTextObject = {
    id: 'p0_o2',
    pageIndex: 0,
    objectIndex: 2,
    objectPath: [2],
    text: 'Body Paragraph To Delete',
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

  class MockLifecycleEngine implements IPdfiumEngine {
    openCalls: string[] = [];
    closeCalls: number[] = [];
    applyBatchEditsCalls: PdfBatchEditRequest[] = [];
    shouldFailApply = false;
    failMessage = 'Native PDFium batch edit failed';
    pageCountToReturn = 1;
    activeHandleCounter = 100;

    async openDocument(filePath: string): Promise<PdfDocumentHandle> {
      this.openCalls.push(filePath);
      this.activeHandleCounter++;
      return {
        docHandle: this.activeHandleCounter,
        pageCount: this.pageCountToReturn,
        filePath,
      };
    }

    async closeDocument(docHandle: number): Promise<boolean> {
      this.closeCalls.push(docHandle);
      return true;
    }

    async getPageCount(docHandle: number): Promise<number> {
      return this.pageCountToReturn;
    }

    async getPageSize(docHandle: number, pageIndex: number): Promise<PdfPageSize> {
      return { pageIndex, width: 612, height: 792 };
    }

    async renderPage(docHandle: number, pageIndex: number): Promise<PdfRenderedPage> {
      return {
        filePath: '/mock/rendered.png',
        uri: 'file:///mock/rendered.png',
        width: 612,
        height: 792,
        pageWidth: 612,
        pageHeight: 792,
        scale: 1,
        pageIndex,
      };
    }

    async getTextObjects(): Promise<PdfTextObject[]> {
      return [{ ...mockInitialObj1 }, { ...mockInitialObj2 }];
    }

    async extractAssetPdf(): Promise<string> {
      return '/mock/asset.pdf';
    }

    async replaceTextObject(): Promise<any> {
      throw new Error('Not used in Phase 6');
    }

    // Verified copy (Save with no queued commands). Test double only: emulates the native
    // copy through this mock's batch implementation so failure injection still applies.
    async copyDocument(inputPdfPath: string, outputPdfPath: string): Promise<PdfMultiEditResult> {
      return this.applyBatchEdits({ inputPdfPath, outputPdfPath, commands: [] });
    }

    async applyBatchEdits(request: PdfBatchEditRequest): Promise<PdfMultiEditResult> {
      this.applyBatchEditsCalls.push(request);

      if (this.shouldFailApply) {
        return {
          outputPath: request.outputPdfPath,
          totalCommands: request.commands.length,
          appliedCommands: 0,
          pageCountBefore: 1,
          pageCountAfter: 1,
          sourceUnchanged: true,
          sourceChecksumBefore: 'sha_source',
          sourceChecksumAfter: 'sha_source',
          commands: request.commands.map((c) => ({
            type: c.type,
            objectId: c.objectId,
            pageIndex: c.pageIndex,
            objectIndex: (c as any).objectIndex ?? 0,
            status: 'failed',
            error: this.failMessage,
          })),
          reopenedVerification: {
            allReplacementsVerified: false,
            allDeletionsVerified: false,
            verifiedReplacements: [],
            missingReplacements: request.commands.map((c) => c.objectId),
            residualDeletions: [],
          },
          limitations: [this.failMessage],
        };
      }

      return {
        outputPath: request.outputPdfPath,
        totalCommands: request.commands.length,
        appliedCommands: request.commands.length,
        pageCountBefore: 1,
        pageCountAfter: 1,
        sourceUnchanged: true,
        sourceChecksumBefore: 'sha_source',
        sourceChecksumAfter: 'sha_source',
        commands: request.commands.map((c) => ({
          type: c.type,
          objectId: c.objectId,
          pageIndex: c.pageIndex,
          objectIndex: (c as any).objectIndex ?? 0,
          status: 'applied',
          originalText: (c as any).originalText,
          newText: (c as any).newText ?? (c as any).text,
          fontReused: true,
          fontStrategy: 'REUSED_ORIGINAL',
        })),
        reopenedVerification: {
          allReplacementsVerified: true,
          allDeletionsVerified: true,
          verifiedReplacements: request.commands.map((c) => c.objectId),
          missingReplacements: [],
          residualDeletions: [],
        },
        limitations: [],
      };
    }

    createEditor(): any {
      throw new Error('Not implemented');
    }
  }

  let engine: MockLifecycleEngine;
  let editor: PdfDocumentEditor;

  beforeEach(async () => {
    engine = new MockLifecycleEngine();
    editor = new PdfDocumentEditor(engine);
    await editor.open('/storage/original_source.pdf');
    await editor.getTextObjects(0);
  });

  // ==========================================
  // Section 1: Import & Working Copy Lifecycle
  // ==========================================

  test('1. Import lifecycle sets source file path and initializes clean state', () => {
    expect(editor.getSourceFilePath()).toBe('/storage/original_source.pdf');
    expect(editor.getCurrentFilePath()).toBe('/storage/original_source.pdf');
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('2. Working copy path is distinct from source file path', async () => {
    await editor.applyExistingTextReplacement('p0_o1', 'Edited Title', '/storage/working_copy.pdf');
    expect(editor.getSourceFilePath()).toBe('/storage/original_source.pdf');
    expect(editor.getCurrentFilePath()).toBe('/storage/working_copy.pdf');
  });

  test('3. Source immutability is maintained during editing session', async () => {
    editor.replaceText('p0_o1', 'New Heading');
    expect(editor.getSourceFilePath()).toBe('/storage/original_source.pdf');
  });

  test('4. Document switching cleanses all previous caches, pending edits, and history', async () => {
    editor.replaceText('p0_o1', 'Doc A Change');
    expect(editor.getPendingEdits()).toHaveLength(1);
    expect(editor.canUndo()).toBe(true);

    // Switch to Doc B
    await editor.open('/storage/document_b.pdf');
    expect(editor.getSourceFilePath()).toBe('/storage/document_b.pdf');
    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('5. Document switching closes previous native handle', async () => {
    const previousCloseCount = engine.closeCalls.length;
    await editor.open('/storage/document_c.pdf');
    expect(engine.closeCalls.length).toBeGreaterThan(previousCloseCount);
  });

  // ==========================================
  // Section 2: Dirty State Hardening
  // ==========================================

  test('6. Initial opened document state is CLEAN', () => {
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('7. Edit existing text marks state DIRTY', () => {
    editor.replaceText('p0_o1', 'Changed Heading');
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');
  });

  test('8. Delete text marks state DIRTY', () => {
    editor.deleteText('p0_o2');
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');
  });

  test('9. Insert text marks state DIRTY', () => {
    editor.insertText(0, 'New Added Paragraph', { x: 50, y: 300 });
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');
  });

  test('10. Formatting existing text marks state DIRTY', () => {
    editor.replaceText('p0_o1', 'Reformatted Heading', { fontSize: 22, color: '#007AFF' });
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');
  });

  test('11. No-op replacement does not mark state DIRTY', () => {
    // Replacing with identical text and no format
    editor.replaceText('p0_o1', 'Lifecycle Title Heading');
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.getPendingEdits()).toHaveLength(0);
  });

  test('12. Undo back to original state restores CLEAN', () => {
    editor.replaceText('p0_o1', 'Temporary Edit');
    expect(editor.isDirty()).toBe(true);

    editor.undo();
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('13. Redo restores DIRTY state', () => {
    editor.replaceText('p0_o1', 'Temporary Edit');
    editor.undo();
    expect(editor.isDirty()).toBe(false);

    editor.redo();
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');
  });

  // ==========================================
  // Section 3: Save & Save As Workflow
  // ==========================================

  test('14. Successful saveDocument returns state to CLEAN and clears pending edits', async () => {
    editor.replaceText('p0_o1', 'Saved Heading');
    expect(editor.isDirty()).toBe(true);

    const res = await editor.saveDocument('/storage/output_saved.pdf');
    expect(res.verified).toBe(true);
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.getPendingEdits()).toHaveLength(0);
  });

  test('15. Save failure marks state SAVE_FAILED and preserves pending edits', async () => {
    engine.shouldFailApply = true;
    editor.replaceText('p0_o1', 'Failing Heading');

    await expect(editor.saveDocument('/storage/output_failed.pdf')).rejects.toThrow();
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
    expect(editor.isDirty()).toBe(true);
    expect(editor.getPendingEdits()).toHaveLength(1);
  });

  test('16. Save retry is permitted after failure and succeeds when resolved', async () => {
    engine.shouldFailApply = true;
    editor.replaceText('p0_o1', 'Retryable Heading');
    await expect(editor.saveDocument('/storage/output_retry.pdf')).rejects.toThrow();

    // Fix condition and retry
    engine.shouldFailApply = false;
    const res = await editor.saveDocument('/storage/output_retry.pdf');
    expect(res.verified).toBe(true);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('17. Repeated save succeeds safely without input/output collision', async () => {
    editor.replaceText('p0_o1', 'Edit 1');
    await editor.saveDocument('/storage/saved_doc.pdf');

    // Reopen/reload page objects for the saved document
    await editor.getTextObjects(0);
    editor.replaceText('p0_o1', 'Edit 2');
    const res2 = await editor.saveDocument('/storage/saved_doc.pdf');
    expect(res2.verified).toBe(true);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('18. saveDocumentAs saves to explicit destination path', async () => {
    editor.replaceText('p0_o1', 'Save As Heading');
    const res = await editor.saveDocumentAs('/storage/exported_as.pdf');
    expect(res.verified).toBe(true);
    expect(res.outputPath).toBe('/storage/exported_as.pdf');
    expect(editor.getSourceFilePath()).toBe('/storage/original_source.pdf');
  });

  test('19. saveDocumentAs rejects invalid file extension with typed error', async () => {
    editor.replaceText('p0_o1', 'Invalid Ext Test');
    await expect(editor.saveDocumentAs('/storage/invalid_file.txt')).rejects.toThrow(PdfSaveAsError);
  });

  test('20. saveDocumentAs rejects destination equal to source path', async () => {
    editor.replaceText('p0_o1', 'Overwrite Source Test');
    await expect(editor.saveDocumentAs('/storage/original_source.pdf')).rejects.toThrow(PdfSaveAsError);
  });

  test('21. Repeated Save As to different destinations succeeds', async () => {
    editor.replaceText('p0_o1', 'Export 1');
    const res1 = await editor.saveDocumentAs('/storage/export_v1.pdf');
    expect(res1.verified).toBe(true);

    // Reopen/reload page objects for the saved document
    await editor.getTextObjects(0);
    editor.replaceText('p0_o1', 'Export 2');
    const res2 = await editor.saveDocumentAs('/storage/export_v2.pdf');
    expect(res2.verified).toBe(true);
  });

  // ==========================================
  // Section 4: Output Validation
  // ==========================================

  test('22. verifyPdfOutput validates valid PDF structure and dimensions', async () => {
    const isValid = await editor.verifyPdfOutput('/storage/valid_output.pdf', 1);
    expect(isValid).toBe(true);
  });

  test('23. verifyPdfOutput rejects 0-page document with PdfCorruptedError', async () => {
    engine.pageCountToReturn = 0;
    await expect(editor.verifyPdfOutput('/storage/empty.pdf')).rejects.toThrow(PdfCorruptedError);
  });

  test('24. verifyPdfOutput rejects empty path with PdfValidationFailureError', async () => {
    await expect(editor.verifyPdfOutput('')).rejects.toThrow(PdfValidationFailureError);
  });

  test('25. Reopen loads saved output accurately', async () => {
    editor.replaceText('p0_o1', 'Pre-Save Text');
    await editor.saveDocument('/storage/saved_roundtrip.pdf');

    // Reopen explicitly
    await editor.open('/storage/saved_roundtrip.pdf');
    expect(editor.getCurrentFilePath()).toBe('/storage/saved_roundtrip.pdf');
    expect(editor.isDirty()).toBe(false);
  });

  // ==========================================
  // Section 5: Discard & Cleanup
  // ==========================================

  test('26. discardWorkingChanges resets state, caches, and pending edits', async () => {
    editor.replaceText('p0_o1', 'Discard Me');
    editor.deleteText('p0_o2');
    expect(editor.isDirty()).toBe(true);

    await editor.discardWorkingChanges();
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
  });

  test('27. discardWorkingChanges is idempotent when called repeatedly', async () => {
    await editor.discardWorkingChanges();
    await editor.discardWorkingChanges();
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  test('28. discardWorkingChanges preserves source file path', async () => {
    editor.replaceText('p0_o1', 'Changes to discard');
    await editor.discardWorkingChanges();
    expect(editor.getSourceFilePath()).toBe('/storage/original_source.pdf');
  });

  test('29. Selection and object caches are purged on close', async () => {
    await editor.close();
    expect(editor.getSourceFilePath()).toBeNull();
    expect(editor.getCurrentFilePath()).toBeNull();
    expect(editor.isDirty()).toBe(false);
  });

  // ==========================================
  // Section 6: Native Lifecycle & Concurrency Hardening
  // ==========================================

  test('30. Concurrent save attempts are rejected with PdfConcurrentSaveError', async () => {
    editor.replaceText('p0_o1', 'Concurrent Test');

    // Simulate saving in flight
    (editor as any).isSaving = true;
    await expect(editor.saveDocument('/storage/concurrent.pdf')).rejects.toThrow(PdfConcurrentSaveError);
    (editor as any).isSaving = false;
  });

  test('31. Invoking operations after document close throws PdfDocumentClosedError', async () => {
    await editor.close();
    expect(() => editor.replaceText('p0_o1', 'After Close')).toThrow(PdfDocumentClosedError);
    expect(() => editor.getPageCount()).toThrow(PdfDocumentClosedError);
  });

  // ==========================================
  // Section 7: Regressions Across Phases 4A - 5
  // ==========================================

  test('32. Regression: Phase 4A text replacement persists', async () => {
    editor.replaceText('p0_o1', 'Phase 4A Replacement');
    const objects = await editor.getTextObjects(0);
    expect(objects.find((o) => o.id === 'p0_o1')!.text).toBe('Phase 4A Replacement');
  });

  test('33. Regression: Phase 4B text deletion persists', async () => {
    editor.deleteText('p0_o2');
    const objects = await editor.getTextObjects(0);
    expect(objects.find((o) => o.id === 'p0_o2')).toBeUndefined();
  });

  test('34. Regression: Phase 4C text insertion persists', async () => {
    const inserted = editor.insertText(0, 'Phase 4C Vector Text', { x: 60, y: 400 }, { fontSize: 16 });
    expect(inserted.text).toBe('Phase 4C Vector Text');
    const objects = await editor.getTextObjects(0);
    expect(objects.some((o) => o.text === 'Phase 4C Vector Text')).toBe(true);
  });

  test('35. Regression: Phase 5 formatting persists', async () => {
    editor.replaceText('p0_o1', 'Formatted Title', { fontSize: 24, color: '#FF3B30' });
    const objects = await editor.getTextObjects(0);
    const formatted = objects.find((o) => o.id === 'p0_o1')!;
    expect(formatted.fontSize).toBe(24);
    expect(formatted.color).toBe('#FF3B30');
  });
});
