import { Document, DocumentMetadata, DocumentPage, TextRegion } from '../types/document';
import { DocumentSummary } from '../features/documents/types';
import { EditorSessionState } from '../features/editor/types';
import {
  DocumentAssetMissingError,
  DocumentStorageCorruptedError,
  DocumentStorageError,
} from '../errors';
import { IDocumentStorage } from './types';
import {
  IFileStore,
  baseName,
  isPathInside,
  joinPath,
  toFilePath,
  toFileUri,
} from './nativeFileStore';
import {
  DOCUMENTS_DIR,
  DOCUMENT_ASSETS_DIR,
  DOCUMENT_FILE_NAME,
  DOCUMENT_PATCHES_DIR,
  SESSIONS_DIR,
  assertSafeDocumentId,
} from './documentFiles';

/** Current on-disk envelope schema. Bump only with an explicit migration. */
export const DOCUMENT_SCHEMA_VERSION = 1;

/**
 * Prefix marking a URI stored relative to its document directory. Persisting relative
 * references keeps documents valid if the app-private root path changes (e.g. restore).
 */
export const DOCUMENT_RELATIVE_PREFIX = 'pie-doc:';

export interface PersistedDocumentEnvelope {
  readonly schemaVersion: number;
  readonly savedAt: number;
  readonly document: Document;
}

type UriMapper = (uri: string, subdir: string) => Promise<string>;

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('file://') || uri.startsWith('/');
}

/**
 * Durable, offline document storage backed by the app-private filesystem.
 *
 * Persists only document-space data (the canonical Document model). Viewport transforms
 * and editor UI state are never written to disk. Image assets and reconstruction patches
 * referenced by a saved document are copied into the document's own directory so the
 * document can be reopened after cache eviction or app restart. Source images outside the
 * app are never modified.
 */
export class FileSystemDocumentStorage implements IDocumentStorage {
  private rootPath: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Editor session state is intentionally memory-only (contains viewport transforms). */
  private readonly sessions = new Map<string, EditorSessionState>();

  constructor(private readonly fileStore: IFileStore) {}

  async listDocuments(): Promise<DocumentSummary[]> {
    return this.enqueue(async () => {
      const documentsDir = joinPath(await this.getRoot(), DOCUMENTS_DIR);
      const entries = await this.fileStore.listDirectory(documentsDir);
      const list: DocumentSummary[] = [];

      for (const id of entries) {
        try {
          assertSafeDocumentId(id);
          const envelope = await this.readEnvelope(id);
          if (envelope) {
            const docDir = joinPath(documentsDir, id);
            list.push({
              id: envelope.document.id,
              metadata: this.resolvePdfMetadata(envelope.document.metadata, docDir),
            });
          }
        } catch (err) {
          // A single unreadable document must not hide the rest of the library.
          console.warn(`[PHASE10_STORAGE] Skipping unreadable document "${id}":`, err);
        }
      }

      return list.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
    });
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.enqueue(async () => {
      try {
        assertSafeDocumentId(id);
      } catch {
        return null;
      }
      const envelope = await this.readEnvelope(id);
      if (!envelope) return null;
      const docDir = await this.documentDir(id);
      return this.resolveDocument(envelope.document, docDir);
    });
  }

