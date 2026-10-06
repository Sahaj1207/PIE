/**
 * Phase 13 — PDF Save As / Share: verified-output requirement, success / cancel / failure,
 * content-URI-only sharing, source immutability and dirty/save state transitions.
 */
import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import {
  PdfOutputSource,
  buildPdfOutputFileName,
  describePdfOutputError,
  resolveVerifiedOutputPath,
  savePdfAs,
  sharePdf,
} from '../src/features/pdf/pdfOutputService';
import {
  PdfOutputNotVerifiedError,
  PdfOutputUnavailableError,
  PdfSaveAsError,
  PdfShareError,
} from '../src/errors';
import { PdfSaveState } from '../src/features/pdf/types';

// Node built-ins (Jest runs on Node), typed locally: the RN tsconfig loads only jest types.
declare const __dirname: string;

const SOURCE = '/data/files/pie/documents/pdf-13/source.pdf';
const REV = '/data/files/pie/documents/pdf-13/rev_1.pdf';

function fakeEditor(overrides: Partial<{
  dirty: boolean;
  state: PdfSaveState;
  clean: string | null;
  current: string | null;
  pages: number;
  verify: jest.Mock;
}> = {}): PdfOutputSource & { verify: jest.Mock } {
  const verify = overrides.verify ?? jest.fn().mockResolvedValue(true);
  return {
    verify,
    isDirty: () => overrides.dirty ?? false,
    getSaveState: () => overrides.state ?? 'CLEAN',
    getCleanFilePath: () => (overrides.clean === undefined ? REV : overrides.clean),
    getCurrentFilePath: () => (overrides.current === undefined ? REV : overrides.current),
    getPageCount: () => overrides.pages ?? 2,
    verifyPdfOutput: verify,
  };
}

