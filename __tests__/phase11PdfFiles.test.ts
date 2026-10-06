/**
 * Phase 11 — PDF working-copy / revision file lifecycle and durable PDF records.
 */
import { IFileStore } from '../src/storage/nativeFileStore';
import { FileSystemDocumentStorage, DOCUMENT_RELATIVE_PREFIX } from '../src/storage/FileSystemDocumentStorage';
import {
  buildWorkingCopyPath,
  cleanupPdfSessionFiles,
  createDurablePdfRevisionPath,
  createPdfDocumentId,
  getPdfSessionWorkingDirectory,
  pruneDurablePdfRevisions,
} from '../src/features/pdf/pdfDocumentFiles';
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

const DOC_ID = 'pdf-1700000000000';
const DOC_DIR = `${ROOT}/documents/${DOC_ID}`;
const WORK_DIR = `${ROOT}/sessions/${DOC_ID}/working`;

describe('Phase 11 — PDF file lifecycle', () => {
  let store: FakeFileStore;

  beforeEach(() => {
    store = createFakeFileStore();
  });

  describe('1. Working-copy paths', () => {
    it('uses flat, non-chaining names inside the session working directory', async () => {
      const dir = await getPdfSessionWorkingDirectory(DOC_ID, store);
      expect(dir).toBe(WORK_DIR);
      const first = buildWorkingCopyPath('/data/app/cache/picked_pdfs/1_contract.pdf', dir, 1, 100);
      const second = buildWorkingCopyPath(first, dir, 2, 200);
      expect(first).toBe(`${WORK_DIR}/working_1_100.pdf`);
      expect(second).toBe(`${WORK_DIR}/working_2_200.pdf`);
    });

    it('without durable storage, strips previous working suffixes instead of chaining them', () => {
      const a = buildWorkingCopyPath('/docs/contract.pdf', null, 1, 100);
      const b = buildWorkingCopyPath(a, null, 2, 200);
      const c = buildWorkingCopyPath(b, null, 3, 300);
      expect(a).toBe('/docs/contract_working_1_100.pdf');
      expect(b).toBe('/docs/contract_working_2_200.pdf');
      expect(c).toBe('/docs/contract_working_3_300.pdf');
    });

    it('returns null directories when durable storage is not linked', async () => {
      expect(await getPdfSessionWorkingDirectory(DOC_ID, null)).toBeNull();
      expect(await createDurablePdfRevisionPath(DOC_ID, null)).toBeNull();
      expect(await pruneDurablePdfRevisions(DOC_ID, [], null)).toBe(0);
      expect(await cleanupPdfSessionFiles(DOC_ID, [], null)).toBe(0);
    });

    it('creates stable pdf document ids', () => {
      expect(createPdfDocumentId(42)).toBe('pdf-42');
    });
  });

  describe('2. Durable saved revisions', () => {
    it('places saved revisions inside the document directory (never in cache)', async () => {
      const path = await createDurablePdfRevisionPath(DOC_ID, store, 555);
      expect(path).toBe(`${DOC_DIR}/rev_555.pdf`);
      expect(store.dirs.has(DOC_DIR)).toBe(true);
    });

    it('prunes old revisions but keeps the new revision and every protected file', async () => {
      store.files.set(`${DOC_DIR}/rev_1.pdf`, 'old');
      store.files.set(`${DOC_DIR}/rev_2.pdf`, 'session source');
      store.files.set(`${DOC_DIR}/rev_3.pdf`, 'new');
      store.files.set(`${DOC_DIR}/document.json`, '{}');

      const removed = await pruneDurablePdfRevisions(
        DOC_ID,
        [`${DOC_DIR}/rev_3.pdf`, `${DOC_DIR}/rev_2.pdf`, null],
        store,
      );
      expect(removed).toBe(1);
      expect(store.files.has(`${DOC_DIR}/rev_1.pdf`)).toBe(false);
      expect(store.files.has(`${DOC_DIR}/rev_2.pdf`)).toBe(true);
      expect(store.files.has(`${DOC_DIR}/rev_3.pdf`)).toBe(true);
      expect(store.files.has(`${DOC_DIR}/document.json`)).toBe(true);
    });
  });

  describe('3. Session working-copy cleanup', () => {
    it('removes the whole session when nothing in it is protected', async () => {
      store.files.set(`${WORK_DIR}/working_1_100.pdf`, 'w1');
      store.files.set(`${WORK_DIR}/working_2_200.pdf`, 'w2');
      await cleanupPdfSessionFiles(DOC_ID, [`${DOC_DIR}/rev_3.pdf`], store);
      expect([...store.files.keys()].some((k) => k.startsWith(`${ROOT}/sessions/${DOC_ID}`))).toBe(false);
    });

    it('never deletes the active working document or undo revisions', async () => {
      store.files.set(`${WORK_DIR}/working_1_100.pdf`, 'w1 (undo revision)');
      store.files.set(`${WORK_DIR}/working_2_200.pdf`, 'w2 (active)');
      store.files.set(`${WORK_DIR}/working_3_300.pdf`, 'w3 (orphan)');
      const removed = await cleanupPdfSessionFiles(
        DOC_ID,
        [`${WORK_DIR}/working_1_100.pdf`, `file://${WORK_DIR}/working_2_200.pdf`],
        store,
      );
      expect(removed).toBe(1);
      expect(store.files.has(`${WORK_DIR}/working_1_100.pdf`)).toBe(true);
      expect(store.files.has(`${WORK_DIR}/working_2_200.pdf`)).toBe(true);
      expect(store.files.has(`${WORK_DIR}/working_3_300.pdf`)).toBe(false);
    });
  });

  describe('4. Durable PDF records in FileSystemDocumentStorage', () => {
    const pdfRecord = (sourceUri: string): Document => ({
      id: DOC_ID,
      metadata: {
        id: DOC_ID,
        title: 'Contract.pdf',
        kind: 'pdf',
        sourceUri,
        pageCount: 3,
        createdAt: 1,
        updatedAt: 2,
      },
      pages: [],
    });

    it('stores a PDF inside its document directory relative to it and resolves it on reopen', async () => {
      const storage = new FileSystemDocumentStorage(store);
      store.files.set(`${DOC_DIR}/rev_9.pdf`, '%PDF');
      await storage.saveDocument(pdfRecord(`${DOC_DIR}/rev_9.pdf`));

      const raw = JSON.parse(store.files.get(`${DOC_DIR}/document.json`)!);
      expect(raw.document.metadata.sourceUri).toBe(`${DOCUMENT_RELATIVE_PREFIX}rev_9.pdf`);

      // Simulated app restart: new storage instance over the same files
      const afterRestart = new FileSystemDocumentStorage(store);
      const reopened = await afterRestart.getDocument(DOC_ID);
      expect(reopened!.metadata.sourceUri).toBe(`${DOC_DIR}/rev_9.pdf`);

      const list = await afterRestart.listDocuments();
      expect(list[0].metadata.sourceUri).toBe(`${DOC_DIR}/rev_9.pdf`);
    });

    it('leaves PDF records outside the document directory unchanged (no copying)', async () => {
      const storage = new FileSystemDocumentStorage(store);
      await storage.saveDocument(pdfRecord('/data/app/cache/picked_pdfs/legacy_edited.pdf'));
      const reopened = await storage.getDocument(DOC_ID);
      expect(reopened!.metadata.sourceUri).toBe('/data/app/cache/picked_pdfs/legacy_edited.pdf');
      expect(store.copyFile).not.toHaveBeenCalled();
    });

    it('updating the same record id keeps a single library entry', async () => {
      const storage = new FileSystemDocumentStorage(store);
      store.files.set(`${DOC_DIR}/rev_1.pdf`, '%PDF');
      store.files.set(`${DOC_DIR}/rev_2.pdf`, '%PDF');
      await storage.saveDocument(pdfRecord(`${DOC_DIR}/rev_1.pdf`));
      await storage.saveDocument({ ...pdfRecord(`${DOC_DIR}/rev_2.pdf`), metadata: { ...pdfRecord('').metadata, sourceUri: `${DOC_DIR}/rev_2.pdf`, updatedAt: 3 } });

      const list = await storage.listDocuments();
      expect(list).toHaveLength(1);
      expect(list[0].metadata.sourceUri).toBe(`${DOC_DIR}/rev_2.pdf`);
    });

    it('image document persistence is unaffected by the PDF branch', async () => {
      const storage = new FileSystemDocumentStorage(store);
      const imgId = 'doc-img-1';
      const imgDir = `${ROOT}/documents/${imgId}`;
      store.files.set(`${imgDir}/assets/working.jpg`, 'IMG');
      const image: Document = {
        id: imgId,
        metadata: {
          id: imgId,
          title: 'Photo.jpg',
          kind: 'image',
          sourceUri: 'content://media/external/images/media/9',
          pageCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        pages: [
          {
            id: 'p0',
            pageIndex: 0,
            dimensions: { width: 100, height: 50 },
            rotation: 0,
            originalContent: { pageIndex: 0, assetUri: `file://${imgDir}/assets/working.jpg`, width: 100, height: 50 },
            editableTextRegions: [],
            addedText: [],
          },
        ],
      };
      await storage.saveDocument(image);
      const raw = JSON.parse(store.files.get(`${imgDir}/document.json`)!);
      expect(raw.document.metadata.sourceUri).toBe('content://media/external/images/media/9');
      expect(raw.document.pages[0].originalContent.assetUri).toBe(`${DOCUMENT_RELATIVE_PREFIX}assets/working.jpg`);
      const reopened = await storage.getDocument(imgId);
      expect(reopened!.pages[0].originalContent.assetUri).toBe(`file://${imgDir}/assets/working.jpg`);
      expect(reopened!.metadata.sourceUri).toBe('content://media/external/images/media/9');
    });
  });
});
