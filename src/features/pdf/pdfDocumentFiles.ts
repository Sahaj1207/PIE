import {
  IFileStore,
  baseName,
  getNativeFileStore,
  isPathInside,
  joinPath,
  toFilePath,
} from '../../storage/nativeFileStore';
import {
  DOCUMENTS_DIR,
  SESSIONS_DIR,
  assertSafeDocumentId,
} from '../../storage/documentFiles';
import { DocumentStorageError } from '../../errors';

/**
 * PDF file lifecycle on top of the Phase 10 durable storage layout:
 *
 *   <root>/documents/<docId>/source.pdf            imported original (copied at import time)
 *   <root>/documents/<docId>/rev_<timestamp>.pdf   saved (durable) PDF revisions
 *   <root>/sessions/<docId>/working/working_*.pdf  unsaved working copies of an open session
 *
 * Imported PDFs and saved revisions live in the document directory, so persisted PDF
 * records never reference purgeable cache files. Working copies live in the session
 * directory, which is removed when the session ends (and at app start).
 */

export const PDF_WORKING_DIR = 'working';
export const PDF_REVISION_PREFIX = 'rev_';
/** Durable copy of the imported original. Never pruned (it is not a `rev_` file). */
export const PDF_SOURCE_FILE_NAME = 'source.pdf';

export interface DurablePdfSource {
  /** Path to open: the durable copy when imported, otherwise the input path unchanged. */
  readonly path: string;
  /** True when this call copied the PDF into durable storage. */
  readonly imported: boolean;
}

/**
 * Makes sure the PDF about to be opened lives in durable document storage.
 *
 * - A file outside the storage root (picker / content-URI copies in the purgeable cache) is
 *   COPIED to `<root>/documents/<docId>/source.pdf`. The input file is never modified; the
 *   user's original document is never touched (the picker already works on a private copy).
 * - A file already inside the storage root (a saved revision or imported source reopened
 *   from the library) is returned unchanged.
 * - Without durable storage (no native file store, e.g. iOS until its native counterpart
 *   exists) or for content:// URIs the input is returned unchanged (`imported: false`).
 *
 * A failed copy throws: the editor must not silently fall back to a purgeable cache file.
 */
