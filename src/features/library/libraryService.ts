/**
 * Library operations for the Home screen: thumbnails, rename, duplicate, delete, share,
 * document info, and creating new PDFs (images -> PDF, merge). Works on the canonical
 * document storage; never modifies files outside app storage.
 */
import { Document, DocumentMetadata } from '../../types/document';
import { DocumentSummary } from '../documents/types';
import { documentStorage as defaultStorage } from '../../storage';
import { IDocumentStorage } from '../../storage/types';
import { getDocumentDirectory } from '../../storage/documentFiles';
import { IFileStore, getNativeFileStore, joinPath, toFilePath } from '../../storage/nativeFileStore';
import { DocumentActivityRegistry, documentActivity as defaultActivity } from '../documents/documentActivity';
import { DocumentBusyError, DocumentStorageError } from '../../errors';
import { deletePdfLibraryDocument } from '../pdf/pdfLibrary';
import { defaultPdfiumEngine } from '../pdf/pdfiumEngine';
import { PDF_SOURCE_FILE_NAME, createPdfDocumentId } from '../pdf/pdfDocumentFiles';
import {
  ImagePdfPageSize,
  createPdfFromImageFiles,
  mergePdfFiles,
  renderPdfFileThumbnail,
} from '../pdf/pdfDocumentOperations';

export const MAX_TITLE_LENGTH = 120;

export interface LibraryDeps {
  readonly storage: IDocumentStorage;
  readonly activity: DocumentActivityRegistry;
  readonly fileStore: IFileStore | null;
}

