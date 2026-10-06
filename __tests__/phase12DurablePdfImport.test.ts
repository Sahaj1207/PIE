/**
 * Phase 12 — durable PDF import (no dependency on purgeable cache) and import-cache cleanup.
 */
import { NativeModules } from 'react-native';
import { IFileStore } from '../src/storage/nativeFileStore';
import { FileSystemDocumentStorage, DOCUMENT_RELATIVE_PREFIX } from '../src/storage/FileSystemDocumentStorage';
import {
  PDF_SOURCE_FILE_NAME,
  createDurablePdfRevisionPath,
  discardImportedPdf,
  ensureDurablePdfSource,
  pruneDurablePdfRevisions,
} from '../src/features/pdf/pdfDocumentFiles';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { DocumentStorageError } from '../src/errors';
import { Document } from '../src/types/document';

// Node global (Jest runs on Node), typed locally: the React Native tsconfig loads only jest types.
declare const __dirname: string;

const ROOT = '/data/app/files/pie';
const PICKED = '/data/app/cache/picked_pdfs/1700000000000_contract.pdf';
const DOC_ID = 'pdf-1700000000001';
const DOC_DIR = `${ROOT}/documents/${DOC_ID}`;

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
      if (!files.has(norm(from))) throw new Error(`Source file not found: ${from}`);
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

describe('Phase 12 — durable PDF import', () => {
  let store: FakeFileStore;

  beforeEach(() => {
    store = createFakeFileStore();
    store.files.set(PICKED, '%PDF-1.7 original bytes');
  });

  it('copies a picked (cache) PDF into documents/<id>/source.pdf before it is opened', async () => {
    const source = await ensureDurablePdfSource(PICKED, DOC_ID, store);
    expect(source).toEqual({ path: `${DOC_DIR}/${PDF_SOURCE_FILE_NAME}`, imported: true });
    expect(store.files.get(`${DOC_DIR}/source.pdf`)).toBe('%PDF-1.7 original bytes');
    expect(store.copyFile).toHaveBeenCalledWith(PICKED, `${DOC_DIR}/source.pdf`);
  });

  it('never modifies the picked input (source immutability)', async () => {
    await ensureDurablePdfSource(`file://${PICKED}`, DOC_ID, store);
    expect(store.files.get(PICKED)).toBe('%PDF-1.7 original bytes');
    expect(store.writeFileAtomic).not.toHaveBeenCalled();
    expect(store.deletePath).not.toHaveBeenCalled();
  });

  it('opens library documents that are already durable unchanged (no re-import)', async () => {
    const saved = `${DOC_DIR}/rev_1700000000500.pdf`;
    store.files.set(saved, 'saved');
    await expect(ensureDurablePdfSource(saved, DOC_ID, store)).resolves.toEqual({ path: saved, imported: false });
    await expect(ensureDurablePdfSource(`${DOC_DIR}/source.pdf`, DOC_ID, store)).resolves.toEqual({
      path: `${DOC_DIR}/source.pdf`,
      imported: false,
    });
    expect(store.copyFile).not.toHaveBeenCalled();
  });

  it('falls back to the input path only without durable storage or for content:// URIs', async () => {
    await expect(ensureDurablePdfSource(PICKED, DOC_ID, null)).resolves.toEqual({ path: PICKED, imported: false });
    await expect(ensureDurablePdfSource('content://docs/42', DOC_ID, store)).resolves.toEqual({
      path: 'content://docs/42',
      imported: false,
    });
  });

  it('a failed copy is a typed error, never a silent fallback to the cache file', async () => {
    store.files.delete(PICKED); // cache purged by the OS before import
    await expect(ensureDurablePdfSource(PICKED, DOC_ID, store)).rejects.toBeInstanceOf(DocumentStorageError);
    await expect(ensureDurablePdfSource(PICKED, DOC_ID, store)).rejects.toThrow(
      'Could not import the PDF into app storage',
    );
  });

  it('rejects unsafe document ids before touching storage', async () => {
    await expect(ensureDurablePdfSource(PICKED, '../evil', store)).rejects.toBeInstanceOf(DocumentStorageError);
    expect(store.copyFile).not.toHaveBeenCalled();
  });

  it('discardImportedPdf removes only that document directory', async () => {
    await ensureDurablePdfSource(PICKED, DOC_ID, store);
    store.files.set(`${ROOT}/documents/other/source.pdf`, 'other');
    await discardImportedPdf(DOC_ID, store);
    expect(store.files.has(`${DOC_DIR}/source.pdf`)).toBe(false);
    expect(store.files.get(`${ROOT}/documents/other/source.pdf`)).toBe('other');
    expect(store.files.get(PICKED)).toBe('%PDF-1.7 original bytes');
  });

  it('the imported source is never pruned with obsolete saved revisions', async () => {
    await ensureDurablePdfSource(PICKED, DOC_ID, store);
    const rev1 = (await createDurablePdfRevisionPath(DOC_ID, store, 100))!;
    const rev2 = (await createDurablePdfRevisionPath(DOC_ID, store, 200))!;
    store.files.set(rev1, 'r1');
    store.files.set(rev2, 'r2');
    const removed = await pruneDurablePdfRevisions(DOC_ID, [rev2], store);
    expect(removed).toBe(1);
    expect(store.files.has(`${DOC_DIR}/source.pdf`)).toBe(true);
    expect(store.files.has(rev2)).toBe(true);
  });

  it('the library record points at the durable copy (stored document-relative) and resolves back', async () => {
    const source = await ensureDurablePdfSource(PICKED, DOC_ID, store);
    const storage = new FileSystemDocumentStorage(store);
    const record: Document = {
      id: DOC_ID,
      metadata: {
        id: DOC_ID,
        title: 'contract.pdf',
        kind: 'pdf',
        sourceUri: source.path,
        pageCount: 3,
        createdAt: 1,
        updatedAt: 1,
      },
      pages: [],
    };
    await storage.saveDocument(record);

    const persisted = JSON.parse(store.files.get(`${DOC_DIR}/document.json`)!);
    expect(JSON.stringify(persisted)).toContain(`${DOCUMENT_RELATIVE_PREFIX}source.pdf`);
    expect(JSON.stringify(persisted)).not.toContain('/cache/');

    const reloaded = await storage.getDocument(DOC_ID);
    expect(reloaded?.metadata.sourceUri).toBe(`${DOC_DIR}/source.pdf`);
  });
});

