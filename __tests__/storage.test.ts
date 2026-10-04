import { InMemoryDocumentStorage } from '../src/storage/InMemoryDocumentStorage';
import { Document } from '../src/types/document';
import { EditorSessionState } from '../src/features/editor/types';

describe('InMemoryDocumentStorage', () => {
  let storage: InMemoryDocumentStorage;

  beforeEach(() => {
    storage = new InMemoryDocumentStorage();
  });

  test('saves and retrieves document model', async () => {
    const doc: Document = {
      id: 'doc-1',
      metadata: {
        id: 'doc-1',
        title: 'Report',
        kind: 'pdf',
        sourceUri: 'file:///path/to/report.pdf',
        pageCount: 1,
        createdAt: 1000,
        updatedAt: 2000,
      },
      pages: [],
    };

    await storage.saveDocument(doc);
    const retrieved = await storage.getDocument('doc-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('doc-1');
    expect(retrieved?.metadata.title).toBe('Report');
  });

  test('lists documents sorted by updatedAt descending', async () => {
    const doc1: Document = {
      id: 'doc-1',
      metadata: {
        id: 'doc-1',
        title: 'Older',
        kind: 'pdf',
        sourceUri: 'file:///1',
        pageCount: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
      pages: [],
    };

    const doc2: Document = {
      id: 'doc-2',
      metadata: {
        id: 'doc-2',
        title: 'Newer',
        kind: 'pdf',
        sourceUri: 'file:///2',
        pageCount: 1,
        createdAt: 1000,
        updatedAt: 3000,
      },
      pages: [],
    };

    await storage.saveDocument(doc1);
    await storage.saveDocument(doc2);

    const list = await storage.listDocuments();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe('doc-2');
    expect(list[1].id).toBe('doc-1');
  });

  test('saves and recovers editor session state', async () => {
    const session: EditorSessionState = {
      documentId: 'doc-1',
      activePageIndex: 0,
      toolMode: 'editText',
      selection: null,
      viewportTransform: { scale: 1.2, translateX: 10, translateY: 20 },
      hasUnsavedChanges: true,
      undoStackDepth: 3,
      redoStackDepth: 0,
    };

    await storage.saveEditorSession(session);
    const recovered = await storage.getEditorSession('doc-1');
    expect(recovered).not.toBeNull();
    expect(recovered?.toolMode).toBe('editText');
    expect(recovered?.viewportTransform.scale).toBe(1.2);
  });

  test('deletes document and associated session', async () => {
    const doc: Document = {
      id: 'doc-del',
      metadata: {
        id: 'doc-del',
        title: 'To Delete',
        kind: 'image',
        sourceUri: 'file:///del',
        pageCount: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
      pages: [],
    };

    await storage.saveDocument(doc);
    await storage.deleteDocument('doc-del');
    const retrieved = await storage.getDocument('doc-del');
    expect(retrieved).toBeNull();
  });
});
