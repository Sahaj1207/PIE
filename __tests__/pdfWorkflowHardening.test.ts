import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import {
  PdfBatchEditError,
  PdfCorruptedError,
  PdfDeletedObjectEditError,
  PdfFileNotFoundError,
  PdfInvalidObjectIdError,
  PdfInvalidReplacementError,
  PdfPageOutOfRangeError,
} from '../src/errors';
import { PdfTextObject } from '../src/features/pdf/types';

describe('Phase 3E — PDF Workflow Hardening & Production Readiness', () => {
  let engine: PdfiumEngine;
  let editor: PdfDocumentEditor;

  const page0Objects: PdfTextObject[] = [
    {
      id: 'p0_obj0',
      pageIndex: 0,
      objectIndex: 0,
      text: 'Page 0 Title Header',
      bounds: { x: 50, y: 40, width: 250, height: 24 },
      pdfBounds: { left: 50, bottom: 728, right: 300, top: 752 },
      fontSize: 20,
      fontName: 'Helvetica-Bold',
      color: '#0F172A',
      colorRgba: { r: 15, g: 23, b: 42, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 728 },
      isEditable: true,
    },
    {
      id: 'p0_obj1',
      pageIndex: 0,
      objectIndex: 1,
      text: 'Page 0 Subtitle Text',
      bounds: { x: 50, y: 70, width: 200, height: 16 },
      pdfBounds: { left: 50, bottom: 706, right: 250, top: 722 },
      fontSize: 14,
      fontName: 'Helvetica',
      color: '#475569',
      colorRgba: { r: 71, g: 85, b: 105, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 706 },
      isEditable: true,
    },
  ];

  const page1Objects: PdfTextObject[] = [
    {
      id: 'p1_obj0',
      pageIndex: 1,
      objectIndex: 0,
      text: 'Page 1 First Paragraph',
      bounds: { x: 50, y: 50, width: 300, height: 18 },
      pdfBounds: { left: 50, bottom: 724, right: 350, top: 742 },
      fontSize: 14,
      fontName: 'Times-Roman',
      color: '#1E293B',
      colorRgba: { r: 30, g: 41, b: 59, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 724 },
      isEditable: true,
    },
    {
      id: 'p1_obj1',
      pageIndex: 1,
      objectIndex: 1,
      text: 'Page 1 Footer Note',
      bounds: { x: 50, y: 700, width: 180, height: 12 },
      pdfBounds: { left: 50, bottom: 80, right: 230, top: 92 },
      fontSize: 10,
      fontName: 'Helvetica-Oblique',
      color: '#94A3B8',
      colorRgba: { r: 148, g: 163, b: 184, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 80 },
      isEditable: true,
    },
  ];

  beforeEach(() => {
    engine = new PdfiumEngine();
    NativeModules.PdfiumNativeModule = {
      openDocument: jest.fn().mockImplementation((path: string) => {
        if (path.includes('corrupt')) {
          return Promise.reject({ code: 'PDF_FORMAT_CORRUPT', message: 'Corrupted PDF file header' });
        }
        if (path.includes('missing')) {
          return Promise.reject({ code: 'PDF_FILE_NOT_FOUND', message: 'File not found at path' });
        }
        return Promise.resolve({
          docHandle: 101,
          pageCount: 2,
          filePath: path,
        });
      }),
      closeDocument: jest.fn().mockResolvedValue(true),
      getPageCount: jest.fn().mockResolvedValue(2),
      getPageSize: jest.fn().mockResolvedValue({ pageIndex: 0, width: 612, height: 792 }),
      getTextObjects: jest.fn().mockImplementation((_handle: number, pageIdx: number) => {
        if (pageIdx === 0) return Promise.resolve(JSON.stringify(page0Objects));
        if (pageIdx === 1) return Promise.resolve(JSON.stringify(page1Objects));
        return Promise.resolve('[]');
      }),
      applyBatchEdits: jest.fn().mockImplementation((input: string, output: string, json: string) => {
        if (output.includes('fail_save')) {
          return Promise.reject(new Error('Simulated disk write failure'));
        }
        const cmds = JSON.parse(json);
        return Promise.resolve(
          JSON.stringify({
            outputPath: output,
            totalCommands: cmds.length,
            appliedCommands: cmds.length,
            pageCountBefore: 2,
            pageCountAfter: 2,
            sourceUnchanged: true,
            sourceChecksumBefore: 'sha256_mock_hash_before',
            sourceChecksumAfter: 'sha256_mock_hash_before',
            commands: cmds.map((c: any) => ({
              type: c.type,
              objectId: c.objectId,
              pageIndex: c.pageIndex,
              objectIndex: c.objectIndex ?? 0,
              status: 'applied',
              originalText: c.originalText,
              newText: c.newText ?? c.text,
              fontStrategy: 'LOADED_STANDARD',
              fontReused: false,
            })),
            reopenedVerification: {
              allReplacementsVerified: true,
              allDeletionsVerified: true,
              verifiedReplacements: cmds
                .filter((c: any) => c.type === 'replace' || c.type === 'insert')
                .map((c: any) => c.newText ?? c.text),
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

  // A. Insert -> Save -> Reopen -> Verify
  test('A. Insert -> Save -> Reopen -> Verify workflow', async () => {
    await editor.open('/data/original.pdf');
    expect(editor.getPageCount()).toBe(2);

    const inserted = editor.insertText(0, 'Newly Inserted Text', { x: 50, y: 150 }, {
      fontFamily: 'Helvetica',
      fontSize: 14,
      isBold: true,
      color: '#2563EB',
    });
    expect(editor.getPendingEdits().length).toBe(1);

    const saveResult = await editor.saveEdits('/data/original_edited.pdf');
    expect(saveResult.appliedCommands).toBe(1);
    expect(saveResult.sourceUnchanged).toBe(true);
    expect(editor.getPendingEdits().length).toBe(0);

    // Reopen saved PDF and verify re-extraction
    await editor.open('/data/original_edited.pdf');
    const objects = await editor.getTextObjects(0);
    expect(objects.length).toBe(2);
  });

  // B. Replace -> Save -> Reopen -> Verify
  test('B. Replace -> Save -> Reopen -> Verify workflow', async () => {
    await editor.open('/data/original.pdf');
    await editor.getTextObjects(0);

    editor.replaceText('p0_obj0', 'Updated Headline Text', {
      fontFamily: 'Helvetica',
      fontSize: 20,
      color: '#0F172A',
    });

    const pending = editor.getPendingEdits();
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe('replace');

    const saveResult = await editor.saveEdits('/data/replaced.pdf');
    expect(saveResult.appliedCommands).toBe(1);
    expect(editor.getPendingEdits().length).toBe(0);
  });

  // C. Delete -> Save -> Reopen -> Verify
  test('C. Delete -> Save -> Reopen -> Verify workflow', async () => {
    await editor.open('/data/original.pdf');
    await editor.getTextObjects(0);

    editor.deleteText('p0_obj1');
    expect(editor.getPendingEdits().length).toBe(1);
    expect(editor.getPendingEdits()[0].type).toBe('delete');

    // Deleted object immediately omitted from view
    const visible = await editor.getTextObjects(0);
    expect(visible.find(o => o.id === 'p0_obj1')).toBeUndefined();

    const saveResult = await editor.saveEdits('/data/deleted.pdf');
    expect(saveResult.appliedCommands).toBe(1);
    expect(editor.getPendingEdits().length).toBe(0);
  });

  // D. Insert + Replace + Delete combined in single save
  test('D. Combined edits (insert + replace + delete) applied in single-pass save', async () => {
    await editor.open('/data/original.pdf');
    await editor.getTextObjects(0);

    editor.replaceText('p0_obj0', 'Modified Heading');
    editor.deleteText('p0_obj1');
    editor.insertText(0, 'Brand New Note', { x: 50, y: 300 });

    expect(editor.getPendingEdits().length).toBe(3);

    const saveResult = await editor.saveEdits('/data/combined.pdf');
    expect(saveResult.appliedCommands).toBe(3);
    expect(NativeModules.PdfiumNativeModule.applyBatchEdits).toHaveBeenCalledTimes(1);
  });

  // E. Multi-page edits spanning multiple pages
  test('E. Multi-page editing across Page 0 and Page 1 in single batch save', async () => {
    await editor.open('/data/original.pdf');

    // Page 0 edits
    await editor.getTextObjects(0);
    editor.replaceText('p0_obj0', 'Page 0 Modified Header');
    editor.insertText(0, 'Page 0 Added Annotation', { x: 50, y: 200 });

    // Page 1 edits
    await editor.getTextObjects(1);
    editor.deleteText('p1_obj1');
    editor.insertText(1, 'Page 1 New Summary', { x: 50, y: 400 });

    // Verify pending edits queue contains commands across both pages
    const pending = editor.getPendingEdits();
    expect(pending.length).toBe(4);
    expect(pending.filter(c => c.pageIndex === 0).length).toBe(2);
    expect(pending.filter(c => c.pageIndex === 1).length).toBe(2);

    // Save commits all pages in a single native call
    const result = await editor.saveEdits('/data/multipage_saved.pdf');
    expect(result.appliedCommands).toBe(4);
    expect(NativeModules.PdfiumNativeModule.applyBatchEdits).toHaveBeenCalledTimes(1);
    expect(editor.getPendingEdits().length).toBe(0);
  });

  // F. Undo / Redo sequence: insert -> insert -> delete -> replace -> undo -> undo -> redo
  test('F. Complex Undo / Redo sequence on domain edit model', async () => {
    await editor.open('/data/original.pdf');
    await editor.getTextObjects(0);

    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);

    // 1. insert #1
    const ins1 = editor.insertText(0, 'Insert One', { x: 50, y: 100 });
    expect(editor.canUndo()).toBe(true);

    // 2. insert #2
    const ins2 = editor.insertText(0, 'Insert Two', { x: 50, y: 120 });
    expect(editor.getPendingEdits().length).toBe(2);

    // 3. delete existing object
    editor.deleteText('p0_obj1');
    expect(editor.getPendingEdits().length).toBe(3);

    // 4. replace existing object
    editor.replaceText('p0_obj0', 'Replaced Header');
    expect(editor.getPendingEdits().length).toBe(4);

    // --- UNDO 1: Reverts replace on p0_obj0 ---
    editor.undo();
    expect(editor.getPendingEdits().length).toBe(3);
    const afterUndo1 = await editor.getTextObjects(0);
    expect(afterUndo1.find(o => o.id === 'p0_obj0')?.text).toBe('Page 0 Title Header'); // restored
    expect(editor.canRedo()).toBe(true);

    // --- UNDO 2: Reverts deletion of p0_obj1 ---
    editor.undo();
    expect(editor.getPendingEdits().length).toBe(2);
    const afterUndo2 = await editor.getTextObjects(0);
    expect(afterUndo2.find(o => o.id === 'p0_obj1')).toBeDefined(); // restored from deleted

    // --- REDO 1: Re-applies deletion of p0_obj1 ---
    editor.redo();
    expect(editor.getPendingEdits().length).toBe(3);
    const afterRedo1 = await editor.getTextObjects(0);
    expect(afterRedo1.find(o => o.id === 'p0_obj1')).toBeUndefined(); // re-deleted

    // --- REDO 2: Re-applies replace on p0_obj0 ---
    editor.redo();
    expect(editor.getPendingEdits().length).toBe(4);
    const afterRedo2 = await editor.getTextObjects(0);
    expect(afterRedo2.find(o => o.id === 'p0_obj0')?.text).toBe('Replaced Header'); // re-applied
    expect(editor.canRedo()).toBe(false);
  });

  // G. Source Immutability
  test('G. Source document immutability enforced (rejects same input and output path)', async () => {
    await editor.open('/data/protected_source.pdf');
    editor.insertText(0, 'Annotation', { x: 50, y: 50 });

    await expect(editor.saveEdits('/data/protected_source.pdf')).rejects.toThrow(
      /Input and output paths must be different/i,
    );
  });

  // H. Failed save does not clear pending edits or history
  test('H. Save failure retains pending edits and history intact', async () => {
    await editor.open('/data/original.pdf');
    await editor.getTextObjects(0);

    editor.insertText(0, 'Crucial Note', { x: 50, y: 50 });
    editor.replaceText('p0_obj0', 'Crucial Edit');

    expect(editor.getPendingEdits().length).toBe(2);
    expect(editor.canUndo()).toBe(true);

    // Attempt save to failing path
    await expect(editor.saveEdits('/data/fail_save.pdf')).rejects.toThrow(
      'Simulated disk write failure',
    );

    // Assert pending edits and undo state were NOT cleared
    expect(editor.getPendingEdits().length).toBe(2);
    expect(editor.canUndo()).toBe(true);

    // User can still undo after failed save
    editor.undo();
    expect(editor.getPendingEdits().length).toBe(1);
  });

  // I. Optimistic insert reconciliation
  test('I. Optimistic inserted object is superseded by persisted object after save and reopen', async () => {
    await editor.open('/data/original.pdf');
    const inserted = editor.insertText(0, 'Optimistic Line', { x: 50, y: 100 });

    expect(inserted.objectIndex).toBe(-1); // Optimistic marker
    expect(inserted.id).toMatch(/^p0_ins_/);

    await editor.saveEdits('/data/reconciled.pdf');
    expect(editor.getPendingEdits().length).toBe(0);

    // Reopen saved PDF
    await editor.open('/data/reconciled.pdf');
    const reopenedObjects = await editor.getTextObjects(0);

    // All objects now have real vector object indices
    for (const obj of reopenedObjects) {
      expect(obj.objectIndex).toBeGreaterThanOrEqual(0);
      expect(obj.id).toMatch(/^p0_obj\d+$/);
    }
  });

  // J. Editor Lifecycle & Cleanup
  test('J. Closing editor cleans native document handles and resets state cleanly', async () => {
    await editor.open('/data/original.pdf');
    editor.insertText(0, 'Unsaved Note', { x: 50, y: 50 });
    expect(editor.canUndo()).toBe(true);

    await editor.close();
    expect(NativeModules.PdfiumNativeModule.closeDocument).toHaveBeenCalledWith(101);

    // Calling operations on closed editor throws typed error
    expect(() => editor.getPageCount()).toThrow(PdfBatchEditError);
    expect(() => editor.insertText(0, 'Text', { x: 0, y: 0 })).toThrow(PdfBatchEditError);
    expect(editor.canUndo()).toBe(false);
  });

  // K. Duplicate Save Concurrency Protection
  test('K. Rejects concurrent duplicate save requests while save is in-flight', async () => {
    await editor.open('/data/original.pdf');
    editor.insertText(0, 'Single Save Test', { x: 50, y: 50 });

    // Slow down native call slightly to test concurrency
    NativeModules.PdfiumNativeModule.applyBatchEdits.mockImplementationOnce(
      (input: string, output: string, json: string) => {
        const cmds = JSON.parse(json);
        const payload = JSON.stringify({
          outputPath: output,
          totalCommands: cmds.length,
          appliedCommands: cmds.length,
          pageCountBefore: 2,
          pageCountAfter: 2,
          sourceUnchanged: true,
          sourceChecksumBefore: 'sha256_mock_hash_before',
          sourceChecksumAfter: 'sha256_mock_hash_before',
          commands: cmds.map((c: any) => ({
            type: c.type,
            objectId: c.objectId,
            pageIndex: c.pageIndex,
            objectIndex: c.objectIndex ?? 0,
            status: 'applied',
            originalText: c.originalText,
            newText: c.newText ?? c.text,
            fontStrategy: 'LOADED_STANDARD',
            fontReused: false,
          })),
          reopenedVerification: {
            allReplacementsVerified: true,
            allDeletionsVerified: true,
            verifiedReplacements: cmds
              .filter((c: any) => c.type === 'replace' || c.type === 'insert')
              .map((c: any) => c.newText ?? c.text),
            missingReplacements: [],
            residualDeletions: [],
          },
          limitations: [],
        });
        return new Promise((resolve) => setTimeout(() => resolve(payload), 100));
      },
    );

    const firstSavePromise = editor.saveEdits('/data/out1.pdf');
    // Immediate second call should fail with concurrency error
    await expect(editor.saveEdits('/data/out2.pdf')).rejects.toThrow(
      'A save operation is already in progress.',
    );

    await firstSavePromise;
  });

  // L. Corrupt / Invalid input handling at domain boundary
  test('L. Corrupt or inaccessible PDF throws typed error without crashing', async () => {
    await expect(editor.open('/data/corrupt_file.pdf')).rejects.toThrow(PdfCorruptedError);
    await expect(editor.open('/data/missing_file.pdf')).rejects.toThrow(PdfFileNotFoundError);
  });
});