describe('Phase 12 — PDF import cache cleanup', () => {
  afterEach(() => {
    delete (NativeModules as any).PdfiumNativeModule;
  });

  it('purges picker/content-URI cache copies through the native module', async () => {
    const purge = jest.fn().mockResolvedValue(3);
    (NativeModules as any).PdfiumNativeModule = { purgeImportCache: purge };
    const engine = new PdfiumEngine();
    await expect(engine.purgeImportCache([PICKED])).resolves.toBe(3);
    expect(purge).toHaveBeenCalledWith([PICKED]);
    await engine.purgeImportCache();
    expect(purge).toHaveBeenLastCalledWith([]);
  });

  it('never throws (cleanup is best-effort) and is a no-op without the native method', async () => {
    (NativeModules as any).PdfiumNativeModule = {
      purgeImportCache: jest.fn().mockRejectedValue(new Error('io')),
    };
    await expect(new PdfiumEngine().purgeImportCache([])).resolves.toBe(0);

    (NativeModules as any).PdfiumNativeModule = {};
    await expect(new PdfiumEngine().purgeImportCache([])).resolves.toBe(0);

    delete (NativeModules as any).PdfiumNativeModule;
    await expect(new PdfiumEngine().purgeImportCache([])).resolves.toBe(0);
  });

  it('the native purge is limited to the two import cache directories', () => {
    // Static contract check of the Kotlin implementation (cannot run natively in Jest).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: { readFileSync(file: string, encoding: 'utf8'): string } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path: { join(...parts: string[]): string } = require('path');
    const kotlin: string = fs.readFileSync(
      path.join(__dirname, '..', 'android/app/src/main/java/com/com.pdfimageeditor/pdf/NativePdfiumModule.kt'),
      'utf8',
    );
    const start = kotlin.indexOf('fun purgeImportCache(');
    const body = kotlin.substring(start, kotlin.indexOf('@ReactMethod', start + 1));
    expect(body).toContain('listOf("picked_pdfs", "resolved_pdfs")');
    expect(body).toContain('File(reactContext.cacheDir, dirName)');
    expect(body).not.toContain('filesDir');
    expect(body).not.toContain('deleteRecursively');
  });
});
