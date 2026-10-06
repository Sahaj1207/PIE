/**
 * Phase 11 — TS <-> native PDF batch result contract.
 *
 * Fixtures in __tests__/fixtures/native-*.json reproduce the JSON emitted by
 * android/app/src/main/cpp/pdfium/pdfium_bridge.cpp (nativeApplyBatchEditsJson /
 * nativeReplaceTextObjectJson), passed through NativePdfiumModule.kt unchanged.
 */
import { NativeModules } from 'react-native';
import {
  PdfiumEngine,
  normalizeNativeBatchResult,
  nativeFailureToError,
} from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import {
  PdfBatchEditError,
  PdfCorruptedError,
  PdfFileNotFoundError,
  PdfInvalidObjectPathError,
  PdfPageOutOfRangeError,
  PdfSaveError,
  PdfTextDeletionError,
  PdfTextInsertionError,
} from '../src/errors';

const realSuccess = require('./fixtures/native-batch-success.json');
const realCommandFailed = require('./fixtures/native-batch-command-failed.json');
const realUnverified = require('./fixtures/native-batch-unverified.json');
const realError = require('./fixtures/native-batch-error.json');
const realCopy = require('./fixtures/native-copy-success.json');
const realSingleReplace = require('./fixtures/native-replace-single-success.json');

const pageObjects = [
  {
    id: 'p0_path0',
    pageIndex: 0,
    objectIndex: 0,
    objectPath: [0],
    text: 'Header',
    bounds: { x: 50, y: 60, width: 200, height: 20 },
    pdfBounds: { left: 50, bottom: 712, right: 250, top: 732 },
    fontSize: 14,
    fontName: 'Helvetica',
    color: '#000000',
    colorRgba: { r: 0, g: 0, b: 0, a: 255 },
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 712 },
    isEditable: true,
  },
];