function installNative(extra: Record<string, unknown>) {
  (NativeModules as any).PdfiumNativeModule = {
    openDocument: jest.fn(),
    closeDocument: jest.fn(),
    ...extra,
  };
}

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('Phase 13 — output file names', () => {
  it('sanitizes document titles into safe .pdf names', () => {
    expect(buildPdfOutputFileName('Contract.pdf')).toBe('Contract.pdf');
    expect(buildPdfOutputFileName('Q3 report')).toBe('Q3 report.pdf');
    expect(buildPdfOutputFileName('../../etc/passwd')).toBe('_.._etc_passwd.pdf');
    expect(buildPdfOutputFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j.pdf');
    expect(buildPdfOutputFileName('line\nbreak')).toBe('line_break.pdf');
    expect(buildPdfOutputFileName('')).toBe('Document.pdf');
    expect(buildPdfOutputFileName(null)).toBe('Document.pdf');
    expect(buildPdfOutputFileName('...')).toBe('Document.pdf');
    expect(buildPdfOutputFileName('x'.repeat(300))).toBe(`${'x'.repeat(120)}.pdf`);
    expect(buildPdfOutputFileName('東京 😀.PDF')).toBe('東京 😀.pdf');
  });
});

describe('Phase 13 — only a saved, verified PDF can be exposed', () => {
  it('returns the clean file after reopening it with the expected page count', async () => {
    const editor = fakeEditor();
    await expect(resolveVerifiedOutputPath(editor)).resolves.toBe(REV);
    expect(editor.verify).toHaveBeenCalledWith(REV, 2);
  });

  it.each([
    ['dirty document', { dirty: true }],
    ['save in progress', { state: 'SAVING' as PdfSaveState }],
    ['failed save', { state: 'SAVE_FAILED' as PdfSaveState }],
    ['applied but unsaved revision open', { current: '/data/files/pie/sessions/pdf-13/working/working_1.pdf' }],
    ['no document', { clean: null, current: null }],
  ])('refuses: %s', async (_label, overrides) => {
    const editor = fakeEditor(overrides);
    await expect(resolveVerifiedOutputPath(editor)).rejects.toBeInstanceOf(PdfOutputNotVerifiedError);
    expect(editor.verify).not.toHaveBeenCalled();
  });

  it('refuses a file that fails reopen verification', async () => {
    const editor = fakeEditor({ verify: jest.fn().mockRejectedValue(new Error('Page count mismatch')) });
    await expect(resolveVerifiedOutputPath(editor)).rejects.toThrow(/could not be verified: Page count mismatch/);
  });
});

describe('Phase 13 — Save As', () => {
  it('success: copies the verified PDF to the user-chosen location', async () => {
    const save = jest.fn().mockResolvedValue({
      uri: 'content://com.android.externalstorage.documents/document/primary%3ADownload%2FContract.pdf',
      displayName: 'Contract.pdf',
      sizeBytes: 2048,
    });
    installNative({ saveCopyToUserLocation: save });
    const outcome = await savePdfAs(fakeEditor(), new PdfiumEngine(), 'Contract');
    expect(save).toHaveBeenCalledWith(REV, 'Contract.pdf');
    expect(outcome).toEqual({
      status: 'saved',
      copy: {
        uri: 'content://com.android.externalstorage.documents/document/primary%3ADownload%2FContract.pdf',
        displayName: 'Contract.pdf',
        sizeBytes: 2048,
      },
    });
  });

  it('cancel: resolves "cancelled" without an error', async () => {
    installNative({ saveCopyToUserLocation: jest.fn().mockResolvedValue(null) });
    await expect(savePdfAs(fakeEditor(), new PdfiumEngine(), 'Contract')).resolves.toEqual({ status: 'cancelled' });
  });

  it('write / verification failures become a typed PdfSaveAsError with a user-facing message', async () => {
    installNative({
      saveCopyToUserLocation: jest.fn().mockRejectedValue(
        Object.assign(new Error('The saved copy does not match the verified PDF'), { code: 'PDF_SAVE_AS_VERIFY_FAILED' }),
      ),
    });
    const attempt = savePdfAs(fakeEditor(), new PdfiumEngine(), 'Contract');
    await expect(attempt).rejects.toBeInstanceOf(PdfSaveAsError);
    try {
      await savePdfAs(fakeEditor(), new PdfiumEngine(), 'Contract');
    } catch (err) {
      expect(describePdfOutputError(err)).toMatch(/could not be saved to the chosen location/);
    }
  });

  it('rejects a destination that is not a content:// document', async () => {
    installNative({ saveCopyToUserLocation: jest.fn().mockResolvedValue({ uri: '/sdcard/Download/x.pdf' }) });
    await expect(savePdfAs(fakeEditor(), new PdfiumEngine(), 'x')).rejects.toBeInstanceOf(PdfSaveAsError);
  });

  it('never opens the picker for an unverified document', async () => {
    const save = jest.fn();
    installNative({ saveCopyToUserLocation: save });
    await expect(savePdfAs(fakeEditor({ dirty: true }), new PdfiumEngine(), 'x')).rejects.toBeInstanceOf(
      PdfOutputNotVerifiedError,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('is a typed "unavailable" error where the native picker is missing (e.g. iOS)', async () => {
    installNative({});
    await expect(savePdfAs(fakeEditor(), new PdfiumEngine(), 'x')).rejects.toBeInstanceOf(PdfOutputUnavailableError);
  });
});

describe('Phase 13 — Share', () => {
  it('shares the verified PDF only through a FileProvider content:// URI', async () => {
    const share = jest.fn().mockResolvedValue({
      contentUri: 'content://com.pdfimageeditor.provider/cache/pdf_exports/1700000000000/Contract.pdf',
      displayName: 'Contract.pdf',
    });
    installNative({ sharePdf: share });
    const result = await sharePdf(fakeEditor(), new PdfiumEngine(), 'Contract');
    expect(share).toHaveBeenCalledWith(REV, 'Contract.pdf', 'Share PDF');
    expect(result.contentUri.startsWith('content://com.pdfimageeditor.provider/')).toBe(true);
    expect(result.contentUri).not.toContain('/data/');
  });

  it('rejects a native result that exposes a filesystem path', async () => {
    installNative({ sharePdf: jest.fn().mockResolvedValue({ contentUri: 'file:///data/files/pie/x.pdf' }) });
    await expect(sharePdf(fakeEditor(), new PdfiumEngine(), 'x')).rejects.toBeInstanceOf(PdfShareError);
  });

  it('native share failures are typed', async () => {
    installNative({ sharePdf: jest.fn().mockRejectedValue(new Error('no activity')) });
    await expect(sharePdf(fakeEditor(), new PdfiumEngine(), 'x')).rejects.toBeInstanceOf(PdfShareError);
  });

  it('never shares an unverified (failed-save) document', async () => {
    const share = jest.fn();
    installNative({ sharePdf: share });
    await expect(
      sharePdf(fakeEditor({ state: 'SAVE_FAILED', dirty: true }), new PdfiumEngine(), 'x'),
    ).rejects.toBeInstanceOf(PdfOutputNotVerifiedError);
    expect(share).not.toHaveBeenCalled();
  });
});

describe('Phase 13 — real editor: dirty/save transitions and source immutability', () => {
  const files = new Map<string, string[]>();
  let handles: Map<number, string>;
  let saveAs: jest.Mock;

  function setup() {
    files.clear();
    files.set(SOURCE, ['Header', 'Body']);
    handles = new Map();
    let next = 1;
    saveAs = jest.fn().mockResolvedValue({ uri: 'content://docs/document/7', displayName: 'Contract.pdf', sizeBytes: 10 });
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (path: string) => {
        if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'PDF_FILE_NOT_FOUND' });
        const h = next++;
        handles.set(h, path);
        return { docHandle: h, pageCount: 1, filePath: path };
      }),
      closeDocument: jest.fn(async () => true),
      getPageCount: jest.fn(async () => 1),
      getPageSize: jest.fn(async (_h: number, pageIndex: number) => ({ pageIndex, width: 612, height: 792 })),
      getTextObjects: jest.fn(async (h: number) =>
        JSON.stringify(
          files.get(handles.get(h)!)!.map((text, i) => ({
            id: `p0_path${i}`, pageIndex: 0, objectIndex: i, objectPath: [i], text,
            bounds: { x: 50, y: 60 + i * 30, width: 120, height: 16 },
            pdfBounds: { left: 50, bottom: 716 - i * 30, right: 170, top: 732 - i * 30 },
            fontSize: 12, fontName: 'Helvetica', color: '#000000',
            colorRgba: { r: 0, g: 0, b: 0, a: 255 },
            matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 716 - i * 30 }, isEditable: true,
          })),
        ),
      ),
      applyBatchEdits: jest.fn(async (input: string, output: string, json: string) => {
        const edits = JSON.parse(json);
        const texts = [...files.get(input)!];
        const results = edits.map((c: any) => {
          const before = texts[c.objectIndex];
          texts[c.objectIndex] = c.newText;
          return {
            type: c.type, objectId: c.objectId, pageIndex: 0, objectIndex: c.objectIndex,
            originalText: before, newText: c.newText, applied: true, verifiedInReopened: true,
            verificationError: '', fontStrategy: 'REUSED_ORIGINAL', fontReused: true, error: '',
          };
        });
        files.set(output, texts);
        return JSON.stringify({
          success: true, inputPath: input, outputPath: output, commandsApplied: edits.length,
          sourceUnchanged: true, sourceShaBefore: 's', sourceShaAfter: 's',
          pageCountBefore: 1, pageCountAfter: 1, commandResults: results,
        });
      }),
      saveCopyToUserLocation: saveAs,
    };
  }

  it('dirty -> refused; saved -> exports the verified revision, never the source; source untouched', async () => {
    setup();
    const engine = new PdfiumEngine();
    const editor = new PdfDocumentEditor(engine);
    await editor.open(SOURCE);
    await editor.getTextObjects(0);

    // Unedited: the imported durable source itself is the verified clean PDF.
    await expect(savePdfAs(editor, engine, 'Contract')).resolves.toMatchObject({ status: 'saved' });
    expect(saveAs).toHaveBeenLastCalledWith(SOURCE, 'Contract.pdf');

    editor.replaceText('p0_path0', 'New Header');
    expect(editor.getSaveState()).toBe('DIRTY');
    saveAs.mockClear();
    await expect(savePdfAs(editor, engine, 'Contract')).rejects.toBeInstanceOf(PdfOutputNotVerifiedError);
    expect(saveAs).not.toHaveBeenCalled();

    const { outputPath, verified } = await editor.saveDocument(REV);
    expect(verified).toBe(true);
    expect(editor.getSaveState()).toBe('CLEAN');

    await expect(savePdfAs(editor, engine, 'Contract')).resolves.toMatchObject({ status: 'saved' });
    expect(saveAs).toHaveBeenCalledWith(outputPath, 'Contract.pdf');
    expect(saveAs).not.toHaveBeenCalledWith(SOURCE, expect.anything());
    expect(files.get(SOURCE)).toEqual(['Header', 'Body']);
    expect(files.get(REV)).toEqual(['New Header', 'Body']);
  });

  it('a failed Save As leaves the document state unchanged (still clean, nothing re-saved)', async () => {
    setup();
    saveAs.mockRejectedValue(new Error('disk full'));
    const engine = new PdfiumEngine();
    const editor = new PdfDocumentEditor(engine);
    await editor.open(SOURCE);
    await expect(savePdfAs(editor, engine, 'Contract')).rejects.toBeInstanceOf(PdfSaveAsError);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.isDirty()).toBe(false);
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect((NativeModules as any).PdfiumNativeModule.applyBatchEdits).not.toHaveBeenCalled();
  });
});

