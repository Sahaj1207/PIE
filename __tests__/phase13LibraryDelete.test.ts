/**
 * Phase 13 — deleting a durable PDF from the library: storage cleanup, wrong-document /
 * path protection, active-operation blocking and cache cleanup.
 */
import { IFileStore } from '../src/storage/nativeFileStore';
import { FileSystemDocumentStorage } from '../src/storage/FileSystemDocumentStorage';
import { deletePdfLibraryDocument, describeLibraryDeleteError, SHARE_COPY_RETENTION_MS } from '../src/features/pdf/pdfLibrary';
import { createDocumentActivityRegistry, DocumentActivityRegistry } from '../src/features/documents/documentActivity';
import { DocumentBusyError, DocumentStorageError } from '../src/errors';
import { Document } from '../src/types/document';

const ROOT = '/data/app/files/pie';

type FakeFileStore = IFileStore & { files: Map<string, string>; dirs: Set<string> };

function createFakeFileStore(): FakeFileStore {
  const files = new Map<string, string>();
  const dirs = new Set<string>([ROOT]);
  const norm = (p: string) => (p.startsWith('file://') ? p.substring(7) : p).replace(/\/+$/, '');
  const dirname = (p: string) => p.substring(0, p.lastIndexOf('/'));
  const mkdirp = (p: string) => {
    const parts = norm(p).split('/');
    for (let i = 2; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };
  return {
    files,
    dirs,
    getRootPath: jest.fn(async () => ROOT),
    writeFileAtomic: jest.fn(async (path: string, contents: string) => {
      mkdirp(dirname(norm(path)));
      files.set(norm(path), contents);
    }),
    readFile: jest.fn(async (path: string) => {
      if (!files.has(norm(path))) throw new Error('not found');
      return files.get(norm(path))!;
    }),
    exists: jest.fn(async (path: string) => files.has(norm(path)) || dirs.has(norm(path))),
    copyFile: jest.fn(async (from: string, to: string) => {
      mkdirp(dirname(norm(to)));
      files.set(norm(to), files.get(norm(from))!);
    }),
    deletePath: jest.fn(async (path: string) => {
      const p = norm(path);
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d);
    }),
    listDirectory: jest.fn(async (path: string) => {
      const p = norm(path);
      const names = new Set<string>();
      for (const k of [...files.keys(), ...dirs]) {
        if (k.startsWith(`${p}/`)) names.add(k.substring(p.length + 1).split('/')[0]);
      }
      return [...names].sort();
    }),
    makeDirectory: jest.fn(async (path: string) => mkdirp(path)),
  };
}