export async function ensureDurablePdfSource(
  inputPath: string,
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<DurablePdfSource> {
  if (!fileStore || !inputPath || inputPath.startsWith('content://')) {
    return { path: inputPath, imported: false };
  }
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const plainPath = toFilePath(inputPath);
  if (isPathInside(plainPath, root)) {
    return { path: inputPath, imported: false };
  }

  const docDir = joinPath(root, DOCUMENTS_DIR, documentId);
  const target = joinPath(docDir, PDF_SOURCE_FILE_NAME);
  try {
    await fileStore.makeDirectory(docDir);
    await fileStore.copyFile(plainPath, target);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocumentStorageError(`Could not import the PDF into app storage: ${msg}`, err);
  }
  return { path: target, imported: true };
}

/**
 * Removes the durable copy created by ensureDurablePdfSource() when the imported PDF could
 * not be opened (no record references it). Only the document's own directory is touched.
 */
export async function discardImportedPdf(
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<void> {
  if (!fileStore) return;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  await fileStore.deletePath(joinPath(root, DOCUMENTS_DIR, documentId));
}

/** Creates a new, stable PDF document id for records created from the PDF editor. */
export function createPdfDocumentId(now: number = Date.now()): string {
  return `pdf-${now}`;
}

export async function getPdfSessionWorkingDirectory(
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<string | null> {
  if (!fileStore) return null;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const dir = joinPath(root, SESSIONS_DIR, documentId, PDF_WORKING_DIR);
  await fileStore.makeDirectory(dir);
  return dir;
}

/**
 * Builds the next working-copy path.
 * - With a session directory: `<sessionDir>/working_<seq>_<ts>.pdf` (flat, never chained).
 * - Without durable storage: next to the current file, stripping any previous
 *   `_working_<n>` suffix so names do not grow with every edit.
 */
export function buildWorkingCopyPath(
  currentPath: string,
  sessionDir: string | null,
  sequence: number,
  now: number = Date.now(),
): string {
  if (sessionDir) {
    return joinPath(sessionDir, `working_${sequence}_${now}.pdf`);
  }
  const clean = toFilePath(currentPath);
  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const dir = lastSlash >= 0 ? clean.substring(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? clean.substring(lastSlash + 1) : clean;
  const base = fileName
    .replace(/\.pdf$/i, '')
    .replace(/(_working_\d+(_\d+)?)+$/i, '');
  return `${dir}/${base}_working_${sequence}_${now}.pdf`;
}

/** Durable output path for the next saved revision, or null without durable storage. */
export async function createDurablePdfRevisionPath(
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
  now: number = Date.now(),
): Promise<string | null> {
  if (!fileStore) return null;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const dir = joinPath(root, DOCUMENTS_DIR, documentId);
  await fileStore.makeDirectory(dir);
  return joinPath(dir, `${PDF_REVISION_PREFIX}${now}.pdf`);
}

/**
 * Deletes saved PDF revisions of a document except `keepPaths` (the newly saved revision,
 * the open document, the session's source and any undo/redo file). Never touches files
 * outside the document directory.
 */
export async function pruneDurablePdfRevisions(
  documentId: string,
  keepPaths: readonly (string | null | undefined)[],
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<number> {
  if (!fileStore) return 0;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const dir = joinPath(root, DOCUMENTS_DIR, documentId);
  const keep = new Set(
    keepPaths.filter((p): p is string => !!p).map((p) => toFilePath(p)),
  );

  let removed = 0;
  for (const name of await fileStore.listDirectory(dir)) {
    if (!name.startsWith(PDF_REVISION_PREFIX) || !name.toLowerCase().endsWith('.pdf')) {
      continue;
    }
    const path = joinPath(dir, name);
    if (!keep.has(path)) {
      await fileStore.deletePath(path);
      removed++;
    }
  }
  return removed;
}

/**
 * Deletes revision files the editor released (PdfDocumentEditor.takeDiscardedRevisionFiles:
 * pruned undo steps, cleared redo branches). Only files directly inside this document's
 * session working directory are ever deleted — never the imported source, saved revisions
 * (documents/<id>/) or anything outside the session. Returns the number deleted.
 */
export async function deleteReleasedRevisionFiles(
  documentId: string,
  releasedPaths: readonly string[],
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<number> {
  if (!fileStore || releasedPaths.length === 0) return 0;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const workingDir = joinPath(root, SESSIONS_DIR, documentId, PDF_WORKING_DIR);
  let removed = 0;
  for (const raw of releasedPaths) {
    const path = toFilePath(raw);
    const insideWorking = isPathInside(path, workingDir) && path !== workingDir;
    const name = insideWorking ? path.substring(workingDir.length + 1) : '';
    const directChild = !!name && !name.includes('/') && !name.includes('\\') && !name.includes('..');
    if (!directChild || !name.toLowerCase().endsWith('.pdf')) continue;
    await fileStore.deletePath(path);
    removed++;
  }
  return removed;
}

/**
 * Removes unsaved working copies of a PDF editing session. Files listed in
 * `protectedPaths` (e.g. the open document or undo/redo revisions) are never deleted.
 */
export async function cleanupPdfSessionFiles(
  documentId: string,
  protectedPaths: readonly (string | null | undefined)[] = [],
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<number> {
  if (!fileStore) return 0;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const sessionDir = joinPath(root, SESSIONS_DIR, documentId);
  const workingDir = joinPath(sessionDir, PDF_WORKING_DIR);
  const protectedInSession = protectedPaths
    .filter((p): p is string => !!p)
    .map((p) => toFilePath(p))
    .filter((p) => isPathInside(p, workingDir));

  if (protectedInSession.length === 0) {
    await fileStore.deletePath(sessionDir);
    return -1; // whole session directory removed
  }

  const keepNames = new Set(protectedInSession.map((p) => baseName(p)));
  let removed = 0;
  for (const name of await fileStore.listDirectory(workingDir)) {
    if (!keepNames.has(name)) {
      await fileStore.deletePath(joinPath(workingDir, name));
      removed++;
    }
  }
  return removed;
}