  async saveDocument(document: Document): Promise<void> {
    return this.enqueue(async () => {
      if (!document || !document.id || !document.metadata || !Array.isArray(document.pages)) {
        throw new DocumentStorageError('Cannot save an invalid document model.');
      }
      assertSafeDocumentId(document.id);

      const docDir = await this.documentDir(document.id);
      await this.fileStore.makeDirectory(docDir);

      const persistable = await this.externalizeDocument(document, docDir);
      const envelope: PersistedDocumentEnvelope = {
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        savedAt: Date.now(),
        document: persistable,
      };

      try {
        await this.fileStore.writeFileAtomic(
          joinPath(docDir, DOCUMENT_FILE_NAME),
          JSON.stringify(envelope),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DocumentStorageError(`Failed to write document "${document.id}": ${msg}`, err);
      }
    });
  }

  async deleteDocument(id: string): Promise<void> {
    return this.enqueue(async () => {
      assertSafeDocumentId(id);
      const root = await this.getRoot();
      await this.fileStore.deletePath(joinPath(root, DOCUMENTS_DIR, id));
      await this.fileStore.deletePath(joinPath(root, SESSIONS_DIR, id));
      this.sessions.delete(id);
    });
  }

  async saveEditorSession(state: EditorSessionState): Promise<void> {
    this.sessions.set(state.documentId, JSON.parse(JSON.stringify(state)));
  }

  async getEditorSession(documentId: string): Promise<EditorSessionState | null> {
    const session = this.sessions.get(documentId);
    return session ? JSON.parse(JSON.stringify(session)) : null;
  }

  // ---------------------------------------------------------------------------

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async getRoot(): Promise<string> {
    if (!this.rootPath) {
      const root = await this.fileStore.getRootPath();
      if (!root) {
        throw new DocumentStorageError('Document storage root is unavailable.');
      }
      this.rootPath = root;
    }
    return this.rootPath;
  }

  private async documentDir(id: string): Promise<string> {
    return joinPath(await this.getRoot(), DOCUMENTS_DIR, id);
  }

  private async readEnvelope(id: string): Promise<PersistedDocumentEnvelope | null> {
    const filePath = joinPath(await this.documentDir(id), DOCUMENT_FILE_NAME);
    if (!(await this.fileStore.exists(filePath))) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.fileStore.readFile(filePath));
    } catch (err) {
      throw new DocumentStorageCorruptedError(`Document "${id}" could not be parsed.`, err);
    }

