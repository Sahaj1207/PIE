/**
 * PDF library management: deleting a durable PDF document.
 *
 * Deletion goes through the existing IDocumentStorage.deleteDocument (which removes exactly
 * <root>/documents/<id> — document.json, source.pdf, rev_*.pdf — and <root>/sessions/<id>).
 * No second persistence path is introduced. Safety rules:
 * - the id must be a safe single path segment (no "..", separators, empty ids);
 * - the persisted record must exist, carry the same id and be a PDF;
 * - the document must not be in use (open, saving, exporting, closing or already deleting);
 * - shared caches (page renders, import copies, share copies) are purged only when no
 *   document at all is in use, so an open editor never loses files it displays.
 */
import { DocumentBusyError, DocumentStorageError } from '../../errors';
import { IDocumentStorage } from '../../storage/types';
import { assertSafeDocumentId } from '../../storage/documentFiles';
import { DocumentActivityRegistry } from '../documents/documentActivity';
import { IPdfiumEngine } from './types';

/** Share copies younger than this are kept (a receiving app may still read them). */
export const SHARE_COPY_RETENTION_MS = 60 * 60 * 1000;

export interface PdfLibraryDeleteDeps {
  readonly storage: IDocumentStorage;
  readonly activity: DocumentActivityRegistry;
  readonly engine?: Pick<IPdfiumEngine, 'purgeRenderCache' | 'purgeImportCache' | 'purgeExportCache'>;
}

export async function deletePdfLibraryDocument(documentId: string, deps: PdfLibraryDeleteDeps): Promise<void> {
  assertSafeDocumentId(documentId);

  if (deps.activity.isActive(documentId)) {
    throw new DocumentBusyError(
      'This document is still open or being saved. Close it and try again in a moment.',
    );
  }

  const record = await deps.storage.getDocument(documentId);
  if (!record) {
    throw new DocumentStorageError('This document no longer exists in the library.');
  }
  if (record.id !== documentId || record.metadata?.id !== documentId) {
    throw new DocumentStorageError('The library record does not match the document to delete.');
  }
  if (record.metadata.kind !== 'pdf') {
    throw new DocumentStorageError('Only PDF documents can be deleted here.');
  }

  const release = deps.activity.markActive(documentId, 'deleting');
  try {
    await deps.storage.deleteDocument(documentId);
  } finally {
    release();
  }

  if (deps.engine && !deps.activity.hasAnyActive()) {
    await deps.engine.purgeRenderCache?.([]).catch(() => 0);
    await deps.engine.purgeImportCache?.([]).catch(() => 0);
    // Keep share copies from the last hour: a receiving app may still be reading one.
    await deps.engine.purgeExportCache?.(SHARE_COPY_RETENTION_MS).catch(() => 0);
  }
}

/** User-facing message for a failed library delete. */
export function describeLibraryDeleteError(err: unknown): string {
  if (err instanceof DocumentBusyError) {
    return err.message;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `The document could not be deleted. ${msg}`;
}
