/**
 * Phase 10 — Undo/redo correctness and OCR state preservation.
 *
 * OCR detection is an undoable document-history operation (D4) recorded in the single
 * canonical DocumentHistoryManager, and re-detection never replaces or duplicates edits.
 */
import { Document, TextRegion } from '../src/types/document';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import {
  mergeDetectedRegions,
  overlapRatio,
  EDITED_REGION_OVERLAP_THRESHOLD,
} from '../src/features/ocr/regionMerge';
import {
  applyOcrDetection,
  countEditedRegions,
  createOcrRunToken,
} from '../src/features/image/imageDocumentState';
import { ocrResultToTextRegions } from '../src/features/ocr/normalization';
import { OcrResult } from '../src/features/ocr/types';

function detected(id: string, x: number, y: number, text: string): TextRegion {
  return {
    id,
    pageIndex: 0,
    bounds: { x, y, width: 200, height: 40 },
    originalText: text,
    currentText: text,
    status: 'detected',
    style: { fontSize: 30, color: '#000000' },
    confidence: 0.9,
  };
}

function createDoc(regions: TextRegion[] = []): Document {
  return {
    id: 'doc-ocr',
    metadata: {
      id: 'doc-ocr',
      title: 'Scan.jpg',
      kind: 'image',
      sourceUri: 'file:///src/scan.jpg',
      pageCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    pages: [
      {
        id: 'p0',
        pageIndex: 0,
        dimensions: { width: 1200, height: 1600 },
        rotation: 0,
        originalContent: { pageIndex: 0, assetUri: 'file:///app/working.jpg', width: 1200, height: 1600 },
        editableTextRegions: regions,
        addedText: [],
      },
    ],
  };
}

function modify(doc: Document, regionId: string, text: string): Document {
  const page = doc.pages[0];
  return {
    ...doc,
    pages: [
      {
        ...page,
        editableTextRegions: page.editableTextRegions.map((r) =>
          r.id === regionId
            ? {
                ...r,
                currentText: text,
                status: 'modified' as const,
                originalBounds: r.bounds,
                reconstructedPatchUri: `file:///app/patches/${regionId}.png`,
                reconstructedPatchBounds: r.bounds,
              }
            : r,
        ),
      },
    ],
  };
}

function remove(doc: Document, regionId: string): Document {
  const page = doc.pages[0];
  return {
    ...doc,
    pages: [
      {
        ...page,
        editableTextRegions: page.editableTextRegions.map((r) =>
          r.id === regionId
            ? {
                ...r,
                currentText: '',
                status: 'deleted' as const,
                originalBounds: r.bounds,
                reconstructedPatchUri: `file:///app/patches/${regionId}.png`,
                reconstructedPatchBounds: r.bounds,
              }
            : r,
        ),
      },
    ],
  };
}

const ocrRun = (): TextRegion[] => [
  detected('text-region-0-1', 50, 100, 'Header'),
  detected('text-region-0-2', 50, 300, 'Line two'),
  detected('text-region-0-3', 50, 500, 'Footer'),
];

describe('Phase 10 — History & OCR preservation', () => {
  describe('1. Regression: undo must not wipe OCR results', () => {
    it('OCR -> edit -> undo keeps all detected regions', () => {
      const history = new DocumentHistoryManager();
      const initial = createDoc();
      history.initialize(initial);

      const afterOcr = applyOcrDetection(initial, ocrRun(), 'run1');
      history.push(afterOcr);
      const targetId = afterOcr.pages[0].editableTextRegions[0].id;

      history.push(modify(afterOcr, targetId, 'New header'));
      const undone = history.undo()!;

      const regions = undone.pages[0].editableTextRegions;
      expect(regions).toHaveLength(3);
      expect(regions.every((r) => r.status === 'detected')).toBe(true);
      expect(regions.find((r) => r.id === targetId)!.currentText).toBe('Header');
    });

    it('history baseline is the resolved document actually shown (initialize with it)', () => {
      const history = new DocumentHistoryManager();
      const resolved = createDoc(ocrRun());
      history.initialize(resolved);
      history.push(modify(resolved, 'text-region-0-1', 'Edited'));
      const undone = history.undo()!;
      expect(undone).toEqual(resolved);
      expect(history.canUndo).toBe(false);
    });
  });

  describe('2. OCR detection is an undoable history step', () => {
    it('undo removes the detection; redo restores it', () => {
      const history = new DocumentHistoryManager();
      const initial = createDoc();
      history.initialize(initial);

      const afterOcr = applyOcrDetection(initial, ocrRun(), 'run1');
      history.push(afterOcr);
      expect(history.canUndo).toBe(true);

      const undone = history.undo()!;
      expect(undone.pages[0].editableTextRegions).toHaveLength(0);

      const redone = history.redo()!;
      expect(redone.pages[0].editableTextRegions).toHaveLength(3);
      expect(redone.pages[0].editableTextRegions.map((r) => r.id)).toEqual(
        afterOcr.pages[0].editableTextRegions.map((r) => r.id),
      );
    });

    it('linear history across added text, OCR and region edits stays consistent', () => {
      const history = new DocumentHistoryManager();
      const d0 = createDoc();
      history.initialize(d0);

      const d1: Document = {
        ...d0,
        pages: [
          {
            ...d0.pages[0],
            addedText: [
              {
                id: 'added-1',
                pageIndex: 0,
                text: 'Note',
                bounds: { x: 10, y: 10, width: 80, height: 20 },
                style: { fontSize: 16, color: '#111827' },
              },
            ],
          },
        ],
      };
      history.push(d1);
      const d2 = applyOcrDetection(d1, ocrRun(), 'run1');
      history.push(d2);
      const d3 = remove(d2, d2.pages[0].editableTextRegions[1].id);
      history.push(d3);

      expect(history.undo()).toEqual(d2);
      const back1 = history.undo()!;
      expect(back1.pages[0].editableTextRegions).toHaveLength(0);
      expect(back1.pages[0].addedText).toHaveLength(1);
      expect(history.redo()).toEqual(d2);
      expect(history.redo()).toEqual(d3);
    });
  });

  describe('3. Re-detection merge preserves edits', () => {
    it('keeps modified and deleted regions unchanged, including patches', () => {
      let doc = applyOcrDetection(createDoc(), ocrRun(), 'run1');
      const [first, second] = doc.pages[0].editableTextRegions;
      doc = modify(doc, first.id, 'Edited header');
      doc = remove(doc, second.id);
      const editedBefore = doc.pages[0].editableTextRegions.filter((r) => r.status !== 'detected');

      const redetected = applyOcrDetection(doc, ocrRun(), 'run2');
      const regions = redetected.pages[0].editableTextRegions;

      for (const edited of editedBefore) {
        expect(regions.find((r) => r.id === edited.id)).toEqual(edited);
      }
      expect(countEditedRegions(redetected)).toBe(2);
    });

    it('drops new detections that overlap an edited or deleted region (no duplicates)', () => {
      let doc = applyOcrDetection(createDoc(), ocrRun(), 'run1');
      const [first, second] = doc.pages[0].editableTextRegions;
      doc = modify(doc, first.id, 'Edited header');
      doc = remove(doc, second.id);

      const redetected = applyOcrDetection(doc, ocrRun(), 'run2');
      const regions = redetected.pages[0].editableTextRegions;
      // 2 preserved edits + only the non-overlapping 'Footer' detection
      expect(regions).toHaveLength(3);
      const fresh = regions.filter((r) => r.status === 'detected');
      expect(fresh.map((r) => r.originalText)).toEqual(['Footer']);
    });

    it('replaces previously detected (unedited) regions with the new run', () => {
      const doc = applyOcrDetection(createDoc(), ocrRun(), 'run1');
      const redetected = applyOcrDetection(
        doc,
        [detected('text-region-0-1', 600, 900, 'Brand new')],
        'run2',
      );
      const regions = redetected.pages[0].editableTextRegions;
      expect(regions).toHaveLength(1);
      expect(regions[0].originalText).toBe('Brand new');
    });

    it('places preserved edits after fresh detections (edits win reverse-order hit tests)', () => {
      let doc = applyOcrDetection(createDoc(), ocrRun(), 'run1');
      doc = modify(doc, doc.pages[0].editableTextRegions[0].id, 'Edited');
      const regions = applyOcrDetection(doc, ocrRun(), 'run2').pages[0].editableTextRegions;
      expect(regions[regions.length - 1].status).toBe('modified');
    });

    it('does not mutate the input document', () => {
      const doc = applyOcrDetection(createDoc(), ocrRun(), 'run1');
      const snapshot = JSON.stringify(doc);
      applyOcrDetection(doc, ocrRun(), 'run2');
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  describe('4. Collision-free region IDs', () => {
    it('re-IDs detections even though raw OCR IDs restart at 1 every run', () => {
      const ocr: OcrResult = {
        blocks: [
          {
            id: 'b1',
            text: 'A\nB',
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            lines: [
              { id: 'l1', text: 'A', bounds: { x: 0, y: 0, width: 50, height: 20 }, elements: [] },
              { id: 'l2', text: 'B', bounds: { x: 0, y: 40, width: 50, height: 20 }, elements: [] },
            ],
          },
        ],
      } as unknown as OcrResult;
      const run1 = ocrResultToTextRegions(ocr, 0);
      const run2 = ocrResultToTextRegions(ocr, 0);
      expect(run1.map((r) => r.id)).toEqual(run2.map((r) => r.id)); // raw IDs collide

      const doc1 = applyOcrDetection(createDoc(), run1, createOcrRunToken(1000));
      const edited = modify(doc1, doc1.pages[0].editableTextRegions[0].id, 'A2');
      // Simulate app restart + re-detection: preserved IDs come from the persisted document
      const persisted: Document = JSON.parse(JSON.stringify(edited));
      const doc2 = applyOcrDetection(persisted, run2, createOcrRunToken(2000));

      const ids = doc2.pages[0].editableTextRegions.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('skips a generated ID that already belongs to a preserved region', () => {
      const preserved: TextRegion = {
        ...detected('text-region-0-tok-1', 900, 1200, 'Kept'),
        status: 'modified',
        currentText: 'Kept edit',
      };
      const merged = mergeDetectedRegions(
        [preserved],
        [detected('x', 10, 10, 'One'), detected('y', 10, 200, 'Two')],
        { pageIndex: 0, runToken: 'tok' },
      );
      const ids = merged.map((r) => r.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toContain('text-region-0-tok-1');
      expect(ids.filter((id) => id === 'text-region-0-tok-1')).toHaveLength(1);
    });

    it('createOcrRunToken is deterministic for a given time and unique across times', () => {
      expect(createOcrRunToken(123456)).toBe(createOcrRunToken(123456));
      expect(createOcrRunToken(123456)).not.toBe(createOcrRunToken(123457));
    });
  });

  describe('5. Overlap math', () => {
    it('computes overlap relative to the smaller rectangle', () => {
      const a = { x: 0, y: 0, width: 100, height: 100 };
      expect(overlapRatio(a, { x: 0, y: 0, width: 50, height: 50 })).toBe(1);
      expect(overlapRatio(a, { x: 50, y: 0, width: 100, height: 100 })).toBe(0.5);
      expect(overlapRatio(a, { x: 200, y: 200, width: 10, height: 10 })).toBe(0);
      expect(overlapRatio(a, { x: 0, y: 0, width: 0, height: 10 })).toBe(0);
      expect(EDITED_REGION_OVERLAP_THRESHOLD).toBeGreaterThan(0);
    });
  });
});
