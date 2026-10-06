/**
 * Phase 10 — Durable image document storage (FileSystemDocumentStorage).
 *
 * Uses an in-memory fake of the native PieFileStoreModule contract (IFileStore).
 */
import { NativeModules } from 'react-native';
import { Document } from '../src/types/document';
import { IFileStore } from '../src/storage/nativeFileStore';
import {
  FileSystemDocumentStorage,
  DOCUMENT_RELATIVE_PREFIX,
  DOCUMENT_SCHEMA_VERSION,
} from '../src/storage/FileSystemDocumentStorage';
import { InMemoryDocumentStorage } from '../src/storage/InMemoryDocumentStorage';
import { createDefaultDocumentStorage } from '../src/storage';
import {
  assertSafeDocumentId,
  cleanupStaleEditingSessions,
  discardEditingSessionFiles,
  getDocumentDirectory,
  getSessionPatchDirectory,
  pruneUnreferencedDocumentFiles,
} from '../src/storage/documentFiles';
import {
  DocumentAssetMissingError,
  DocumentStorageCorruptedError,
  DocumentStorageError,
} from '../src/errors';

const ROOT = '/data/app/files/pie';

type FakeFileStore = IFileStore & {
  files: Map<string, string>;
  dirs: Set<string>;
};

function createFakeFileStore(root: string = ROOT): FakeFileStore {
  const files = new Map<string, string>();
  const dirs = new Set<string>([root]);
  const norm = (p: string) => (p.startsWith('file://') ? p.substring(7) : p).replace(/\/+$/, '');
  const dirname = (p: string) => p.substring(0, p.lastIndexOf('/'));
  const mkdirp = (p: string) => {
    const parts = norm(p).split('/');
    for (let i = 2; i <= parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  };

  return {
    files,
    dirs,
    getRootPath: jest.fn(async () => root),
    writeFileAtomic: jest.fn(async (path: string, contents: string) => {
      const p = norm(path);
      mkdirp(dirname(p));
      files.set(p, contents);
    }),
    readFile: jest.fn(async (path: string) => {
      const p = norm(path);
      if (!files.has(p)) {
        throw Object.assign(new Error(`not found: ${p}`), { code: 'FILE_STORE_NOT_FOUND' });
      }
      return files.get(p)!;
    }),
    exists: jest.fn(async (path: string) => {
      const p = norm(path);
      return files.has(p) || dirs.has(p);
    }),
    copyFile: jest.fn(async (from: string, to: string) => {
      const f = norm(from);
      if (!files.has(f)) throw new Error(`missing source ${f}`);
      const t = norm(to);
      mkdirp(dirname(t));
      files.set(t, files.get(f)!);
    }),
    deletePath: jest.fn(async (path: string) => {
      const p = norm(path);
      for (const k of [...files.keys()]) {
        if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      }
      for (const d of [...dirs]) {
        if (d === p || d.startsWith(`${p}/`)) dirs.delete(d);
      }
    }),
    listDirectory: jest.fn(async (path: string) => {
      const p = norm(path);
      const names = new Set<string>();
      for (const k of [...files.keys(), ...dirs]) {
        if (k.startsWith(`${p}/`)) names.add(k.substring(p.length + 1).split('/')[0]);
      }
      return [...names].sort();
    }),
    makeDirectory: jest.fn(async (path: string) => {
      mkdirp(path);
    }),
  };
}

const DOC_ID = 'doc-1700000000000';
const DOC_DIR = `${ROOT}/documents/${DOC_ID}`;
const SESSION_PATCH = `${ROOT}/sessions/${DOC_ID}/patches/patch_1_abcd1234.png`;

function createImageDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: DOC_ID,
    metadata: {
      id: DOC_ID,
      title: 'Receipt.jpg',
      kind: 'image',
      sourceUri: 'content://media/external/images/media/42',
      pageCount: 1,
      createdAt: 1000,
      updatedAt: 2000,
    },
    pages: [
      {
        id: `page-${DOC_ID}-0`,
        pageIndex: 0,
        dimensions: { width: 3000, height: 4000 },
        rotation: 0,
        originalContent: {
          pageIndex: 0,
          assetUri: `file://${DOC_DIR}/assets/working.jpg`,
          previewUri: `file://${DOC_DIR}/assets/preview.jpg`,
          width: 3000,
          height: 4000,
          sourceOrientation: 6,
        },
        editableTextRegions: [
          {
            id: 'text-region-0-abc-1',
            pageIndex: 0,
            bounds: { x: 100, y: 200, width: 600, height: 80 },
            originalBounds: { x: 100, y: 200, width: 600, height: 80 },
            originalText: 'TOTAL 10.00',
            currentText: 'TOTAL 12.50',
            status: 'modified',
            style: { fontSize: 60, color: '#111111', fontWeight: 'bold', fontStyle: 'italic' },
            reconstructedPatchUri: `file://${SESSION_PATCH}`,
            reconstructedPatchBounds: { x: 95, y: 195, width: 610, height: 90 },
          },
          {
            id: 'text-region-0-abc-2',
            pageIndex: 0,
            bounds: { x: 100, y: 400, width: 300, height: 50 },
            originalText: 'Thank you',
            currentText: 'Thank you',
            status: 'detected',
            style: { fontSize: 38, color: '#000000' },
            confidence: 0.97,
          },
        ],
        addedText: [
          {
            id: 'added-1',
            pageIndex: 0,
            bounds: { x: 1200, y: 3000, width: 400, height: 60 },
            text: 'PAID',
            style: { fontSize: 48, color: '#DC2626', fontWeight: 'bold', fontStyle: 'normal' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function seedImageFiles(store: FakeFileStore) {
  store.files.set(`${DOC_DIR}/assets/working.jpg`, 'WORKING_BYTES');
  store.files.set(`${DOC_DIR}/assets/preview.jpg`, 'PREVIEW_BYTES');
  store.files.set(SESSION_PATCH, 'PATCH_BYTES');
}

describe('Phase 10 — FileSystemDocumentStorage', () => {
  let store: FakeFileStore;
  let storage: FileSystemDocumentStorage;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    store = createFakeFileStore();
    storage = new FileSystemDocumentStorage(store);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('1. Save / reopen round trip', () => {
    it('restores the exact document-space model after save and reopen', async () => {
      seedImageFiles(store);
      const doc = createImageDocument();
      await storage.saveDocument(doc);

      const reopened = await storage.getDocument(DOC_ID);
      expect(reopened).not.toBeNull();
      const page = reopened!.pages[0];
      const original = doc.pages[0];

      // Document-space geometry, OCR regions, edits and added text are preserved exactly
      expect(page.dimensions).toEqual(original.dimensions);
      expect(page.addedText).toEqual(original.addedText);
      expect(page.editableTextRegions[1]).toEqual(original.editableTextRegions[1]);
      const edited = page.editableTextRegions[0];
      expect(edited.status).toBe('modified');
      expect(edited.currentText).toBe('TOTAL 12.50');
      expect(edited.bounds).toEqual(original.editableTextRegions[0].bounds);
      expect(edited.reconstructedPatchBounds).toEqual(original.editableTextRegions[0].reconstructedPatchBounds);
      expect(edited.style).toEqual(original.editableTextRegions[0].style);
      expect(page.originalContent.sourceOrientation).toBe(6);
      expect(reopened!.metadata).toEqual(doc.metadata);
    });

    it('persists references relative to the document directory', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());

      const raw = JSON.parse(store.files.get(`${DOC_DIR}/document.json`)!);
      expect(raw.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
      const page = raw.document.pages[0];
      expect(page.originalContent.assetUri).toBe(`${DOCUMENT_RELATIVE_PREFIX}assets/working.jpg`);
      expect(page.originalContent.previewUri).toBe(`${DOCUMENT_RELATIVE_PREFIX}assets/preview.jpg`);
      expect(page.editableTextRegions[0].reconstructedPatchUri).toBe(
        `${DOCUMENT_RELATIVE_PREFIX}patches/patch_1_abcd1234.png`,
      );
      // The original source reference is kept unchanged (never rewritten or copied over)
      expect(raw.document.metadata.sourceUri).toBe('content://media/external/images/media/42');
    });

    it('resolves relative references to absolute file URIs on reopen', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      const reopened = await storage.getDocument(DOC_ID);
      const page = reopened!.pages[0];
      expect(page.originalContent.assetUri).toBe(`file://${DOC_DIR}/assets/working.jpg`);
      expect(page.originalContent.previewUri).toBe(`file://${DOC_DIR}/assets/preview.jpg`);
      expect(page.editableTextRegions[0].reconstructedPatchUri).toBe(
        `file://${DOC_DIR}/patches/patch_1_abcd1234.png`,
      );
    });

    it('copies session patches into the document patches directory on save', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      expect(store.files.get(`${DOC_DIR}/patches/patch_1_abcd1234.png`)).toBe('PATCH_BYTES');
      // Session file itself is left for the session lifecycle to clean up
      expect(store.files.has(SESSION_PATCH)).toBe(true);
    });

    it('adopts an external working image (legacy import path) into document assets', async () => {
      store.files.set('/data/app/cache/imported_images/123_photo.jpg', 'CACHE_BYTES');
      store.files.set(SESSION_PATCH, 'PATCH_BYTES');
      const doc = createImageDocument();
      const legacy: Document = {
        ...doc,
        pages: [
          {
            ...doc.pages[0],
            originalContent: {
              pageIndex: 0,
              assetUri: 'file:///data/app/cache/imported_images/123_photo.jpg',
              width: 3000,
              height: 4000,
            },
          },
        ],
      };
      await storage.saveDocument(legacy);
      expect(store.files.get(`${DOC_DIR}/assets/123_photo.jpg`)).toBe('CACHE_BYTES');
      // Source cache file untouched
      expect(store.files.get('/data/app/cache/imported_images/123_photo.jpg')).toBe('CACHE_BYTES');
      const reopened = await storage.getDocument(DOC_ID);
      expect(reopened!.pages[0].originalContent.assetUri).toBe(`file://${DOC_DIR}/assets/123_photo.jpg`);
    });

    it('writes every document through the atomic write primitive', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      expect(store.writeFileAtomic).toHaveBeenCalledTimes(1);
      expect((store.writeFileAtomic as jest.Mock).mock.calls[0][0]).toBe(`${DOC_DIR}/document.json`);
    });

    it('never persists viewport transforms or editor UI state', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      await storage.saveEditorSession({
        documentId: DOC_ID,
        activePageIndex: 0,
        toolMode: 'select',
        selection: null,
        viewportTransform: { scale: 0.25, translateX: 10, translateY: 20 },
        hasUnsavedChanges: true,
        undoStackDepth: 3,
        redoStackDepth: 0,
      });

      const persisted = [...store.files.values()].join('\n');
      expect(persisted).not.toContain('translateX');
      expect(persisted).not.toContain('viewportTransform');
      expect(store.writeFileAtomic).toHaveBeenCalledTimes(1);
      // Session state is still retrievable within the process
      expect((await storage.getEditorSession(DOC_ID))?.undoStackDepth).toBe(3);
    });

    it('persists PDF document records unchanged (no asset rewriting)', async () => {
      const pdfDoc: Document = {
        id: 'pdf-1700000000001',
        metadata: {
          id: 'pdf-1700000000001',
          title: 'Contract.pdf',
          kind: 'pdf',
          sourceUri: '/data/app/cache/picked_pdfs/contract_edited.pdf',
          pageCount: 3,
          createdAt: 5,
          updatedAt: 6,
        },
        pages: [],
      };
      await storage.saveDocument(pdfDoc);
      expect(await storage.getDocument(pdfDoc.id)).toEqual(pdfDoc);
      expect(store.copyFile).not.toHaveBeenCalled();
    });
  });

  describe('2. Reopen validation and failure handling', () => {
    it('returns null for an unknown document', async () => {
      expect(await storage.getDocument('doc-missing')).toBeNull();
    });

    it('rejects corrupted JSON with a typed error', async () => {
      store.files.set(`${DOC_DIR}/document.json`, '{ not valid json');
      await expect(storage.getDocument(DOC_ID)).rejects.toBeInstanceOf(DocumentStorageCorruptedError);
    });

    it('rejects an unsupported schema version with a typed error', async () => {
      store.files.set(
        `${DOC_DIR}/document.json`,
        JSON.stringify({ schemaVersion: 99, savedAt: 1, document: createImageDocument() }),
      );
      await expect(storage.getDocument(DOC_ID)).rejects.toBeInstanceOf(DocumentStorageCorruptedError);
    });

    it('rejects an envelope whose document id does not match its directory', async () => {
      store.files.set(
        `${DOC_DIR}/document.json`,
        JSON.stringify({
          schemaVersion: DOCUMENT_SCHEMA_VERSION,
          savedAt: 1,
          document: createImageDocument({ id: 'doc-other' }),
        }),
      );
      await expect(storage.getDocument(DOC_ID)).rejects.toBeInstanceOf(DocumentStorageCorruptedError);
    });

    it('throws DocumentAssetMissingError when the working image is gone', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      store.files.delete(`${DOC_DIR}/assets/working.jpg`);
      await expect(storage.getDocument(DOC_ID)).rejects.toBeInstanceOf(DocumentAssetMissingError);
    });

    it('flags regions whose patch file is missing instead of crashing', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      store.files.delete(`${DOC_DIR}/patches/patch_1_abcd1234.png`);

      const reopened = await storage.getDocument(DOC_ID);
      const region = reopened!.pages[0].editableTextRegions[0];
      expect(region.status).toBe('modified');
      expect(region.currentText).toBe('TOTAL 12.50');
      expect(region.reconstructedPatchUri).toBeUndefined();
      expect(region.patchUnavailable).toBe(true);
    });

    it('falls back to the working image when the display preview is missing', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      store.files.delete(`${DOC_DIR}/assets/preview.jpg`);
      const reopened = await storage.getDocument(DOC_ID);
      expect(reopened!.pages[0].originalContent.previewUri).toBeUndefined();
      expect(reopened!.pages[0].originalContent.assetUri).toBe(`file://${DOC_DIR}/assets/working.jpg`);
    });

    it('rejects unsafe document ids on save and treats them as unknown on read', async () => {
      await expect(
        storage.saveDocument(createImageDocument({ id: '../escape' })),
      ).rejects.toBeInstanceOf(DocumentStorageError);
      expect(await storage.getDocument('../escape')).toBeNull();
      expect(() => assertSafeDocumentId('a/b')).toThrow(DocumentStorageError);
      expect(() => assertSafeDocumentId('doc-123_ok.v2')).not.toThrow();
    });

    it('surfaces write failures as DocumentStorageError', async () => {
      seedImageFiles(store);
      (store.writeFileAtomic as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await expect(storage.saveDocument(createImageDocument())).rejects.toBeInstanceOf(
        DocumentStorageError,
      );
    });
  });

  describe('3. Library listing and deletion', () => {
    it('lists documents newest first and skips unreadable entries', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      await storage.saveDocument({
        id: 'pdf-2',
        metadata: {
          id: 'pdf-2',
          title: 'Newer.pdf',
          kind: 'pdf',
          sourceUri: '/x/newer.pdf',
          pageCount: 1,
          createdAt: 1,
          updatedAt: 9999,
        },
        pages: [],
      });
      store.files.set(`${ROOT}/documents/doc-broken/document.json`, '{oops');

      const list = await storage.listDocuments();
      expect(list.map((d) => d.id)).toEqual(['pdf-2', DOC_ID]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('deleteDocument removes the document directory and its session files', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      await storage.deleteDocument(DOC_ID);
      expect(await storage.getDocument(DOC_ID)).toBeNull();
      expect([...store.files.keys()].some((k) => k.startsWith(DOC_DIR))).toBe(false);
      expect([...store.files.keys()].some((k) => k.startsWith(`${ROOT}/sessions/${DOC_ID}`))).toBe(false);
    });

    it('survives a simulated app restart (new storage instance, same files)', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());

      const afterRestart = new FileSystemDocumentStorage(store);
      const list = await afterRestart.listDocuments();
      expect(list.map((d) => d.id)).toEqual([DOC_ID]);
      const reopened = await afterRestart.getDocument(DOC_ID);
      expect(reopened!.pages[0].editableTextRegions).toHaveLength(2);
      expect(reopened!.pages[0].addedText[0].text).toBe('PAID');
    });
  });

  describe('4. Session file lifecycle helpers', () => {
    it('resolves document and session patch directories under the storage root', async () => {
      expect(await getDocumentDirectory(DOC_ID, store)).toBe(DOC_DIR);
      expect(await getSessionPatchDirectory(DOC_ID, store)).toBe(`${ROOT}/sessions/${DOC_ID}/patches`);
      expect(store.dirs.has(`${ROOT}/sessions/${DOC_ID}/patches`)).toBe(true);
    });

    it('returns null directories when no native file store is linked', async () => {
      expect(await getDocumentDirectory(DOC_ID, null)).toBeNull();
      expect(await getSessionPatchDirectory(DOC_ID, null)).toBeNull();
      await expect(discardEditingSessionFiles(DOC_ID, null)).resolves.toBeUndefined();
      await expect(cleanupStaleEditingSessions(null)).resolves.toBeUndefined();
    });

    it('discardEditingSessionFiles removes only that document session', async () => {
      store.files.set(SESSION_PATCH, 'PATCH');
      store.files.set(`${ROOT}/sessions/doc-other/patches/p.png`, 'OTHER');
      await discardEditingSessionFiles(DOC_ID, store);
      expect(store.files.has(SESSION_PATCH)).toBe(false);
      expect(store.files.has(`${ROOT}/sessions/doc-other/patches/p.png`)).toBe(true);
    });

    it('cleanupStaleEditingSessions removes all leftover session directories', async () => {
      store.files.set(SESSION_PATCH, 'PATCH');
      store.files.set(`${ROOT}/sessions/doc-other/patches/p.png`, 'OTHER');
      await cleanupStaleEditingSessions(store);
      expect([...store.files.keys()].some((k) => k.startsWith(`${ROOT}/sessions`))).toBe(false);
    });

    it('prunes only patch files the persisted document no longer references', async () => {
      seedImageFiles(store);
      await storage.saveDocument(createImageDocument());
      store.files.set(`${DOC_DIR}/patches/patch_old_ffff0000.png`, 'STALE');

      const removed = await pruneUnreferencedDocumentFiles(DOC_ID, storage, store);
      expect(removed).toBe(1);
      expect(store.files.has(`${DOC_DIR}/patches/patch_old_ffff0000.png`)).toBe(false);
      expect(store.files.has(`${DOC_DIR}/patches/patch_1_abcd1234.png`)).toBe(true);
      expect(store.files.has(`${DOC_DIR}/assets/working.jpg`)).toBe(true);
    });
  });

  describe('5. Storage selection', () => {
    afterEach(() => {
      delete (NativeModules as any).PieFileStoreModule;
    });

    it('uses in-memory storage when the native file store is not linked', () => {
      delete (NativeModules as any).PieFileStoreModule;
      expect(createDefaultDocumentStorage()).toBeInstanceOf(InMemoryDocumentStorage);
    });

    it('uses durable file storage when the native file store is linked', () => {
      (NativeModules as any).PieFileStoreModule = createFakeFileStore();
      expect(createDefaultDocumentStorage()).toBeInstanceOf(FileSystemDocumentStorage);
    });
  });
});