function pdfRecord(id: string, sourceFile: string): Document {
  return {
    id,
    metadata: {
      id,
      title: `${id}.pdf`,
      kind: 'pdf',
      sourceUri: `${ROOT}/documents/${id}/${sourceFile}`,
      pageCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    pages: [],
  };
}

async function seedPdf(store: FakeFileStore, storage: FileSystemDocumentStorage, id: string) {
  store.files.set(`${ROOT}/documents/${id}/source.pdf`, `%PDF ${id} source`);
  store.files.set(`${ROOT}/documents/${id}/rev_100.pdf`, `%PDF ${id} rev`);
  store.files.set(`${ROOT}/sessions/${id}/working/working_1_1.pdf`, `%PDF ${id} working`);
  await storage.saveDocument(pdfRecord(id, 'rev_100.pdf'));
}

describe('Phase 13 — library delete', () => {
  let store: FakeFileStore;
  let storage: FileSystemDocumentStorage;
  let activity: DocumentActivityRegistry;
  let engine: { purgeRenderCache: jest.Mock; purgeImportCache: jest.Mock; purgeExportCache: jest.Mock };

  beforeEach(async () => {
    store = createFakeFileStore();
    storage = new FileSystemDocumentStorage(store);
    activity = createDocumentActivityRegistry();
    engine = {
      purgeRenderCache: jest.fn().mockResolvedValue(0),
      purgeImportCache: jest.fn().mockResolvedValue(0),
      purgeExportCache: jest.fn().mockResolvedValue(0),
    };
    await seedPdf(store, storage, 'pdf-1');
    await seedPdf(store, storage, 'pdf-10');
    await seedPdf(store, storage, 'pdf-1-copy');
  });

  const deps = () => ({ storage, activity, engine });
  const filesOf = (id: string) =>
    [...store.files.keys()].filter((k) => k.startsWith(`${ROOT}/documents/${id}/`) || k.startsWith(`${ROOT}/sessions/${id}/`));

  it('removes the record, source.pdf, revisions and session files of that document', async () => {
    expect(filesOf('pdf-1').length).toBeGreaterThan(0);
    await deletePdfLibraryDocument('pdf-1', deps());
    expect(filesOf('pdf-1')).toEqual([]);
    expect(await storage.getDocument('pdf-1')).toBeNull();
    expect((await storage.listDocuments()).map((d) => d.id).sort()).toEqual(['pdf-1-copy', 'pdf-10']);
  });

  it('never touches documents whose ids share a prefix', async () => {
    const before10 = filesOf('pdf-10');
    const beforeCopy = filesOf('pdf-1-copy');
    await deletePdfLibraryDocument('pdf-1', deps());
    expect(filesOf('pdf-10')).toEqual(before10);
    expect(filesOf('pdf-1-copy')).toEqual(beforeCopy);
    expect(store.files.get(`${ROOT}/documents/pdf-10/source.pdf`)).toBe('%PDF pdf-10 source');
  });

  // Unsafe path segments, plus a safe-looking id that has no record ("documents").
  it.each(['', '..', '.', '../pdf-10', 'pdf-1/../pdf-10', 'documents', '/abs'])(
    'rejects id %p without deleting anything',
    async (badId) => {
      await expect(deletePdfLibraryDocument(badId, deps())).rejects.toBeInstanceOf(DocumentStorageError);
      expect(store.deletePath).not.toHaveBeenCalled();
    },
  );

  it('refuses while the document is open / saving, and allows it after release', async () => {
    const release = activity.markActive('pdf-1', 'open');
    const releaseSaving = activity.markActive('pdf-1', 'saving');
    await expect(deletePdfLibraryDocument('pdf-1', deps())).rejects.toBeInstanceOf(DocumentBusyError);
    release();
    await expect(deletePdfLibraryDocument('pdf-1', deps())).rejects.toBeInstanceOf(DocumentBusyError);
    releaseSaving();
    expect(store.deletePath).not.toHaveBeenCalled();

    await deletePdfLibraryDocument('pdf-1', deps());
    expect(filesOf('pdf-1')).toEqual([]);
  });

  it('refuses non-PDF records and records that no longer exist', async () => {
    await storage.saveDocument({
      id: 'img-1',
      metadata: { id: 'img-1', title: 'photo', kind: 'image', sourceUri: '', pageCount: 1, createdAt: 1, updatedAt: 1 },
      pages: [],
    });
    await expect(deletePdfLibraryDocument('img-1', deps())).rejects.toThrow('Only PDF documents');
    await expect(deletePdfLibraryDocument('pdf-404', deps())).rejects.toThrow('no longer exists');
    expect(store.deletePath).not.toHaveBeenCalled();
  });

  it('purges shared caches only when no document is in use', async () => {
    await deletePdfLibraryDocument('pdf-1', deps());
    expect(engine.purgeRenderCache).toHaveBeenCalledWith([]);
    expect(engine.purgeImportCache).toHaveBeenCalledWith([]);
    expect(engine.purgeExportCache).toHaveBeenCalledWith(SHARE_COPY_RETENTION_MS);

    engine.purgeRenderCache.mockClear();
    const release = activity.markActive('pdf-10', 'open');
    await deletePdfLibraryDocument('pdf-1-copy', deps());
    expect(engine.purgeRenderCache).not.toHaveBeenCalled();
    release();
  });

  it('marks the document busy while deleting and releases it afterwards (even on failure)', async () => {
    let busyDuringDelete = false;
    const failing = {
      ...storage,
      getDocument: (id: string) => storage.getDocument(id),
      deleteDocument: jest.fn(async (id: string) => {
        busyDuringDelete = activity.isActive(id);
        throw new Error('io');
      }),
    } as any;
    await expect(deletePdfLibraryDocument('pdf-1', { storage: failing, activity })).rejects.toThrow('io');
    expect(busyDuringDelete).toBe(true);
    expect(activity.isActive('pdf-1')).toBe(false);
    expect(activity.hasAnyActive()).toBe(false);
  });

  it('busy errors are reported as-is to the user', () => {
    expect(describeLibraryDeleteError(new DocumentBusyError('This document is still open.'))).toBe(
      'This document is still open.',
    );
    expect(describeLibraryDeleteError(new Error('io'))).toMatch(/could not be deleted/);
  });
});

describe('Phase 13 — document activity registry', () => {
  it('tracks independent marks per document and releases idempotently', () => {
    const registry = createDocumentActivityRegistry();
    const a = registry.markActive('d1', 'open');
    const b = registry.markActive('d1', 'exporting');
    expect(registry.reasons('d1').sort()).toEqual(['exporting', 'open']);
    a();
    a();
    expect(registry.isActive('d1')).toBe(true);
    b();
    expect(registry.isActive('d1')).toBe(false);
    expect(registry.hasAnyActive()).toBe(false);
  });
});
