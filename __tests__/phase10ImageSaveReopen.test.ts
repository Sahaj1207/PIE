/**
 * Phase 10 — Image Save / Reopen / dirty-state semantics.
 *
 * Exercises the canonical image editing architecture used by EditorScreen:
 * Document model + DocumentHistoryManager (single history) + ImageDocumentSession
 * (single dirty authority) + content fingerprint against the last saved document.
 */
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

import { Document, TextRegion } from '../src/types/document';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { InMemoryDocumentStorage } from '../src/storage/InMemoryDocumentStorage';
import {
  fingerprintImageDocument,
  isImageDocumentDirty,
} from '../src/features/image/imageDocumentState';
import { createImageSessionFromDocument } from '../src/features/image/importService';

const baseRegion: TextRegion = {
  id: 'text-region-0-k1-1',
  pageIndex: 0,
  bounds: { x: 40, y: 60, width: 300, height: 40 },
  originalText: 'Invoice 001',
  currentText: 'Invoice 001',
  status: 'detected',
  style: { fontSize: 30, color: '#000000' },
};

function createDoc(): Document {
  return {
    id: 'doc-save-reopen',
    metadata: {
      id: 'doc-save-reopen',
      title: 'Invoice.png',
      kind: 'image',
      sourceUri: 'file:///source/invoice.png',
      pageCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    pages: [
      {
        id: 'page-0',
        pageIndex: 0,
        dimensions: { width: 2000, height: 1500 },
        rotation: 0,
        originalContent: {
          pageIndex: 0,
          assetUri: 'file:///app/pie/documents/doc-save-reopen/assets/working.png',
          width: 2000,
          height: 1500,
        },
        editableTextRegions: [baseRegion],
        addedText: [],
      },
    ],
  };
}

function editRegion(doc: Document, text: string): Document {
  const page = doc.pages[0];
  return {
    ...doc,
    metadata: { ...doc.metadata, updatedAt: doc.metadata.updatedAt + 1 },
    pages: [
      {
        ...page,
        editableTextRegions: page.editableTextRegions.map((r) =>
          r.id === baseRegion.id
            ? {
                ...r,
                currentText: text,
                status: 'modified' as const,
                reconstructedPatchUri: 'file:///app/pie/sessions/doc-save-reopen/patches/p1.png',
                reconstructedPatchBounds: { x: 35, y: 55, width: 310, height: 50 },
              }
            : r,
        ),
      },
    ],
  };
}

function addText(doc: Document, id: string, text: string): Document {
  const page = doc.pages[0];
  return {
    ...doc,
    pages: [
      {
        ...page,
        addedText: [
          ...page.addedText,
          {
            id,
            pageIndex: 0,
            text,
            bounds: { x: 100, y: 900, width: 200, height: 40 },
            style: { fontSize: 32, color: '#111827', fontWeight: 'normal', fontStyle: 'normal' },
          },
        ],
      },
    ],
  };
}

describe('Phase 10 — Image Save / Reopen / Dirty State', () => {
  describe('1. Content fingerprint', () => {
    it('ignores updatedAt bookkeeping', () => {
      const doc = createDoc();
      const touched = { ...doc, metadata: { ...doc.metadata, updatedAt: 999999 } };
      expect(fingerprintImageDocument(touched)).toBe(fingerprintImageDocument(doc));
    });

    it('is independent of object key order and JSON round trips', () => {
      const doc = createDoc();
      const reordered = JSON.parse(JSON.stringify(doc));
      const region = reordered.pages[0].editableTextRegions[0];
      reordered.pages[0].editableTextRegions[0] = {
        style: region.style,
        status: region.status,
        currentText: region.currentText,
        originalText: region.originalText,
        bounds: region.bounds,
        pageIndex: region.pageIndex,
        id: region.id,
      };
      expect(fingerprintImageDocument(reordered)).toBe(fingerprintImageDocument(doc));
    });

    it('changes for edits, deletions, added text and title changes', () => {
      const doc = createDoc();
      const fp = fingerprintImageDocument(doc);
      expect(fingerprintImageDocument(editRegion(doc, 'Invoice 002'))).not.toBe(fp);
      expect(fingerprintImageDocument(addText(doc, 'added-1', 'Hello'))).not.toBe(fp);
      expect(
        fingerprintImageDocument({ ...doc, metadata: { ...doc.metadata, title: 'Renamed.png' } }),
      ).not.toBe(fp);
    });
  });

  describe('2. Dirty-state transitions (session is the single dirty authority)', () => {
    let history: DocumentHistoryManager;
    let savedFingerprint: string;
    let current: Document;
    const session = () => sessionRef!;
    let sessionRef: ReturnType<typeof createImageSessionFromDocument> | null = null;

    const sync = (doc: Document) => {
      current = doc;
      const dirty = isImageDocumentDirty(doc, savedFingerprint);
      session().markDirty(dirty);
      return dirty;
    };

    beforeEach(() => {
      const doc = createDoc();
      history = new DocumentHistoryManager();
      history.initialize(doc);
      savedFingerprint = fingerprintImageDocument(doc);
      sessionRef = createImageSessionFromDocument(doc);
      sync(doc);
    });

    afterEach(() => {
      sessionRef?.close();
    });

    it('freshly opened document is CLEAN', () => {
      expect(session().isDirty()).toBe(false);
      expect(session().model.dirtyState).toBe('CLEAN');
    });

    it('an edit makes it DIRTY; undoing back to the saved state makes it CLEAN again', () => {
      const edited = editRegion(current, 'Invoice 002');
      history.push(edited);
      expect(sync(edited)).toBe(true);
      expect(session().isDirty()).toBe(true);

      const undone = history.undo()!;
      expect(sync(undone)).toBe(false);
      expect(session().isDirty()).toBe(false);

      const redone = history.redo()!;
      expect(sync(redone)).toBe(true);
    });

    it('Save persists the current state and returns to CLEAN', async () => {
      const storage = new InMemoryDocumentStorage();
      await storage.saveDocument(createDoc());

      const edited = editRegion(current, 'Invoice 002');
      history.push(edited);
      sync(edited);

      session().setDirtyState('SAVING');
      await storage.saveDocument(edited);
      savedFingerprint = fingerprintImageDocument(edited);
      expect(sync(edited)).toBe(false);
      expect(session().model.dirtyState).toBe('CLEAN');

      const persisted = await storage.getDocument(edited.id);
      expect(persisted!.pages[0].editableTextRegions[0].currentText).toBe('Invoice 002');
    });

    it('undo after Save makes the document DIRTY relative to the saved state', async () => {
      const edited = editRegion(current, 'Invoice 002');
      history.push(edited);
      savedFingerprint = fingerprintImageDocument(edited);
      sync(edited);

      const undone = history.undo()!;
      expect(sync(undone)).toBe(true);
    });

    it('failed Save marks SAVE_FAILED and keeps all edits and history intact', async () => {
      const failingStorage = new InMemoryDocumentStorage();
      jest.spyOn(failingStorage, 'saveDocument').mockRejectedValueOnce(new Error('disk full'));

      const edited = editRegion(current, 'Invoice 002');
      history.push(edited);
      sync(edited);

      session().setDirtyState('SAVING');
      await expect(failingStorage.saveDocument(edited)).rejects.toThrow('disk full');
      session().setDirtyState('SAVE_FAILED');

      expect(session().model.dirtyState).toBe('SAVE_FAILED');
      expect(history.canUndo).toBe(true);
      expect(history.currentState!.pages[0].editableTextRegions[0].currentText).toBe('Invoice 002');
      // Still differs from the last successful save
      expect(isImageDocumentDirty(edited, savedFingerprint)).toBe(true);
    });

    it('viewport changes never affect dirty state', () => {
      session().updateViewportTransform({ scale: 0.12, translateX: 30, translateY: -40 });
      expect(session().isDirty()).toBe(false);
      expect(isImageDocumentDirty(current, savedFingerprint)).toBe(false);
    });
  });

  describe('3. Discard and reopen', () => {
    it('unsaved edits are never written to storage (discard = leave without saving)', async () => {
      const storage = new InMemoryDocumentStorage();
      const original = createDoc();
      await storage.saveDocument(original);

      const history = new DocumentHistoryManager();
      history.initialize(original);
      history.push(editRegion(original, 'Unsaved change'));
      history.push(addText(history.currentState!, 'added-1', 'Draft'));

      const persisted = await storage.getDocument(original.id);
      expect(fingerprintImageDocument(persisted!)).toBe(fingerprintImageDocument(original));
    });

    it('reopening a saved document restores edits in document coordinates with a fresh history', async () => {
      const storage = new InMemoryDocumentStorage();
      const edited = addText(editRegion(createDoc(), 'Invoice 999'), 'added-1', 'PAID');
      await storage.saveDocument(edited);

      const reopened = (await storage.getDocument(edited.id))!;
      expect(reopened.pages[0].editableTextRegions[0]).toEqual(edited.pages[0].editableTextRegions[0]);
      expect(reopened.pages[0].addedText).toEqual(edited.pages[0].addedText);
      expect(reopened.pages[0].dimensions).toEqual({ width: 2000, height: 1500 });

      const history = new DocumentHistoryManager();
      history.initialize(reopened);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);
      expect(isImageDocumentDirty(reopened, fingerprintImageDocument(edited))).toBe(false);
    });
  });
});
