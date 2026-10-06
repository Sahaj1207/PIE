/**
 * Phase 13 — password-protected / unsupported-security PDFs are detected and reported
 * clearly. PIE never supplies or guesses a password and never bypasses encryption.
 */
import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { describePdfOpenError } from '../src/features/pdf/pdfOutputService';
import { ensureDurablePdfSource, discardImportedPdf } from '../src/features/pdf/pdfDocumentFiles';
import {
  PdfCorruptedError,
  PdfPasswordRequiredError,
  PdfSecurityUnsupportedError,
} from '../src/errors';

const nativeError = (code: string, message: string) => Object.assign(new Error(message), { code });

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('Phase 13 — encrypted PDF detection', () => {
  it('maps the native PDF_PASSWORD_REQUIRED code to PdfPasswordRequiredError', async () => {
    const open = jest.fn().mockRejectedValue(
      nativeError('PDF_PASSWORD_REQUIRED', 'Password required or incorrect password'),
    );
    (NativeModules as any).PdfiumNativeModule = { openDocument: open };
    const engine = new PdfiumEngine();
    await expect(engine.openDocument('/data/files/pie/documents/pdf-1/source.pdf')).rejects.toBeInstanceOf(
      PdfPasswordRequiredError,
    );
    // No password is invented or guessed.
    expect(open).toHaveBeenCalledWith('/data/files/pie/documents/pdf-1/source.pdf', null);
  });

  it('maps PDF_SECURITY_UNSUPPORTED to PdfSecurityUnsupportedError', async () => {
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn().mockRejectedValue(nativeError('PDF_SECURITY_UNSUPPORTED', 'Unsupported security scheme')),
    };
    await expect(new PdfiumEngine().openDocument('/x.pdf')).rejects.toBeInstanceOf(PdfSecurityUnsupportedError);
  });

  it('the editor surfaces the typed error and keeps no open document', async () => {
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn().mockRejectedValue(nativeError('PDF_PASSWORD_REQUIRED', 'Password required')),
      closeDocument: jest.fn(),
    };
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await expect(editor.open('/data/files/pie/documents/pdf-1/source.pdf')).rejects.toBeInstanceOf(
      PdfPasswordRequiredError,
    );
    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
  });

  it('produces a clear password-required state for the UI', () => {
    const failure = describePdfOpenError(new PdfPasswordRequiredError('Password required'));
    expect(failure.kind).toBe('password');
    expect(failure.title).toBe('Password-Protected PDF');
    expect(failure.message).toMatch(/protected with a password/);
    expect(failure.message).not.toMatch(/bypass|crack/i);

    expect(describePdfOpenError(new PdfSecurityUnsupportedError('x')).kind).toBe('security');
    const other = describePdfOpenError(new PdfCorruptedError('bad xref'));
    expect(other.kind).toBe('other');
    expect(other.message).toBe('Failed to open PDF document: bad xref');
  });

  it('a password-protected import leaves nothing behind in durable storage', async () => {
    const files = new Map<string, string>([['/data/app/cache/picked_pdfs/1_secret.pdf', '%PDF enc']]);
    const store: any = {
      getRootPath: jest.fn(async () => '/data/app/files/pie'),
      makeDirectory: jest.fn(async () => undefined),
      copyFile: jest.fn(async (from: string, to: string) => files.set(to, files.get(from)!)),
      deletePath: jest.fn(async (p: string) => {
        for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      }),
    };
    const source = await ensureDurablePdfSource('/data/app/cache/picked_pdfs/1_secret.pdf', 'pdf-77', store);
    expect(source.imported).toBe(true);

    // The screen's open failure path: the import is discarded, no record is written.
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn().mockRejectedValue(nativeError('PDF_PASSWORD_REQUIRED', 'Password required')),
    };
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await expect(editor.open(source.path)).rejects.toBeInstanceOf(PdfPasswordRequiredError);
    await discardImportedPdf('pdf-77', store);

    expect([...files.keys()].filter((k) => k.includes('/documents/pdf-77'))).toEqual([]);
    expect(files.get('/data/app/cache/picked_pdfs/1_secret.pdf')).toBe('%PDF enc');
  });
});