describe('Phase 13 — native Save As / Share contract (static)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs: { readFileSync(file: string, encoding: 'utf8'): string } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path: { join(...parts: string[]): string } = require('path');
  const kotlin = fs.readFileSync(
    path.join(__dirname, '..', 'android/app/src/main/java/com/com.pdfimageeditor/pdf/NativePdfiumModule.kt'),
    'utf8',
  );
  const section = (start: string, end: string) => kotlin.substring(kotlin.indexOf(start), kotlin.indexOf(end, kotlin.indexOf(start)));

  it('Save As uses the system ACTION_CREATE_DOCUMENT picker (not MediaStore)', () => {
    const saveAs = section('fun saveCopyToUserLocation(', 'private fun writeSaveAsCopy(');
    expect(saveAs).toContain('Intent.ACTION_CREATE_DOCUMENT');
    expect(saveAs).toContain('type = "application/pdf"');
    expect(saveAs).toContain('Intent.EXTRA_TITLE');
    expect(saveAs).toContain('requireVerifiablePdf(sourcePath)');
    expect(kotlin).not.toContain('MediaStore');
  });

  it('Save As verifies the written copy and removes partial files on failure', () => {
    const write = section('private fun writeSaveAsCopy(', 'private fun deletePartialDocument(');
    expect(write).toContain('MessageDigest.getInstance("SHA-256")');
    expect(write).toContain('openInputStream(destination)');
    expect(write).toContain('PDF_SAVE_AS_VERIFY_FAILED');
    expect(write).toContain('PDF_SAVE_AS_WRITE_FAILED');
    expect(write).toContain('deletePartialDocument(destination)');
    expect(kotlin).toContain('DocumentsContract.deleteDocument');
  });

  it('Share exposes only a FileProvider content URI of a cache copy with a read grant', () => {
    const share = section('fun sharePdf(', 'fun purgeExportCache(');
    expect(share).toContain('requireVerifiablePdf(sourcePath)');
    expect(share).toContain('File(File(reactContext.cacheDir, EXPORT_DIR)');
    expect(share).toContain('FileProvider.getUriForFile(reactContext, authority, shared)');
    expect(share).toContain('Intent.FLAG_GRANT_READ_URI_PERMISSION');
    expect(share).toContain('putExtra(Intent.EXTRA_STREAM, contentUri)');
    expect(share).not.toContain('Uri.fromFile');
  });

  it('exported sources must be app-private PDFs and are only read', () => {
    const guard = section('private fun requireVerifiablePdf(', 'private fun sanitizePdfFileName(');
    expect(guard).toContain('isAppPrivate(file)');
    expect(guard).toContain('"%PDF-"');
    expect(guard).not.toMatch(/writeBytes|outputStream\(|delete\(/);
  });
});