function installNative(applyBatchEdits: jest.Mock) {
  (NativeModules as any).PdfiumNativeModule = {
    openDocument: jest.fn().mockImplementation((path: string) =>
      Promise.resolve({ docHandle: 7, pageCount: 1, filePath: path }),
    ),
    closeDocument: jest.fn().mockResolvedValue(true),
    getPageCount: jest.fn().mockResolvedValue(1),
    getPageSize: jest.fn().mockResolvedValue({ pageIndex: 0, width: 612, height: 792 }),
    getTextObjects: jest.fn().mockResolvedValue(JSON.stringify(pageObjects)),
    applyBatchEdits,
    replaceTextObject: jest.fn().mockResolvedValue(JSON.stringify(realSingleReplace)),
  };
}

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('Phase 11 — native batch result contract', () => {
  describe('1. Canonical normalization of the REAL native shape', () => {
    it('maps commandResults/applied/verifiedInReopened/sourceSha* into PdfMultiEditResult', () => {
      const result = normalizeNativeBatchResult(realSuccess, { outputPdfPath: '/x.pdf', commandCount: 3 });

      expect(result.outputPath).toBe(realSuccess.outputPath);
      expect(result.totalCommands).toBe(3);
      expect(result.appliedCommands).toBe(3);
      expect(result.sourceUnchanged).toBe(true);
      expect(result.sourceChecksumBefore).toBe(realSuccess.sourceShaBefore);
      expect(result.sourceChecksumAfter).toBe(realSuccess.sourceShaAfter);
      expect(result.pageCountBefore).toBe(2);
      expect(result.commands.map((c) => c.status)).toEqual(['applied', 'applied', 'applied']);
      expect(result.commands.map((c) => c.type)).toEqual(['replace', 'delete', 'insert']);
      expect(result.commands[1].objectId).toBe('p0_path1_0_3');
      expect(result.commands.every((c) => c.error === undefined)).toBe(true);
      expect(result.reopenedVerification.allReplacementsVerified).toBe(true);
      expect(result.reopenedVerification.allDeletionsVerified).toBe(true);
      expect(result.reopenedVerification.allInsertionsVerified).toBe(true);
      expect(result.reopenedVerification.verifiedReplacements).toEqual(['Invoice Total (Paid)', 'Approved']);
      expect(result.limitations).toEqual([]);
    });

    it('marks commands the native layer did not apply as failed, with the native error', () => {
      const result = normalizeNativeBatchResult(realCommandFailed, { outputPdfPath: '/x.pdf', commandCount: 2 });
      expect(result.appliedCommands).toBe(1);
      expect(result.commands[0].status).toBe('applied');
      expect(result.commands[1].status).toBe('failed');
      expect(result.commands[1].error).toBe('Object locator path could not be resolved');
    });

    it('reports reopen-verification gaps instead of claiming success', () => {
      const result = normalizeNativeBatchResult(realUnverified, { outputPdfPath: '/x.pdf', commandCount: 2 });
      expect(result.reopenedVerification.allReplacementsVerified).toBe(false);
      expect(result.reopenedVerification.missingReplacements).toEqual(['p0_path0']);
      expect(result.reopenedVerification.allDeletionsVerified).toBe(false);
      expect(result.reopenedVerification.residualDeletions).toEqual(['p0_path1']);
    });

    it('treats an applied:false command without an error message as failed', () => {
      const raw = {
        ...realSuccess,
        commandResults: [{ ...realSuccess.commandResults[0], applied: false, error: '' }],
      };
      const result = normalizeNativeBatchResult(raw, { outputPdfPath: '/x.pdf', commandCount: 1 });
      expect(result.commands[0].status).toBe('failed');
      expect(result.commands[0].error).toBe('Native command was not applied.');
    });

    it('throws a typed error for native success:false responses', () => {
      expect(() => normalizeNativeBatchResult(realError, { outputPdfPath: '/x.pdf', commandCount: 1 })).toThrow(
        PdfSaveError,
      );
      expect(() => normalizeNativeBatchResult(null, { outputPdfPath: '/x.pdf', commandCount: 1 })).toThrow(
        PdfBatchEditError,
      );
    });

    it('maps native error codes to typed errors', () => {
      expect(nativeFailureToError('PDF_FILE_NOT_FOUND', 'x')).toBeInstanceOf(PdfFileNotFoundError);
      expect(nativeFailureToError('PDF_PAGE_OUT_OF_RANGE', 'x')).toBeInstanceOf(PdfPageOutOfRangeError);
      expect(nativeFailureToError('REOPEN_FAILED', 'x')).toBeInstanceOf(PdfCorruptedError);
      expect(nativeFailureToError('OUTPUT_FILE_CREATE_FAILED', 'x')).toBeInstanceOf(PdfSaveError);
      expect(nativeFailureToError('SAME_INPUT_OUTPUT', 'x')).toBeInstanceOf(PdfBatchEditError);
    });

    it('still accepts the legacy TS-shaped response used by earlier fixtures', () => {
      const legacy = {
        outputPath: '/o.pdf',
        totalCommands: 1,
        appliedCommands: 1,
        sourceUnchanged: true,
        sourceChecksumBefore: 'h',
        sourceChecksumAfter: 'h',
        commands: [{ type: 'delete', objectId: 'p0_obj2', pageIndex: 0, objectIndex: 2, status: 'applied' }],
        reopenedVerification: {
          allReplacementsVerified: true,
          allDeletionsVerified: true,
          verifiedReplacements: [],
          missingReplacements: [],
          residualDeletions: [],
        },
        limitations: [],
      };
      const result = normalizeNativeBatchResult(legacy, { outputPdfPath: '/o.pdf', commandCount: 1 });
      expect(result.commands[0].status).toBe('applied');
      expect(result.appliedCommands).toBe(1);
    });
  });

  describe('2. PdfiumEngine end-to-end with real native JSON', () => {
    it('applyBatchEdits returns the canonical result for the real native success JSON', async () => {
      installNative(jest.fn().mockResolvedValue(JSON.stringify(realSuccess)));
      const engine = new PdfiumEngine();
      const result = await engine.applyBatchEdits({
        inputPdfPath: '/data/in.pdf',
        outputPdfPath: '/data/out.pdf',
        commands: [{ type: 'replace', objectId: 'p0_path2', pageIndex: 0, objectIndex: 2, newText: 'x' }],
      });
      expect(result.appliedCommands).toBe(3);
      expect(result.sourceChecksumBefore).toBe(realSuccess.sourceShaBefore);
    });

    it('applyBatchEdits surfaces native success:false as a typed error (not a success)', async () => {
      installNative(jest.fn().mockResolvedValue(JSON.stringify(realError)));
      const engine = new PdfiumEngine();
      await expect(
        engine.applyBatchEdits({
          inputPdfPath: '/data/in.pdf',
          outputPdfPath: '/data/out.pdf',
          commands: [{ type: 'delete', objectId: 'p0_path0', pageIndex: 0, objectIndex: 0 }],
        }),
      ).rejects.toBeInstanceOf(PdfSaveError);
    });

    it('never sends an empty edit batch; copyDocument is the explicit copy operation', async () => {
      const native = jest.fn().mockResolvedValue(JSON.stringify(realCopy));
      installNative(native);
      const engine = new PdfiumEngine();

      await expect(
        engine.applyBatchEdits({ inputPdfPath: '/a.pdf', outputPdfPath: '/b.pdf', commands: [] }),
      ).rejects.toThrow('No edit commands provided');
      expect(native).not.toHaveBeenCalled();

      const copy = await engine.copyDocument('/data/working.pdf', '/data/saved.pdf');
      expect(native).toHaveBeenCalledWith('/data/working.pdf', '/data/saved.pdf', '[]');
      expect(copy.totalCommands).toBe(0);
      expect(copy.pageCountAfter).toBe(3);
      await expect(engine.copyDocument('/same.pdf', '/same.pdf')).rejects.toBeInstanceOf(PdfSaveError);
    });

    it('rejects a non-JSON native response with a typed error', async () => {
      installNative(jest.fn().mockResolvedValue('<<not json>>'));
      const engine = new PdfiumEngine();
      await expect(
        engine.applyBatchEdits({
          inputPdfPath: '/a.pdf',
          outputPdfPath: '/b.pdf',
          commands: [{ type: 'delete', objectId: 'p0_path0', pageIndex: 0, objectIndex: 0 }],
        }),
      ).rejects.toBeInstanceOf(PdfBatchEditError);
    });

    it('replaceTextObject maps the real single-replace keys and success:false', async () => {
      installNative(jest.fn());
      const engine = new PdfiumEngine();
      const ok = await engine.replaceTextObject({
        inputPdfPath: '/data/in.pdf',
        outputPdfPath: '/data/out.pdf',
        pageIndex: 0,
        objectIndex: 2,
        replacementText: 'New',
      });
      expect(ok.replacementFound).toBe(true);
      expect(ok.oldTextStillPresent).toBe(false);
      expect(ok.sourceUnchanged).toBe(true);
      expect(ok.sourceChecksumBefore).toBe('dd44');
      expect(ok.newText).toBe('New');

      (NativeModules as any).PdfiumNativeModule.replaceTextObject = jest
        .fn()
        .mockResolvedValue(JSON.stringify({ success: false, errorCode: 'PDF_FILE_NOT_FOUND', errorMessage: 'missing' }));
      await expect(
        engine.replaceTextObject({
          inputPdfPath: '/data/in.pdf',
          outputPdfPath: '/data/out.pdf',
          pageIndex: 0,
          objectIndex: 2,
          replacementText: 'New',
        }),
      ).rejects.toBeInstanceOf(PdfFileNotFoundError);
    });
  });

  describe('3. The editor never reports a failed native edit as successful', () => {
    async function openEditor(nativeResponse: unknown) {
      installNative(jest.fn().mockResolvedValue(JSON.stringify(nativeResponse)));
      const editor = new PdfDocumentEditor(new PdfiumEngine());
      await editor.open('/data/source.pdf');
      await editor.getTextObjects(0);
      return editor;
    }

    it('applied replacement with a failed native command throws and keeps the open document', async () => {
      const editor = await openEditor({
        ...realCommandFailed,
        commandResults: [realCommandFailed.commandResults[1]],
      });
      await expect(
        editor.applyExistingTextReplacement('p0_path0', 'New Header', '/data/work1.pdf'),
      ).rejects.toBeInstanceOf(PdfInvalidObjectPathError);
      expect(editor.getCurrentFilePath()).toBe('/data/source.pdf');
      expect(editor.isDirty()).toBe(false);
      expect(editor.canUndo()).toBe(false);
    });

    it('applied deletion with native success:false throws and leaves state untouched', async () => {
      const editor = await openEditor(realError);
      await expect(editor.applyExistingTextDeletion('p0_path0', '/data/work1.pdf')).rejects.toBeInstanceOf(PdfSaveError);
      expect(editor.getCurrentFilePath()).toBe('/data/source.pdf');
      expect(editor.isDirty()).toBe(false);
    });

    it('applied deletion with applied:false maps to PdfTextDeletionError', async () => {
      const editor = await openEditor({
        ...realSuccess,
        commandResults: [
          { ...realSuccess.commandResults[1], objectId: 'p0_path0', applied: false, error: 'FPDFPage_RemoveObject failed' },
        ],
      });
      await expect(editor.applyExistingTextDeletion('p0_path0', '/data/work1.pdf')).rejects.toBeInstanceOf(
        PdfTextDeletionError,
      );
    });

    it('applied insertion with a failed command maps to PdfTextInsertionError', async () => {
      const editor = await openEditor({
        ...realSuccess,
        commandResults: [
          { ...realSuccess.commandResults[2], applied: false, error: 'FPDFPage_InsertObject failed' },
        ],
      });
      await expect(
        editor.applyNewTextInsertion(0, 'Approved', { x: 40, y: 40 }, '/data/work1.pdf'),
      ).rejects.toBeInstanceOf(PdfTextInsertionError);
      expect(editor.getCurrentFilePath()).toBe('/data/source.pdf');
    });

    it('Save with a failed native command marks SAVE_FAILED and keeps queued edits', async () => {
      const editor = await openEditor(realCommandFailed);
      editor.replaceText('p0_path0', 'Queued');
      await expect(editor.saveDocument('/data/out.pdf')).rejects.toBeInstanceOf(PdfBatchEditError);
      expect(editor.getSaveState()).toBe('SAVE_FAILED');
      expect(editor.getPendingEdits()).toHaveLength(1);
      expect(editor.getCurrentFilePath()).toBe('/data/source.pdf');
    });

    it('rejects a result whose source checksum changed (source immutability)', async () => {
      const editor = await openEditor({
        ...realSuccess,
        sourceShaAfter: 'tampered',
        commandResults: [{ ...realSuccess.commandResults[0], objectId: 'p0_path0' }],
      });
      await expect(
        editor.applyExistingTextReplacement('p0_path0', 'New Header', '/data/work1.pdf'),
      ).rejects.toThrow(/source immutability/);
      expect(editor.getCurrentFilePath()).toBe('/data/source.pdf');
    });
  });
});