function defaultDeps(): LibraryDeps {
  return { storage: defaultStorage, activity: defaultActivity, fileStore: getNativeFileStore() };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Validates a user-entered document name. Returns an error message or null. */
export function validateDocumentTitle(raw: string): string | null {
  const title = raw.trim();
  if (!title) return 'Enter a name.';
  if (title.length > MAX_TITLE_LENGTH) return `Use at most ${MAX_TITLE_LENGTH} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(title)) return 'Names cannot contain \\ / : * ? " < > |';
  return null;
}

/** Keeps the original extension for PDFs ("Report" -> "Report.pdf"). */
export function normalizeTitle(raw: string, kind: DocumentMetadata['kind']): string {
  const title = raw.trim().replace(/\s+/g, ' ');
  if (kind === 'pdf' && !/\.pdf$/i.test(title)) return `${title}.pdf`;
  return title;
}

/** "Report.pdf" -> "Report copy.pdf"; avoids names already in use. */
export function copyTitle(title: string, existing: readonly string[]): string {
  const match = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(title);
  const stem = (match?.[1] || title).replace(/ copy( \d+)?$/, '');
  const ext = match?.[2] ?? '';
  const taken = new Set(existing.map((t) => t.toLowerCase()));
  let candidate = `${stem} copy${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} copy ${n}${ext}`;
  return candidate;
}

/** Display name without the ".pdf" extension. */
export function displayTitle(title: string): string {
  return title.replace(/\.pdf$/i, '');
}

// ---------------------------------------------------------------------------
// Sorting / filtering
// ---------------------------------------------------------------------------

export type LibraryFilter = 'all' | 'pdf' | 'image';

export function filterAndSortDocuments(
  docs: readonly DocumentSummary[],
  query: string,
  filter: LibraryFilter,
  sort: 'recent' | 'name' | 'created',
): DocumentSummary[] {
  const q = query.trim().toLowerCase();
  const list = docs.filter(
    (d) => (filter === 'all' || d.metadata.kind === filter) && (!q || d.metadata.title.toLowerCase().includes(q)),
  );
  const byName = (a: DocumentSummary, b: DocumentSummary) =>
    a.metadata.title.localeCompare(b.metadata.title, undefined, { numeric: true, sensitivity: 'base' });
  return list.sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'created') return b.metadata.createdAt - a.metadata.createdAt || byName(a, b);
    return b.metadata.updatedAt - a.metadata.updatedAt || byName(a, b);
  });
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "Today 14:05", "Yesterday", weekday within a week, else a short date. */
export function formatRelativeDate(timestamp: number, now: number = Date.now()): string {
  const d = new Date(timestamp);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (timestamp >= startOfToday) return `Today ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (timestamp >= startOfToday - 86_400_000) return 'Yesterday';
  if (timestamp >= startOfToday - 6 * 86_400_000) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  }
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const thumbCache = new Map<string, string | null>();
const THUMB_PREFIX = 'thumb_';

function thumbKey(item: DocumentSummary): string {
  return `${item.id}:${item.metadata.updatedAt}:${item.metadata.sourceUri}`;
}

/**
 * Thumbnail URI for a library item: the image preview for image documents; for PDFs a
 * first-page render stored in the document directory (regenerated when the PDF changes).
 */
export async function getLibraryThumbnail(item: DocumentSummary, deps: LibraryDeps = defaultDeps()): Promise<string | null> {
  const key = thumbKey(item);
  if (thumbCache.has(key)) return thumbCache.get(key) ?? null;
  let uri: string | null = null;
  try {
    if (item.metadata.kind === 'image') {
      const doc = await deps.storage.getDocument(item.id);
      const content = doc?.pages[0]?.originalContent;
      uri = content?.previewUri || content?.assetUri || null;
    } else if (deps.fileStore && item.metadata.sourceUri) {
      const dir = await getDocumentDirectory(item.id, deps.fileStore);
      if (dir) {
        const name = `${THUMB_PREFIX}${item.metadata.updatedAt}.png`;
        const path = joinPath(dir, name);
        if (await deps.fileStore.exists(path)) {
          uri = `file://${path}`;
        } else {
          const rendered = await renderPdfFileThumbnail(toFilePath(item.metadata.sourceUri), path, 480);
          uri = rendered?.uri ?? null;
          if (uri) {
            // Older thumbnails of this document are obsolete.
            const entries = await deps.fileStore.listDirectory(dir).catch(() => [] as string[]);
            for (const entry of entries) {
              if (entry.startsWith(THUMB_PREFIX) && entry !== name) {
                await deps.fileStore.deletePath(joinPath(dir, entry)).catch(() => {});
              }
            }
          }
        }
      }
    }
  } catch {
    uri = null;
  }
  thumbCache.set(key, uri);
  return uri;
}

export function clearThumbnailCache(): void {
  thumbCache.clear();
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function assertNotBusy(id: string, activity: DocumentActivityRegistry): void {
  if (activity.isActive(id)) {
    throw new DocumentBusyError('This document is open or busy. Close it and try again.');
  }
}

export async function renameDocument(id: string, rawTitle: string, deps: LibraryDeps = defaultDeps()): Promise<Document> {
  const problem = validateDocumentTitle(rawTitle);
  if (problem) throw new DocumentStorageError(problem);
  assertNotBusy(id, deps.activity);
  const doc = await deps.storage.getDocument(id);
  if (!doc) throw new DocumentStorageError('The document no longer exists.');
  const title = normalizeTitle(rawTitle, doc.metadata.kind);
  const updated: Document = { ...doc, metadata: { ...doc.metadata, title, updatedAt: Date.now() } };
  await deps.storage.saveDocument(updated);
  return updated;
}

export async function duplicateDocument(id: string, deps: LibraryDeps = defaultDeps()): Promise<Document> {
  assertNotBusy(id, deps.activity);
  const doc = await deps.storage.getDocument(id);
  if (!doc) throw new DocumentStorageError('The document no longer exists.');
  const existing = (await deps.storage.listDocuments()).map((d) => d.metadata.title);
  const now = Date.now();
  const title = copyTitle(doc.metadata.title, existing);

  if (doc.metadata.kind === 'pdf') {
    if (!deps.fileStore) throw new DocumentStorageError('Duplicating needs on-device storage.');
    const newId = createPdfDocumentId(now);
    const dir = await getDocumentDirectory(newId, deps.fileStore);
    if (!dir) throw new DocumentStorageError('Storage is unavailable.');
    const target = joinPath(dir, PDF_SOURCE_FILE_NAME);
    await deps.fileStore.makeDirectory(dir);
    await deps.fileStore.copyFile(toFilePath(doc.metadata.sourceUri), target);
    const copy: Document = {
      id: newId,
      metadata: { ...doc.metadata, id: newId, title, sourceUri: target, createdAt: now, updatedAt: now },
      pages: [],
    };
    await deps.storage.saveDocument(copy);
    return copy;
  }

  const newId = `img-${now}`;
  // Saving under the new id copies every referenced asset/patch into the new directory.
  const copy: Document = JSON.parse(
    JSON.stringify({ ...doc, id: newId, metadata: { ...doc.metadata, id: newId, title, createdAt: now, updatedAt: now } }),
  );
  await deps.storage.saveDocument(copy);
  return copy;
}

export async function deleteLibraryDocument(item: DocumentSummary, deps: LibraryDeps = defaultDeps()): Promise<void> {
  if (item.metadata.kind === 'pdf') {
    await deletePdfLibraryDocument(item.id, { storage: deps.storage, activity: deps.activity, engine: defaultPdfiumEngine });
    return;
  }
  assertNotBusy(item.id, deps.activity);
  const release = deps.activity.markActive(item.id, 'deleting');
  try {
    await deps.storage.deleteDocument(item.id);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// New PDFs
// ---------------------------------------------------------------------------

async function registerNewPdf(
  id: string,
  path: string,
  title: string,
  pageCount: number,
  deps: LibraryDeps,
): Promise<Document> {
  const now = Date.now();
  const record: Document = {
    id,
    metadata: { id, title: normalizeTitle(title, 'pdf'), kind: 'pdf', sourceUri: path, pageCount, createdAt: now, updatedAt: now },
    pages: [],
  };
  await deps.storage.saveDocument(record);
  return record;
}

async function newPdfTarget(deps: LibraryDeps): Promise<{ id: string; dir: string; path: string }> {
  if (!deps.fileStore) throw new DocumentStorageError('Creating PDFs needs on-device storage.');
  const id = createPdfDocumentId();
  const dir = await getDocumentDirectory(id, deps.fileStore);
  if (!dir) throw new DocumentStorageError('Storage is unavailable.');
  await deps.fileStore.makeDirectory(dir);
  return { id, dir, path: joinPath(dir, PDF_SOURCE_FILE_NAME) };
}

export async function createPdfFromImages(
  imageUris: readonly string[],
  title: string,
  pageSize: ImagePdfPageSize = 'fit',
  deps: LibraryDeps = defaultDeps(),
): Promise<Document> {
  const target = await newPdfTarget(deps);
  try {
    const { pageCount } = await createPdfFromImageFiles(imageUris, target.path, pageSize, pageSize === 'fit' ? 0 : 24);
    return await registerNewPdf(target.id, target.path, title, pageCount, deps);
  } catch (err) {
    await deps.fileStore?.deletePath(target.dir).catch(() => {});
    throw err;
  }
}

export async function mergePdfDocuments(
  inputPaths: readonly string[],
  title: string,
  deps: LibraryDeps = defaultDeps(),
): Promise<Document> {
  const target = await newPdfTarget(deps);
  try {
    const { pageCount } = await mergePdfFiles(inputPaths.map(toFilePath), target.path);
    return await registerNewPdf(target.id, target.path, title, pageCount, deps);
  } catch (err) {
    await deps.fileStore?.deletePath(target.dir).catch(() => {});
    throw err;
  }
}

export function describeLibraryError(err: unknown): string {
  if (err instanceof DocumentBusyError) return 'This document is open or busy. Close it and try again.';
  const msg = err instanceof Error ? err.message : String(err);
  return msg || 'Something went wrong.';
}