    const envelope = parsed as PersistedDocumentEnvelope;
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      envelope.schemaVersion !== DOCUMENT_SCHEMA_VERSION ||
      !envelope.document ||
      envelope.document.id !== id ||
      !envelope.document.metadata ||
      !Array.isArray(envelope.document.pages)
    ) {
      throw new DocumentStorageCorruptedError(
        `Document "${id}" has an unsupported or invalid storage envelope.`,
      );
    }
    return envelope;
  }

  /** Rewrites asset URIs to document-relative references, copying external files in. */
  private async externalizeDocument(document: Document, docDir: string): Promise<Document> {
    if (document.metadata.kind !== 'image') {
      // PDF records: the PDF file is written by the PDF editor. When it lives inside this
      // document's directory (durable saved revision) it is stored document-relative.
      const sourceUri = document.metadata.sourceUri;
      if (sourceUri && isLocalFileUri(sourceUri) && isPathInside(toFilePath(sourceUri), docDir)) {
        const relative = DOCUMENT_RELATIVE_PREFIX + toFilePath(sourceUri).substring(docDir.length + 1);
        return JSON.parse(
          JSON.stringify({ ...document, metadata: { ...document.metadata, sourceUri: relative } }),
        );
      }
      return JSON.parse(JSON.stringify(document));
    }

    const mapUri: UriMapper = async (uri, subdir) => {
      if (!uri || uri.startsWith(DOCUMENT_RELATIVE_PREFIX) || !isLocalFileUri(uri)) {
        return uri;
      }
      const path = toFilePath(uri);
      if (isPathInside(path, docDir)) {
        return DOCUMENT_RELATIVE_PREFIX + path.substring(docDir.length + 1);
      }
      if (!(await this.fileStore.exists(path))) {
        // Cannot adopt a file that no longer exists; keep the reference unchanged.
        return uri;
      }
      const name = baseName(path);
      const destPath = joinPath(docDir, subdir, name);
      if (!(await this.fileStore.exists(destPath))) {
        await this.fileStore.copyFile(path, destPath);
      }
      return `${DOCUMENT_RELATIVE_PREFIX}${subdir}/${name}`;
    };

    const pages: DocumentPage[] = [];
    for (const page of document.pages) {
      pages.push(await this.mapPageUris(page, mapUri));
    }
    return JSON.parse(JSON.stringify({ ...document, pages }));
  }

  /** Resolves document-relative references and validates referenced files on reopen. */
  private async resolveDocument(document: Document, docDir: string): Promise<Document> {
    if (document.metadata.kind !== 'image') {
      return { ...document, metadata: this.resolvePdfMetadata(document.metadata, docDir) };
    }

    const resolve = (uri: string): string =>
      uri.startsWith(DOCUMENT_RELATIVE_PREFIX)
        ? toFileUri(joinPath(docDir, uri.substring(DOCUMENT_RELATIVE_PREFIX.length)))
        : uri;

    const pages: DocumentPage[] = [];
    for (const page of document.pages) {
      const assetUri = page.originalContent?.assetUri ? resolve(page.originalContent.assetUri) : undefined;
      if (assetUri && isLocalFileUri(assetUri) && !(await this.fileStore.exists(toFilePath(assetUri)))) {
        throw new DocumentAssetMissingError(
          `The image file for document "${document.id}" is missing from device storage.`,
        );
      }

      let previewUri = page.originalContent?.previewUri ? resolve(page.originalContent.previewUri) : undefined;
      if (previewUri && isLocalFileUri(previewUri) && !(await this.fileStore.exists(toFilePath(previewUri)))) {
        // Display proxy is optional: fall back to the full-resolution working image.
        previewUri = undefined;
      }

      const regions: TextRegion[] = [];
      for (const region of page.editableTextRegions || []) {
        if (!region.reconstructedPatchUri) {
          regions.push(region);
          continue;
        }
        const patchUri = resolve(region.reconstructedPatchUri);
        const available = !isLocalFileUri(patchUri) || (await this.fileStore.exists(toFilePath(patchUri)));
        if (available) {
          const { patchUnavailable: _ignored, ...rest } = region;
          regions.push({ ...rest, reconstructedPatchUri: patchUri });
        } else {
          const { reconstructedPatchUri: _missing, ...rest } = region;
          regions.push({ ...rest, patchUnavailable: true });
        }
      }

      const originalContent = { ...page.originalContent };
      if (assetUri) {
        (originalContent as { assetUri?: string }).assetUri = assetUri;
      }
      if (previewUri) {
        (originalContent as { previewUri?: string }).previewUri = previewUri;
      } else {
        delete (originalContent as { previewUri?: string }).previewUri;
      }

      pages.push({ ...page, originalContent, editableTextRegions: regions });
    }

    return { ...document, pages };
  }

  /** Resolves a document-relative PDF sourceUri to an absolute path (PDF records only). */
  private resolvePdfMetadata(metadata: DocumentMetadata, docDir: string): DocumentMetadata {
    if (
      metadata.kind === 'pdf' &&
      typeof metadata.sourceUri === 'string' &&
      metadata.sourceUri.startsWith(DOCUMENT_RELATIVE_PREFIX)
    ) {
      return {
        ...metadata,
        sourceUri: joinPath(docDir, metadata.sourceUri.substring(DOCUMENT_RELATIVE_PREFIX.length)),
      };
    }
    return metadata;
  }

  private async mapPageUris(page: DocumentPage, mapUri: UriMapper): Promise<DocumentPage> {
    const originalContent = { ...page.originalContent };
    if (page.originalContent?.assetUri) {
      (originalContent as { assetUri?: string }).assetUri = await mapUri(
        page.originalContent.assetUri,
        DOCUMENT_ASSETS_DIR,
      );
    }
    if (page.originalContent?.previewUri) {
      (originalContent as { previewUri?: string }).previewUri = await mapUri(
        page.originalContent.previewUri,
        DOCUMENT_ASSETS_DIR,
      );
    }

    const regions: TextRegion[] = [];
    for (const region of page.editableTextRegions || []) {
      if (region.reconstructedPatchUri) {
        regions.push({
          ...region,
          reconstructedPatchUri: await mapUri(region.reconstructedPatchUri, DOCUMENT_PATCHES_DIR),
        });
      } else {
        regions.push(region);
      }
    }

    return { ...page, originalContent, editableTextRegions: regions };
  }
}
