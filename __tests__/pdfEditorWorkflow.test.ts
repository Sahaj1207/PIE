import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor, resolveStandardFontName } from '../src/features/pdf/pdfDocumentEditor';

describe('Phase 3D — PDF Editor Complete Workflow', () => {
  let engine: PdfiumEngine;
  let editor: PdfDocumentEditor;

  const mockExistingObjects = [
    {
      id: 'p0_obj0',
      pageIndex: 0,
      objectIndex: 0,
      text: 'Original Heading Text',
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
      text: 'Paragraph to be deleted',
      bounds: { x: 54, y: 90, width: 220, height: 16 },
      pdfBounds: { left: 54, bottom: 686, right: 274, top: 702 },
      fontSize: 14,
      fontName: 'Helvetica',
      color: '#475569',
      colorRgba: { r: 71, g: 85, b: 105, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 54, f: 686 },
      isEditable: true,
    },
  ];

  beforeEach(() => {
    engine = new PdfiumEngine();
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockResolvedValue({
        docHandle: 42,
        pageCount: 2,
        filePath: '/data/sample.pdf',
      }),
      closeDocument: jest.fn().mockResolvedValue(true),
      getPageCount: jest.fn().mockResolvedValue(2),
      getPageSize: jest.fn().mockResolvedValue({ pageIndex: 0, width: 612, height: 792 }),
      getTextObjects: jest.fn().mockResolvedValue(JSON.stringify(mockExistingObjects)),
      applyBatchEdits: jest.fn().mockImplementation((input, output, json) => {
        const cmds = JSON.parse(json);
        return Promise.resolve(
          JSON.stringify({
            outputPath: output,
            totalCommands: cmds.length,
            appliedCommands: cmds.length,
            pageCountBefore: 2,
            pageCountAfter: 2,
            sourceUnchanged: true,
            sourceChecksumBefore: 'dummy_hash',
            sourceChecksumAfter: 'dummy_hash',
            commands: cmds.map((c: any) => ({
              type: c.type,
              objectId: c.objectId,
              pageIndex: c.pageIndex,
              objectIndex: c.objectIndex ?? 0,
              status: 'applied',
              originalText: c.originalText,
              newText: c.newText ?? c.text,
            })),
            reopenedVerification: {
              allReplacementsVerified: true,
              allDeletionsVerified: true,
              allInsertionsVerified: true,
              verifiedReplacements: cmds.filter((c: any) => c.type === 'replace').map((c: any) => c.newText),
              missingReplacements: [],
              residualDeletions: [],
            },
            limitations: [],
          }),
        );
      }),
    };
    editor = new PdfDocumentEditor(engine);
  });

  afterEach(() => {
    delete NativeModules.PdfiumNativeModule;
  });

  test('Standard font name mapping handles combinations of families and styles', () => {
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: false, isItalic: false })).toBe('Helvetica');
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: true, isItalic: false })).toBe('Helvetica-Bold');
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: false, isItalic: true })).toBe('Helvetica-Oblique');
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: true, isItalic: true })).toBe('Helvetica-BoldOblique');

    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: false, isItalic: false })).toBe('Times-Roman');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: true, isItalic: false })).toBe('Times-Bold');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: false, isItalic: true })).toBe('Times-Italic');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: true, isItalic: true })).toBe('Times-BoldItalic');

    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: false, isItalic: false })).toBe('Courier');
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: true, isItalic: false })).toBe('Courier-Bold');
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: false, isItalic: true })).toBe('Courier-Oblique');
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: true, isItalic: true })).toBe('Courier-BoldOblique');
  });

  test('Full multi-operation workflow: Replace + Delete + Insert committed in single batch save', async () => {
    await editor.open('/data/sample.pdf');

    // 1. Initial page text objects extraction
    const initialObjs = await editor.getTextObjects(0);
    expect(initialObjs.length).toBe(2);

    // 2. Queue text replacement on Object A with custom formatting
    editor.replaceText('p0_obj0', 'Updated Headline 2026', {
      fontFamily: 'Helvetica',
      fontSize: 28,
      isBold: true,
      color: '#2563EB',
    });

    // 3. Queue text deletion on Object B
    editor.deleteText('p0_obj1');

    // 4. Queue text insertion (New Object C)
    const insertedObj = editor.insertText(
      0,
      'Newly Inserted Disclaimer Text',
      { x: 54, y: 700 },
      {
        fontFamily: 'Times-Roman',
        fontSize: 12,
        isItalic: true,
        color: '#64748B',
      },
    );

    expect(insertedObj.id).toMatch(/^p0_ins_/);
    expect(insertedObj.text).toBe('Newly Inserted Disclaimer Text');

    // 5. Verify optimistic view: Object A is updated, Object B is omitted, Object C is appended
    const optimisticObjs = await editor.getTextObjects(0);
    expect(optimisticObjs.length).toBe(2); // (1 replaced + 0 deleted + 1 inserted)
    expect(optimisticObjs[0].text).toBe('Updated Headline 2026');
    expect(optimisticObjs[0].color).toBe('#2563EB');
    expect(optimisticObjs[1].id).toBe(insertedObj.id);

    // 6. Verify pending edits queue before saving
    const pending = editor.getPendingEdits();
    expect(pending.length).toBe(3);
    expect(pending[0].type).toBe('replace');
    expect(pending[1].type).toBe('delete');
    expect(pending[2].type).toBe('insert');

    // 7. Save once
    const saveResult = await editor.saveEdits('/data/sample_edited.pdf');
    expect(NativeModules.PdfiumNativeModule.applyBatchEdits).toHaveBeenCalledTimes(1);
    expect(saveResult.appliedCommands).toBe(3);
    expect(saveResult.sourceUnchanged).toBe(true);

    // 8. Pending edits cleared after save
    expect(editor.getPendingEdits().length).toBe(0);
  });

  test('Editing a pending inserted object updates its in-memory representation and insert command', async () => {
    await editor.open('/data/sample.pdf');
    await editor.getTextObjects(0);

    const inserted = editor.insertText(0, 'Initial Insert', { x: 100, y: 100 });
    expect(inserted.text).toBe('Initial Insert');

    // Replace text on the inserted object before saving
    editor.replaceText(inserted.id, 'Corrected Insert Text', { fontSize: 16 });

    const visibleObjs = await editor.getTextObjects(0);
    const insFound = visibleObjs.find(o => o.id === inserted.id);
    expect(insFound?.text).toBe('Corrected Insert Text');
    expect(insFound?.fontSize).toBe(16);

    const pending = editor.getPendingEdits();
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe('insert');
    if (pending[0].type === 'insert') {
      expect(pending[0].text).toBe('Corrected Insert Text');
      expect(pending[0].fontSize).toBe(16);
    }
  });

  test('Deleting a pending inserted object removes it completely from pending queue', async () => {
    await editor.open('/data/sample.pdf');
    await editor.getTextObjects(0);

    const inserted = editor.insertText(0, 'Temporary Note', { x: 100, y: 100 });
    expect(editor.getPendingEdits().length).toBe(1);

    // Delete before saving
    editor.deleteText(inserted.id);
    expect(editor.getPendingEdits().length).toBe(0);

    const visibleObjs = await editor.getTextObjects(0);
    expect(visibleObjs.find(o => o.id === inserted.id)).toBeUndefined();
  });

  test('Audit 1: Bold, Italic, and font family mapping to exact PostScript standard font faces', () => {
    // Helvetica family
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: false, isItalic: false })).toBe('Helvetica');
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: true, isItalic: false })).toBe('Helvetica-Bold');
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: false, isItalic: true })).toBe('Helvetica-Oblique');
    expect(resolveStandardFontName({ fontFamily: 'Helvetica', isBold: true, isItalic: true })).toBe('Helvetica-BoldOblique');

    // Times family
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: false, isItalic: false })).toBe('Times-Roman');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: true, isItalic: false })).toBe('Times-Bold');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: false, isItalic: true })).toBe('Times-Italic');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman', isBold: true, isItalic: true })).toBe('Times-BoldItalic');

    // Courier family
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: false, isItalic: false })).toBe('Courier');
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: true, isItalic: false })).toBe('Courier-Bold');
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: false, isItalic: true })).toBe('Courier-Oblique');
    expect(resolveStandardFontName({ fontFamily: 'Courier', isBold: true, isItalic: true })).toBe('Courier-BoldOblique');
  });

  test('Audit 2: Distinction between newly inserted text formatting vs existing text replacement', async () => {
    await editor.open('/data/sample.pdf');
    await editor.getTextObjects(0);

    // Case A: Newly inserted text queues explicit formatting
    const inserted = editor.insertText(
      0,
      'New Vector Text',
      { x: 72, y: 144 },
      {
        fontFamily: 'Courier',
        fontSize: 18,
        isBold: true,
        isItalic: true,
        color: '#DC2626',
      },
    );
    expect(inserted.fontName).toBe('Courier-BoldOblique');
    expect(inserted.fontSize).toBe(18);
    expect(inserted.color).toBe('#DC2626');

    // Case B: Existing text replacement queues text change
    editor.replaceText('p0_obj0', 'Changed Existing Text', {
      fontFamily: 'Times-Roman',
      fontSize: 20,
      isBold: true,
      color: '#2563EB',
    });

    const pending = editor.getPendingEdits();
    const insertCmd = pending.find(c => c.type === 'insert');
    const replaceCmd = pending.find(c => c.type === 'replace');

    // Insert command contains resolved font and colors for native PDFium creation
    expect(insertCmd).toBeDefined();
    if (insertCmd && insertCmd.type === 'insert') {
      expect(insertCmd.fontName).toBe('Courier-BoldOblique');
      expect(insertCmd.fontSize).toBe(18);
      expect(insertCmd.color).toBe('#DC2626');
    }

    // Replace command contains newText and target objectIndex
    expect(replaceCmd).toBeDefined();
    if (replaceCmd && replaceCmd.type === 'replace') {
      expect(replaceCmd.newText).toBe('Changed Existing Text');
      expect(replaceCmd.objectIndex).toBe(0);
    }
  });

  test('Audit 3: Coordinate transformation preserves Y-axis direction without inversion', async () => {
    await editor.open('/data/sample.pdf');
    const pageSize = await editor.getPageSize(0);
    expect(pageSize.height).toBe(792);

    // Insert text at document top-left position (x: 54, y: 100)
    const docX = 54;
    const docY = 100;
    const fontSize = 14;
    const inserted = editor.insertText(0, 'Coordinate Test', { x: docX, y: docY }, { fontSize });

    // Document coordinates: origin top-left, increasing downwards
    expect(inserted.bounds.x).toBe(54);
    expect(inserted.bounds.y).toBe(100);

    // PDF user space: origin bottom-left, increasing upwards
    // Expected pdfY = pageHeight - (docY + fontSize) = 792 - 114 = 678
    expect(inserted.pdfBounds.left).toBe(docX);
    expect(inserted.pdfBounds.bottom).toBe(792 - (docY + fontSize));
    expect(inserted.pdfBounds.bottom).toBe(678);

    // Verify reverse conversion: docTop = pageHeight - pdfTop
    const calculatedDocTop = pageSize.height - inserted.pdfBounds.top;
    expect(calculatedDocTop).toBeLessThanOrEqual(docY);
  });
});
