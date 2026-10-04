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
  buildPdfFormattingModel,
  PdfFormattingModel,
} from '../src/features/pdf/types';
import {
  calculatePdfTextFit,
  MINIMUM_SAFE_FONT_SIZE,
  reconcilePdfTextFormatting,
} from '../src/features/pdf/pdfLayoutFitting';
import {
  PdfBatchEditError,
  PdfInvalidFontSizeError,
  PdfInvalidColorError,
  PdfUnsupportedFormattingError,
  PdfInvalidObjectIdError,
  PdfInvalidObjectPathError,
  PdfDeletedObjectEditError,
} from '../src/errors';

describe('Phase 5 - PDF Existing-Text Formatting & Layout Fidelity', () => {
  const mockStandardRootObj: PdfTextObject = {
    id: 'p0_o1',
    pageIndex: 0,
    objectIndex: 1,
    objectPath: [1],
    text: 'Standard Document Title',
    bounds: { x: 50, y: 100, width: 220, height: 26 },
    pdfBounds: { left: 50, bottom: 666, right: 270, top: 692 },
    fontSize: 18,
    fontName: 'Helvetica',
    fontDetails: {
      baseFontName: 'Helvetica',
      familyName: 'Helvetica',
      isEmbedded: false,
      isSubset: false,
      weight: 400,
      flags: 0,
    },
    color: '#1C1C1E',
    colorRgba: { r: 28, g: 28, b: 30, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 666 },
    isEditable: true,
  };

  const mockRotatedObj: PdfTextObject = {
    id: 'p0_o2',
    pageIndex: 0,
    objectIndex: 2,
    objectPath: [2],
    text: 'Rotated Watermark',
    bounds: { x: 100, y: 200, width: 180, height: 30 },
    pdfBounds: { left: 100, bottom: 562, right: 280, top: 592 },
    fontSize: 16,
    fontName: 'Times-Roman',
    fontDetails: null,
    color: '#8E8E93',
    colorRgba: { r: 142, g: 142, b: 147, a: 255 },
    // 90 degree rotated matrix: a=0, b=1, c=-1, d=0
    matrix: { a: 0, b: 1, c: -1, d: 0, e: 100, f: 562 },
    isEditable: true,
  };

  const mockSubsetObj: PdfTextObject = {
    id: 'p0_o3',
    pageIndex: 0,
    objectIndex: 3,
    objectPath: [3],
    text: 'Custom Brand Tagline',
    bounds: { x: 50, y: 300, width: 200, height: 20 },
    pdfBounds: { left: 50, bottom: 472, right: 250, top: 492 },
    fontSize: 14,
    fontName: 'BAAAAA+BrandSans-Regular',
    fontDetails: {
      baseFontName: 'BAAAAA+BrandSans-Regular',
      familyName: 'BrandSans',
      isEmbedded: true,
      isSubset: true,
      weight: 400,
      flags: 4,
    },
    color: '#007AFF',
    colorRgba: { r: 0, g: 122, b: 255, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 472 },
    isEditable: true,
  };

  const mockNestedFormObj: PdfTextObject = {
    id: 'p0_form1_o4',
    pageIndex: 0,
    objectIndex: 4,
    objectPath: [1, 4],
    text: 'Table Cell Value',
    bounds: { x: 120, y: 400, width: 140, height: 16 },
    pdfBounds: { left: 120, bottom: 376, right: 260, top: 392 },
    fontSize: 12,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#333333',
    colorRgba: { r: 51, g: 51, b: 51, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 120, f: 376 },
    isEditable: true,
  };

  const mockDeepNestedFormObj: PdfTextObject = {
    id: 'p0_deep_o5',
    pageIndex: 0,
    objectIndex: 5,
    objectPath: [2, 1, 5],
    text: 'Deep Subform Label',
    bounds: { x: 150, y: 450, width: 130, height: 14 },
    pdfBounds: { left: 150, bottom: 328, right: 280, top: 342 },
    fontSize: 10,
    fontName: 'Helvetica',
    fontDetails: null,
    color: '#000000',
    colorRgba: { r: 0, g: 0, b: 0, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 150, f: 328 },
    isEditable: true,
  };

  class MockPdfEngine implements IPdfiumEngine {
    applyBatchEditsCalls: PdfBatchEditRequest[] = [];
    shouldFailApply = false;
    failMessage = 'Native replacement failed';

    async openDocument(filePath: string): Promise<PdfDocumentHandle> {
      return { docHandle: 1001, pageCount: 1, filePath };
    }
    async closeDocument(): Promise<boolean> {
      return true;
    }
    async getPageCount(): Promise<number> {
      return 1;
    }
    async getPageSize(): Promise<PdfPageSize> {
      return { pageIndex: 0, width: 612, height: 792 };
    }
    async renderPage(): Promise<PdfRenderedPage> {
      return {
        filePath: '/mock/render.png',
        uri: 'file:///mock/render.png',
        width: 612,
        height: 792,
        pageWidth: 612,
        pageHeight: 792,
        scale: 1,
        pageIndex: 0,
      };
    }
    async getTextObjects(): Promise<PdfTextObject[]> {
      return [
        { ...mockStandardRootObj },
        { ...mockRotatedObj },
        { ...mockSubsetObj },
        { ...mockNestedFormObj },
        { ...mockDeepNestedFormObj },
      ];
    }
    async extractAssetPdf(): Promise<string> {
      return '/mock/asset.pdf';
    }
    async replaceTextObject(): Promise<any> {
      throw new Error('Not used in Phase 5');
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
          sourceChecksumBefore: 'sha_src',
          sourceChecksumAfter: 'sha_src',
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
          limitations: ['Native error occurred'],
        };
      }

      return {
        outputPath: request.outputPdfPath,
        totalCommands: request.commands.length,
        appliedCommands: request.commands.length,
        pageCountBefore: 1,
        pageCountAfter: 1,
        sourceUnchanged: true,
        sourceChecksumBefore: 'sha_src',
        sourceChecksumAfter: 'sha_src',
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

  let engine: MockPdfEngine;
  let editor: PdfDocumentEditor;

  beforeEach(async () => {
    engine = new MockPdfEngine();
    editor = new PdfDocumentEditor(engine);
    await editor.open('/mock/source.pdf');
    await editor.getTextObjects(0);
  });

  // ==========================================
  // Section 1: Existing Formatting
  // ==========================================

  test('1. Read original formatting correctly into explicit formatting model', () => {
    const model: PdfFormattingModel = buildPdfFormattingModel(mockStandardRootObj);
    expect(model.objectId).toBe('p0_o1');
    expect(model.original.fontFamily).toBe('Helvetica');
    expect(model.original.fontSize).toBe(18);
    expect(model.original.fontWeight).toBe(400);
    expect(model.original.isItalic).toBe(false);
    expect(model.original.color).toBe('#1C1C1E');
    expect(model.original.bounds).toEqual(mockStandardRootObj.bounds);
    expect(model.original.matrix).toEqual(mockStandardRootObj.matrix);
    expect(model.original.baseline).toBe(666);
    expect(model.original.isEmbedded).toBe(false);
    expect(model.original.isSubset).toBe(false);
  });

  test('2. Preserve formatting when only text changes', async () => {
    editor.replaceText('p0_o1', 'Updated Title Without Formatting');
    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o1')!;

    expect(updated.text).toBe('Updated Title Without Formatting');
    expect(updated.fontSize).toBe(18); // Preserved
    expect(updated.color).toBe('#1C1C1E'); // Preserved
    expect(updated.fontName).toBe('Helvetica'); // Preserved
    expect(updated.bounds).toEqual(mockStandardRootObj.bounds); // Preserved
  });

  test('3. Supported font-size change is reflected in pending edits and optimistic state', async () => {
    editor.replaceText('p0_o1', 'Enlarged Title', { fontSize: 24 });
    const pending = editor.getPendingEdits();
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('replace');
    expect((pending[0] as any).format?.fontSize).toBe(24);

    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o1')!;
    expect(updated.fontSize).toBe(24);
  });

  test('4. Supported color change is reflected in pending edits and optimistic state', async () => {
    editor.replaceText('p0_o1', 'Blue Title', { color: '#007AFF' });
    const pending = editor.getPendingEdits();
    expect((pending[0] as any).format?.color).toBe('#007AFF');

    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o1')!;
    expect(updated.color).toBe('#007AFF');
  });

  test('5. Supported bold change resolves standard font on root object', async () => {
    editor.replaceText('p0_o1', 'Bold Title', { isBold: true });
    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o1')!;
    expect(updated.fontName).toBe('Helvetica-Bold');
  });

  test('6. Supported italic change resolves standard font on root object', async () => {
    editor.replaceText('p0_o1', 'Italic Title', { isItalic: true });
    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o1')!;
    expect(updated.fontName).toBe('Helvetica-Oblique');
  });

  test('7. Unsupported formatting rejection on embedded subset font throws typed error', () => {
    expect(() => {
      editor.replaceText('p0_o3', 'Modified Subset Text', {
        isBold: true,
      });
    }).toThrow(PdfUnsupportedFormattingError);
  });

  test('8. Transformation preservation on rotated text object', async () => {
    editor.replaceText('p0_o2', 'Rotated Text Formatted', {
      fontSize: 20,
      color: '#FF3B30',
    });
    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o2')!;
    expect(updated.matrix).toEqual(mockRotatedObj.matrix);
    expect(updated.matrix?.a).toBe(0);
    expect(updated.matrix?.b).toBe(1);
    expect(updated.matrix?.c).toBe(-1);
    expect(updated.matrix?.d).toBe(0);
  });

  test('9. Position preservation across formatting operations', async () => {
    editor.replaceText('p0_o1', 'Reposition Test', {
      fontSize: 16,
      color: '#34C759',
    });
    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_o1')!;
    expect(updated.bounds.x).toBe(mockStandardRootObj.bounds.x);
    expect(updated.bounds.y).toBe(mockStandardRootObj.bounds.y);
  });

  test('10. Baseline preservation in formatting model and bounds', () => {
    const model = buildPdfFormattingModel(mockStandardRootObj, { fontSize: 22 });
    expect(model.original.baseline).toBe(666);
    expect(model.original.bounds.height).toBe(26);
  });

  // ==========================================
  // Section 2: Layout & Conservative Text Fitting
  // ==========================================

  test('11. Short replacement text fits with PRESERVED state', () => {
    const fit = calculatePdfTextFit(
      mockStandardRootObj.bounds,
      'Standard Document Title',
      'Short Title',
      18,
    );
    expect(fit.state).toBe('PRESERVED');
    expect(fit.scaleFactor).toBe(1.0);
    expect(fit.fittedFontSize).toBe(18);
    expect(fit.isOverflowing).toBe(false);
  });

  test('12. Long replacement triggers SCALED_DOWN fitting state', () => {
    const fit = calculatePdfTextFit(
      mockStandardRootObj.bounds,
      'Standard Document Title',
      'A Significantly Longer Document Title That Exceeds The Original Width',
      18,
    );
    expect(fit.scaleFactor).toBeLessThan(1.0);
    expect(fit.fittedFontSize).toBeLessThan(18);
  });

  test('13. Conservative scaling floor (70% minimum) is enforced', () => {
    const fit = calculatePdfTextFit(
      mockStandardRootObj.bounds,
      'Brief',
      'Extremely long paragraph text replacement that would otherwise shrink to unreadable tiny print',
      20,
    );
    expect(fit.scaleFactor).toBe(0.70);
    expect(fit.fittedFontSize).toBe(14); // 20 * 0.70 = 14
  });

  test('14. Minimum safe font size rule (8pt floor) is enforced', () => {
    const fit = calculatePdfTextFit(
      mockStandardRootObj.bounds,
      'Word',
      'A moderately long replacement text string',
      9, // 9 * 0.70 = 6.3, but floor is 8pt
    );
    expect(fit.fittedFontSize).toBeGreaterThanOrEqual(MINIMUM_SAFE_FONT_SIZE);
    expect(fit.fittedFontSize).toBe(8);
  });

  test('15. Severe overflow is explicitly detected and marked OVERFLOW', () => {
    const fit = calculatePdfTextFit(
      { x: 50, y: 100, width: 60, height: 20 },
      'Hi',
      'This string is much longer than the 60px container width even at 70% scale',
      14,
    );
    expect(fit.isOverflowing).toBe(true);
    expect(fit.state).toBe('OVERFLOW');
  });

  test('16. Formatting + fitting interaction operates on requested font size', () => {
    const requestedFontSize = 24;
    const fit = calculatePdfTextFit(
      mockStandardRootObj.bounds,
      'Standard Document Title',
      'A Much Longer Replaced Heading At Larger Font Size',
      requestedFontSize,
    );
    expect(fit.fittedFontSize).toBeLessThan(requestedFontSize);
    expect(fit.scaleFactor).toBeGreaterThanOrEqual(0.70);
  });

  // ==========================================
  // Section 3: Nested Form XObjects
  // ==========================================

  test('17. Root-level formatting passes objectPath with single index', async () => {
    editor.replaceText('p0_o1', 'Root Object Edit', { fontSize: 20, color: '#FF9500' });
    const pending = editor.getPendingEdits();
    expect((pending[0] as any).objectPath).toEqual([1]);
  });

  test('18. Nested Form formatting preserves full objectPath and supports size and color', async () => {
    editor.replaceText('p0_form1_o4', 'Updated Cell', { fontSize: 14, color: '#007AFF' });
    const pending = editor.getPendingEdits();
    expect((pending[0] as any).objectPath).toEqual([1, 4]);

    const objects = await editor.getTextObjects(0);
    const updated = objects.find((o) => o.id === 'p0_form1_o4')!;
    expect(updated.fontSize).toBe(14);
    expect(updated.color).toBe('#007AFF');
  });

  test('19. Deep nested Form formatting targets multi-level path correctly', async () => {
    editor.replaceText('p0_deep_o5', 'Deep Label Edit', { fontSize: 11, color: '#34C759' });
    const pending = editor.getPendingEdits();
    expect((pending[0] as any).objectPath).toEqual([2, 1, 5]);
  });

  test('20. Invalid objectPath with negative index throws typed error on apply', async () => {
    const badObj: PdfTextObject = {
      ...mockNestedFormObj,
      id: 'bad_path_obj',
      objectPath: [1, -3],
    };
    (editor as any).textObjectsCache.set('bad_path_obj', badObj);

    await expect(
      editor.applyExistingTextReplacement(
        'bad_path_obj',
        'Valid Text',
        '/mock/working.pdf',
        { fontSize: 12 },
      ),
    ).rejects.toThrow(PdfInvalidObjectPathError);
  });

  test('21. Stale object protection rejects un-extracted object ID with typed error', () => {
    expect(() => {
      editor.replaceText('stale_unknown_id', 'New Text', { fontSize: 14 });
    }).toThrow(PdfInvalidObjectIdError);
  });

  // ==========================================
  // Section 4: Persistence Workflow
  // ==========================================

  test('22. Formatting survives save via Phase 4D pipeline', async () => {
    editor.replaceText('p0_o1', 'Saved Formatted Text', {
      fontSize: 22,
      color: '#FF3B30',
    });
    const saveRes = await editor.saveDocument('/mock/output.pdf');
    expect(saveRes.verified).toBe(true);
    expect(engine.applyBatchEditsCalls).toHaveLength(1);
    const cmd = engine.applyBatchEditsCalls[0].commands[0];
    expect((cmd as any).format?.fontSize).toBe(22);
    expect((cmd as any).format?.color).toBe('#FF3B30');
  });

  test('23. Formatting survives reopen reconciliation within tolerances', () => {
    const requested = { fontSize: 18, color: '#007AFF' };
    const reopenedTarget: PdfTextObject = {
      ...mockStandardRootObj,
      fontSize: 18.2, // Within 0.5pt tolerance
      color: '#007BFF', // Within colorComponent tolerance 2
    };

    const reconciliation = reconcilePdfTextFormatting(requested, reopenedTarget, {
      fontSize: 0.5,
      colorComponent: 2,
      matrix: 0.01,
    });

    expect(reconciliation.matches).toBe(true);
    expect(reconciliation.fontSizeMatches).toBe(true);
    expect(reconciliation.colorMatches).toBe(true);
    expect(reconciliation.differences).toHaveLength(0);
  });

  test('24. Text content survives formatting and is accurately encoded in replace command', () => {
    editor.replaceText('p0_o1', 'Text Content Intact', { fontSize: 16 });
    const pending = editor.getPendingEdits();
    expect((pending[0] as any).newText).toBe('Text Content Intact');
  });

  test('25. Delete regression: Deletion coexists with formatted replacement', async () => {
    editor.replaceText('p0_o1', 'Keep Me Formatted', { fontSize: 20 });
    editor.deleteText('p0_o2');
    const pending = editor.getPendingEdits();
    expect(pending).toHaveLength(2);
    expect(pending.some((c) => c.type === 'replace')).toBe(true);
    expect(pending.some((c) => c.type === 'delete')).toBe(true);
  });

  test('26. Add Text regression: Insertion with format coexists with formatted replacement', async () => {
    editor.replaceText('p0_o1', 'Existing Formatted', { fontSize: 18 });
    editor.insertText(0, 'Newly Inserted Text', { x: 50, y: 500 }, { fontSize: 14, color: '#34C759' });
    const pending = editor.getPendingEdits();
    expect(pending).toHaveLength(2);
    expect(pending.some((c) => c.type === 'replace')).toBe(true);
    expect(pending.some((c) => c.type === 'insert')).toBe(true);
  });

  test('27. Existing Edit regression: Plain text edit without format still functions perfectly', async () => {
    editor.replaceText('p0_o1', 'Pure Text Only');
    const pending = editor.getPendingEdits();
    expect((pending[0] as any).format).toBeUndefined();
    expect((pending[0] as any).newText).toBe('Pure Text Only');
  });

  test('28. Source immutability: Saving to source path is strictly rejected', async () => {
    editor.replaceText('p0_o1', 'Should Not Overwrite', { fontSize: 16 });
    await expect(editor.saveDocument('/mock/source.pdf')).rejects.toThrow(PdfBatchEditError);
  });

  // ==========================================
  // Section 5: Failure Handling
  // ==========================================

  test('29. Native formatting failure preserves state and throws appropriate error', async () => {
    engine.shouldFailApply = true;
    engine.failMessage = 'Native replacement failed';

    await expect(
      editor.applyExistingTextReplacement(
        'p0_o1',
        'Fail Text',
        '/mock/working.pdf',
        { fontSize: 16 },
      ),
    ).rejects.toThrow();
  });

  test('30. Save failure preserves dirty state and marks SAVE_FAILED', async () => {
    engine.shouldFailApply = true;
    editor.replaceText('p0_o1', 'Fail Save Text', { fontSize: 20 });
    expect(editor.isDirty()).toBe(true);

    try {
      await editor.saveDocument('/mock/output.pdf');
    } catch {
      // Expected save failure
    }

    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
  });

  test('31. Reopen verification failure preserves recoverability', () => {
    const requested = { fontSize: 24, color: '#FF0000' };
    const corruptedReopenedObj: PdfTextObject = {
      ...mockStandardRootObj,
      fontSize: 12, // Major mismatch > 0.5
      color: '#000000', // Major mismatch
    };

    const reconciliation = reconcilePdfTextFormatting(requested, corruptedReopenedObj);
    expect(reconciliation.matches).toBe(false);
    expect(reconciliation.fontSizeMatches).toBe(false);
    expect(reconciliation.colorMatches).toBe(false);
    expect(reconciliation.differences.length).toBeGreaterThan(0);
  });

  test('32. Unsupported formatting does not mutate PDF or add pending edits', () => {
    expect(() => {
      // Attempt unsupported style change on nested form object
      editor.replaceText('p0_form1_o4', 'Invalid Change', { isBold: true });
    }).toThrow(PdfUnsupportedFormattingError);

    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(editor.isDirty()).toBe(false);
  });

  // ==========================================
  // Section 6: Undo / Redo
  // ==========================================

  test('33. Formatting undo restores previous text and previous format', async () => {
    editor.replaceText('p0_o1', 'First Edit', { fontSize: 20, color: '#FF3B30' });
    editor.replaceText('p0_o1', 'Second Edit', { fontSize: 24, color: '#007AFF' });

    let objects = await editor.getTextObjects(0);
    expect(objects.find((o) => o.id === 'p0_o1')!.fontSize).toBe(24);

    editor.undo();
    objects = await editor.getTextObjects(0);
    const reverted = objects.find((o) => o.id === 'p0_o1')!;
    expect(reverted.text).toBe('First Edit');
    expect(reverted.fontSize).toBe(20);
    expect(reverted.color).toBe('#FF3B30');

    editor.undo();
    objects = await editor.getTextObjects(0);
    const original = objects.find((o) => o.id === 'p0_o1')!;
    expect(original.text).toBe('Standard Document Title');
    expect(original.fontSize).toBe(18);
    expect(original.color).toBe('#1C1C1E');
  });

  test('34. Formatting redo restores newly applied formatting accurately', async () => {
    editor.replaceText('p0_o1', 'New Heading', { fontSize: 22, color: '#34C759' });
    editor.undo();
    editor.redo();

    const objects = await editor.getTextObjects(0);
    const restored = objects.find((o) => o.id === 'p0_o1')!;
    expect(restored.text).toBe('New Heading');
    expect(restored.fontSize).toBe(22);
    expect(restored.color).toBe('#34C759');
  });
});
