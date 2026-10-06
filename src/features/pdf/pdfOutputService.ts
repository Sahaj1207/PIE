/**
 * PDF output: Save As (user-chosen destination) and Share.
 *
 * Both expose ONLY the editor's clean, saved PDF — the file produced by a successful,
 * reopen-verified Save (Phase 12) or the unmodified durable import — after reopening it
 * once more with PDFium. A dirty document, a failed save or an unverifiable file is never
 * exported; callers save first (the normal verified Save) and then export.
 *
 * Platform specifics (Android ACTION_CREATE_DOCUMENT picker, FileProvider share) live in
 * the native PDF module behind IPdfiumEngine; nothing here touches the filesystem directly.
 * The exported file is only read; the immutable source is never written.
 */
import { isPlatformDocumentUri } from './pdfiumEngine';
import {
  AppError,
  PdfOutputNotVerifiedError,
  PdfOutputUnavailableError,
  PdfPasswordRequiredError,
  PdfSaveAsError,
  PdfSecurityUnsupportedError,
  PdfShareError,
} from '../../errors';
import { IPdfiumEngine, PdfSaveState, PdfShareResult, PdfUserLocationCopy } from './types';

/** The editor capabilities output needs (PdfDocumentEditor satisfies this). */
export interface PdfOutputSource {
  isDirty(): boolean;
  getSaveState(): PdfSaveState;
  getCleanFilePath(): string | null;
  getCurrentFilePath(): string | null;
  getPageCount(): number;
  verifyPdfOutput(outputPath: string, expectedPageCount?: number): Promise<boolean>;
}

export type PdfSaveAsOutcome =
  | { readonly status: 'saved'; readonly copy: PdfUserLocationCopy }
  | { readonly status: 'cancelled' };

const MAX_NAME_LENGTH = 120;

/**
 * Builds a safe output file name from the document title: no path separators or control
 * characters, no leading/trailing dots, at most 120 characters, always ending in ".pdf".
 */
export function buildPdfOutputFileName(title: string | null | undefined): string {
  let name = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (/\.pdf$/i.test(name)) {
    name = name.slice(0, -4).trim();
  }
  if (!name) {
    name = 'Document';
  }
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).trim();
  }
  return `${name}.pdf`;
}

/**
 * Returns the path of the saved, verified PDF that may be exported, or throws
 * PdfOutputNotVerifiedError. Requirements:
 * - no unsaved edits, no save in progress, last save did not fail;
 * - the open document IS the clean file (no applied-but-unsaved revisions);
 * - the file reopens with PDFium with the expected page count and valid pages.
 */
export async function resolveVerifiedOutputPath(editor: PdfOutputSource): Promise<string> {
  const state = editor.getSaveState();
  if (editor.isDirty() || state === 'SAVING' || state === 'SAVE_FAILED') {
    throw new PdfOutputNotVerifiedError(
      'The document has unsaved or failed changes. Save it successfully before exporting.',
    );
  }
  const clean = editor.getCleanFilePath();
  const current = editor.getCurrentFilePath();
  if (!clean || !current || clean !== current) {
    throw new PdfOutputNotVerifiedError('There is no saved PDF to export.');
  }
  try {
    await editor.verifyPdfOutput(clean, editor.getPageCount());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PdfOutputNotVerifiedError(`The saved PDF could not be verified: ${msg}`, err);
  }
  return clean;
}

/** Save As: verified PDF -> user-chosen destination. Cancel is a normal outcome. */
export async function savePdfAs(
  editor: PdfOutputSource,
  engine: Pick<IPdfiumEngine, 'saveCopyToUserLocation'>,
  title: string | null | undefined,
): Promise<PdfSaveAsOutcome> {
  if (typeof engine.saveCopyToUserLocation !== 'function') {
    throw new PdfOutputUnavailableError('Save As is not available on this platform.');
  }
  const verifiedPath = await resolveVerifiedOutputPath(editor);
  const copy = await engine.saveCopyToUserLocation(verifiedPath, buildPdfOutputFileName(title));
  return copy ? { status: 'saved', copy } : { status: 'cancelled' };
}

/** Share: verified PDF -> system share sheet (content:// URI only). */
export async function sharePdf(
  editor: PdfOutputSource,
  engine: Pick<IPdfiumEngine, 'sharePdfFile'>,
  title: string | null | undefined,
): Promise<PdfShareResult> {
  if (typeof engine.sharePdfFile !== 'function') {
    throw new PdfOutputUnavailableError('Sharing PDFs is not available on this platform.');
  }
  const verifiedPath = await resolveVerifiedOutputPath(editor);
  const result = await engine.sharePdfFile(verifiedPath, buildPdfOutputFileName(title), 'Share PDF');
  if (!result || typeof result.contentUri !== 'string' || !isPlatformDocumentUri(result.contentUri, 'share')) {
    throw new PdfShareError('The PDF was not shared through a secure content URI.');
  }
  return result;
}

/** User-facing message for Save As / Share failures. */
export function describePdfOutputError(err: unknown): string {
  if (err instanceof PdfOutputNotVerifiedError) {
    return 'The PDF could not be verified, so nothing was exported. Save your changes and try again.';
  }
  if (err instanceof PdfOutputUnavailableError) {
    return 'Exporting PDFs is not available on this device.';
  }
  if (err instanceof PdfSaveAsError) {
    return `The PDF could not be saved to the chosen location. Nothing was changed in your document.\n\n${err.message}`;
  }
  if (err instanceof PdfShareError) {
    return `The PDF could not be shared.\n\n${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export type PdfOpenFailureKind = 'password' | 'security' | 'other';

export interface PdfOpenFailure {
  readonly kind: PdfOpenFailureKind;
  readonly title: string;
  readonly message: string;
}

/**
 * Classifies a PDF open/import failure for the UI. Encrypted PDFs are detected and
 * reported clearly; PIE never attempts to bypass PDF encryption.
 */
export function describePdfOpenError(err: unknown): PdfOpenFailure {
  if (err instanceof PdfPasswordRequiredError) {
    return {
      kind: 'password',
      title: 'Password-Protected PDF',
      message:
        'This PDF is protected with a password. PIE cannot edit password-protected PDFs. ' +
        'Remove the password in the app that created it, then open it again.',
    };
  }
  if (err instanceof PdfSecurityUnsupportedError) {
    return {
      kind: 'security',
      title: 'Unsupported PDF Security',
      message: 'This PDF uses a security or encryption method that PIE cannot open.',
    };
  }
  const msg = err instanceof AppError || err instanceof Error ? err.message : String(err);
  return { kind: 'other', title: 'Unable to Open PDF', message: `Failed to open PDF document: ${msg}` };
}
