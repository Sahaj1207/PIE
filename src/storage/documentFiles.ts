import { Document } from '../types/document';
import { DocumentStorageError } from '../errors';
import { IDocumentStorage } from './types';
import {
  IFileStore,
  baseName,
  getNativeFileStore,
  isPathInside,
  joinPath,
  toFilePath,
} from './nativeFileStore';

/**
 * On-device layout of durable document storage (inside the app-private root):
 *
 *   <root>/documents/<documentId>/document.json   persisted Document envelope
 *   <root>/documents/<documentId>/assets/...      working image + display preview
 *   <root>/documents/<documentId>/patches/...     reconstructed background patches
 *   <root>/sessions/<documentId>/patches/...      unsaved patches of an open editing session
 */
export const DOCUMENTS_DIR = 'documents';
export const SESSIONS_DIR = 'sessions';
export const DOCUMENT_FILE_NAME = 'document.json';
export const DOCUMENT_ASSETS_DIR = 'assets';
export const DOCUMENT_PATCHES_DIR = 'patches';

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Rejects document IDs that could escape the storage root as path segments. */
export function assertSafeDocumentId(id: string): void {
  if (!id || !SAFE_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new DocumentStorageError(`Invalid document id for storage: "${id}"`);
  }
}

export async function getDocumentDirectory(
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<string | null> {
  if (!fileStore) return null;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  return joinPath(root, DOCUMENTS_DIR, documentId);
}

/**
 * Directory for reconstruction patches produced during an editing session. They stay
 * here (referenced by undo/redo snapshots) until the session ends; Save copies the
 * patches referenced by the saved document into the document's own patches directory.
 */
export async function getSessionPatchDirectory(
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<string | null> {
  if (!fileStore) return null;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  const dir = joinPath(root, SESSIONS_DIR, documentId, DOCUMENT_PATCHES_DIR);
  await fileStore.makeDirectory(dir);
  return dir;
}

/** Deletes all unsaved session files of a document (called when the editor closes). */
export async function discardEditingSessionFiles(
  documentId: string,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<void> {
  if (!fileStore) return;
  assertSafeDocumentId(documentId);
  const root = await fileStore.getRootPath();
  await fileStore.deletePath(joinPath(root, SESSIONS_DIR, documentId));
}

/**
 * Removes session directories left behind by a previous process (crash / force stop).
 * Must only run at app start, before any editor session is opened.
 */
export async function cleanupStaleEditingSessions(
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<void> {
  if (!fileStore) return;
  const root = await fileStore.getRootPath();
  await fileStore.deletePath(joinPath(root, SESSIONS_DIR));
}

/** All file URIs a document references (working image, preview, patches). */
export function collectReferencedFileUris(document: Document): string[] {
  const uris: string[] = [];
  for (const page of document.pages || []) {
    if (page.originalContent?.assetUri) uris.push(page.originalContent.assetUri);
    if (page.originalContent?.previewUri) uris.push(page.originalContent.previewUri);
    for (const region of page.editableTextRegions || []) {
      if (region.reconstructedPatchUri) uris.push(region.reconstructedPatchUri);
    }
  }
  return uris;
}

/**
 * Deletes patch files in the document directory that the persisted document no longer
 * references. Runs only after an editing session has ended, so no undo/redo snapshot
 * can still point at a pruned file.
 */
export async function pruneUnreferencedDocumentFiles(
  documentId: string,
  storage: IDocumentStorage,
  fileStore: IFileStore | null = getNativeFileStore(),
): Promise<number> {
  if (!fileStore) return 0;
  const docDir = await getDocumentDirectory(documentId, fileStore);
  if (!docDir) return 0;

  const persisted = await storage.getDocument(documentId);
  if (!persisted) return 0;

  const patchesDir = joinPath(docDir, DOCUMENT_PATCHES_DIR);
  const referenced = new Set(
    collectReferencedFileUris(persisted)
      .map(toFilePath)
      .filter((p) => isPathInside(p, patchesDir))
      .map((p) => baseName(p)),
  );

  let removed = 0;
  const entries = await fileStore.listDirectory(patchesDir);
  for (const name of entries) {
    if (!referenced.has(name)) {
      await fileStore.deletePath(joinPath(patchesDir, name));
      removed++;
    }
  }
  return removed;
}
