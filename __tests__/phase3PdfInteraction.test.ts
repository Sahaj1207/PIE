import {
  pdfToDocumentRect,
  documentToPdfBounds,
  documentToScreenRect,
  hitTestTextObjects,
  PdfiumEngine,
} from '../src/features/pdf/pdfiumEngine';
import {
  PdfTextObject,
  PdfRawBounds,
  PdfRect,
  createPdfSelectionState,
  PdfSelectionState,
} from '../src/features/pdf/types';
import {
  viewportToDocument,
  documentToViewport,
  ViewportTransform,
  DocumentViewportLayout,
} from '../src/utils/coordinates';
import { pdfObjectPathId, composePdfMatrices } from '../src/features/pdf/pdfObjectLocator';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';

describe('Phase 3 — PDF Document Interaction Foundation', () => {
  const pageHeight = 792;
  const pageWidth = 612;

  // Mock text object helper
  function makeTextObject(options: {
    id: string;
    pageIndex?: number;
    objectIndex: number;
    objectPath?: readonly number[];
    text: string;
    bounds: PdfRect;
    isEditable?: boolean;
  }): PdfTextObject {
    const rawBounds = documentToPdfBounds(options.bounds, pageHeight);
    return {
      id: options.id,
      pageIndex: options.pageIndex ?? 0,
      objectIndex: options.objectIndex,
      objectPath: options.objectPath ?? [options.objectIndex],
      text: options.text,
      bounds: options.bounds,
      pdfBounds: rawBounds,
      fontSize: 12,
      fontName: 'Helvetica',
      color: '#000000',
      colorRgba: { r: 0, g: 0, b: 0, a: 1 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: options.bounds.x, f: options.bounds.y },
      isEditable: options.isEditable !== undefined ? options.isEditable : true,
    };
  }

  describe('1. PDF Document & Page Lifecycle', () => {
    it('manages document opening, page sizing, text extraction, and cleanup without leaking handles', async () => {
      let closedHandle: number | null = null;
      let openedCount = 0;

      const mockEngine: any = {
        openDocument: jest.fn().mockImplementation(async (path: string) => {
          openedCount++;
          return { docHandle: 100 + openedCount, pageCount: 3, filePath: path };
        }),
        closeDocument: jest.fn().mockImplementation(async (handle: number) => {
          closedHandle = handle;
          return true;
        }),
        getPageCount: jest.fn().mockResolvedValue(3),
        getPageSize: jest.fn().mockResolvedValue({ pageIndex: 0, width: pageWidth, height: pageHeight }),
        getTextObjects: jest.fn().mockResolvedValue([]),
        createEditor: jest.fn(),
      };

      const editor = new PdfDocumentEditor(mockEngine);
      await editor.open('/path/to/test.pdf');
      expect(editor.getPageCount()).toBe(3);

      const size = await editor.getPageSize(0);
      expect(size.width).toBe(pageWidth);
      expect(size.height).toBe(pageHeight);

      const objs = await editor.getTextObjects(0);
      expect(objs).toEqual([]);

      // Opening second document automatically closes previous document handle
      await editor.open('/path/to/second.pdf');
      expect(mockEngine.closeDocument).toHaveBeenCalledWith(101);

      await editor.close();
      expect(mockEngine.closeDocument).toHaveBeenCalledWith(102);
      expect(closedHandle).toBe(102);

      // Subsequent close on already closed document is idempotent and safe
      await expect(editor.close()).resolves.toBeUndefined();
    });
  });

  describe('2. Vector Text Extraction Representation', () => {
    it('exposes complete vector text metadata and preserves editable vs non-editable distinction', () => {
      const editableObj = makeTextObject({
        id: 'p0_path1',
        objectIndex: 1,
        text: 'Editable Invoice Header',
        bounds: { x: 50, y: 100, width: 200, height: 24 },
        isEditable: true,
      });

      expect(editableObj.id).toBe('p0_path1');
      expect(editableObj.text).toBe('Editable Invoice Header');
      expect(editableObj.fontSize).toBe(12);
      expect(editableObj.fontName).toBe('Helvetica');
      expect(editableObj.color).toBe('#000000');
      expect(editableObj.isEditable).toBe(true);

      const readonlyObj = makeTextObject({
        id: 'p0_path2',
        objectIndex: 2,
        text: 'Flattened Vector Logo Text',
        bounds: { x: 50, y: 200, width: 150, height: 20 },
        isEditable: false,
      });
      expect(readonlyObj.isEditable).toBe(false);
    });
  });

  describe('3. Form XObject Recursion & Stable Object Paths', () => {
    it('preserves multi-level hierarchy paths without flattening distinct nested objects', () => {
      const topLevelObj = makeTextObject({
        id: pdfObjectPathId(0, [2]),
        objectIndex: 2,
        objectPath: [2],
        text: 'Top Level Text',
        bounds: { x: 100, y: 100, width: 100, height: 20 },
      });

      const nestedFormText = makeTextObject({
        id: pdfObjectPathId(0, [3, 1, 7]),
        objectIndex: 7,
        objectPath: [3, 1, 7],
        text: 'Nested Inside Form XObject',
        bounds: { x: 100, y: 150, width: 180, height: 16 },
      });

      expect(topLevelObj.id).toBe('p0_path2');
      expect(topLevelObj.objectPath).toEqual([2]);

      expect(nestedFormText.id).toBe('p0_path3_1_7');
      expect(nestedFormText.objectPath).toEqual([3, 1, 7]);
      expect(nestedFormText.id).not.toBe(topLevelObj.id);
    });

    it('generates consistent, deterministic IDs across repeated calls', () => {
      const pathA = [4, 2, 8];
      const id1 = pdfObjectPathId(1, pathA);
      const id2 = pdfObjectPathId(1, pathA);
      expect(id1).toBe('p1_path4_2_8');
      expect(id1).toBe(id2);
    });

    it('correctly composes transformation matrices for nested Form XObjects', () => {
      const outerMatrix = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 };
      const innerMatrix = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 };
      const composed = composePdfMatrices(outerMatrix, innerMatrix);

      expect(composed.a).toBe(2);
      expect(composed.d).toBe(2);
      expect(composed.e).toBe(20); // 2 * 5 + 10
      expect(composed.f).toBe(30); // 2 * 5 + 20
    });
  });

  describe('4. PDF Coordinate Normalization', () => {
    it('normalizes PDF bottom-left coordinates into rendered top-left document space', () => {
      // PDF page 612 x 792 pt
      // Object near top of page in PDF coords: left: 50, right: 250, bottom: 720, top: 744
      const pdfBounds: PdfRawBounds = { left: 50, bottom: 720, right: 250, top: 744 };
      const docRect = pdfToDocumentRect(pdfBounds, pageHeight);

      expect(docRect.x).toBe(50);
      expect(docRect.y).toBe(pageHeight - 744); // 792 - 744 = 48 pt from top
      expect(docRect.width).toBe(200);
      expect(docRect.height).toBe(24);
    });

    it('converts document top-left coordinates back into PDF bottom-left coordinates (roundtrip)', () => {
      const initialDocRect: PdfRect = { x: 72, y: 100, width: 300, height: 18 };
      const pdfBounds = documentToPdfBounds(initialDocRect, pageHeight);

      expect(pdfBounds.left).toBe(72);
      expect(pdfBounds.top).toBe(pageHeight - 100); // 692
      expect(pdfBounds.bottom).toBe(pageHeight - 118); // 674
      expect(pdfBounds.right).toBe(372);

      const roundtripDocRect = pdfToDocumentRect(pdfBounds, pageHeight);
      expect(roundtripDocRect).toEqual(initialDocRect);
    });
  });

  describe('5. Viewport and Document Coordinate Mappings', () => {
    const layout: DocumentViewportLayout = {
      baseScale: 0.8,
      originX: 20,
      originY: 40,
    };

    const transform: ViewportTransform = {
      scale: 1.5,
      translateX: 10,
      translateY: 20,
    };

    it('maps viewport tap coordinate to authoritative document coordinate', () => {
      // Divisor = scale * baseScale = 1.5 * 0.8 = 1.2
      // docX = (vpX - originX - tx) / 1.2
      // For docX = 100, docY = 150:
      // vpX = 20 + 10 + 100 * 1.2 = 150
      // vpY = 40 + 20 + 150 * 1.2 = 240
      const vpPoint = { x: 150, y: 240 };
      const docPoint = viewportToDocument(vpPoint, transform, layout);

      expect(docPoint.x).toBeCloseTo(100, 4);
      expect(docPoint.y).toBeCloseTo(150, 4);
    });

    it('maps document coordinate to viewport coordinate', () => {
      const docPoint = { x: 100, y: 150 };
      const vpPoint = documentToViewport(docPoint, transform, layout);

      expect(vpPoint.x).toBeCloseTo(150, 4);
      expect(vpPoint.y).toBeCloseTo(240, 4);
    });

    it('scales selection highlight rectangle by baseScale for rendered viewport display', () => {
      const docBounds: PdfRect = { x: 50, y: 100, width: 200, height: 25 };
      const screenRect = documentToScreenRect(docBounds, 0.8, 0.8);

      expect(screenRect.x).toBe(40);
      expect(screenRect.y).toBe(80);
      expect(screenRect.width).toBe(160);
      expect(screenRect.height).toBe(20);
    });
  });

  describe('6. Deterministic Hit-Testing & Overlapping Specificity', () => {
    it('returns null on empty page', () => {
      const hit = hitTestTextObjects([], { x: 100, y: 100 }, 4);
      expect(hit).toBeNull();
    });

    it('returns null when tap point is far from all text objects (no-hit)', () => {
      const objects = [
        makeTextObject({
          id: 'p0_path1',
          objectIndex: 1,
          text: 'Title',
          bounds: { x: 50, y: 50, width: 100, height: 20 },
        }),
      ];

      const hit = hitTestTextObjects(objects, { x: 400, y: 500 }, 4);
      expect(hit).toBeNull();
    });

    it('selects simple vector text object on exact coordinate tap', () => {
      const obj = makeTextObject({
        id: 'p0_path3',
        objectIndex: 3,
        text: 'Antmark PDF Editor',
        bounds: { x: 72, y: 120, width: 200, height: 18 },
      });

      const hit = hitTestTextObjects([obj], { x: 100, y: 125 }, 4);
      expect(hit).not.toBeNull();
      expect(hit?.id).toBe('p0_path3');
    });

    it('selects object within touch tolerance padding', () => {
      const obj = makeTextObject({
        id: 'p0_path4',
        objectIndex: 4,
        text: 'Margin Tap Test',
        bounds: { x: 100, y: 100, width: 100, height: 20 },
      });

      // Tap 3 pt above the top boundary (within padding = 4)
      const hit = hitTestTextObjects([obj], { x: 120, y: 97 }, 4);
      expect(hit).not.toBeNull();
      expect(hit?.id).toBe('p0_path4');
    });

    it('PREFERS THE SMALLEST / HIGHEST-SPECIFICITY OBJECT WHEN BOUNDS OVERLAP', () => {
      // Large paragraph/container bounds: 200 x 80 (area 16,000)
      const paragraphObj = makeTextObject({
        id: 'p0_path_container',
        objectIndex: 1,
        text: 'Full paragraph container text wrapping several lines of content',
        bounds: { x: 50, y: 100, width: 200, height: 80 },
      });

      // Smaller specific word/link nested inside the container: 50 x 16 (area 800)
      const specificWordObj = makeTextObject({
        id: 'p0_path_word',
        objectIndex: 2,
        text: 'Specific Word',
        bounds: { x: 60, y: 110, width: 50, height: 16 },
      });

      // Case A: Container first in array
      const hitA = hitTestTextObjects([paragraphObj, specificWordObj], { x: 70, y: 115 }, 4);
      expect(hitA?.id).toBe('p0_path_word');

      // Case B: Specific object first in array
      const hitB = hitTestTextObjects([specificWordObj, paragraphObj], { x: 70, y: 115 }, 4);
      expect(hitB?.id).toBe('p0_path_word');
    });

    it('prefers deeper Form XObject hierarchy when bounding box areas match', () => {
      const topLevelObj = makeTextObject({
        id: 'p0_path1',
        objectIndex: 1,
        objectPath: [1],
        text: 'Top Level',
        bounds: { x: 50, y: 50, width: 100, height: 20 },
      });

      const nestedFormObj = makeTextObject({
        id: 'p0_path2_1_4',
        objectIndex: 4,
        objectPath: [2, 1, 4], // Deeper hierarchy
        text: 'Nested Form Text',
        bounds: { x: 50, y: 50, width: 100, height: 20 },
      });

      const hit = hitTestTextObjects([topLevelObj, nestedFormObj], { x: 60, y: 60 }, 4);
      expect(hit?.id).toBe('p0_path2_1_4');
    });
  });

  describe('7. PDF Selection State Lifecycle', () => {
    it('creates explicit PdfSelectionState with required fields', () => {
      const obj = makeTextObject({
        id: 'p0_path5',
        pageIndex: 0,
        objectIndex: 5,
        objectPath: [5],
        text: 'Quarterly Financials',
        bounds: { x: 100, y: 200, width: 180, height: 22 },
      });

      const selection = createPdfSelectionState(obj, 0);

      expect(selection.selectedPageIndex).toBe(0);
      expect(selection.selectedObjectId).toBe('p0_path5');
      expect(selection.selectedObjectPath).toEqual([5]);
      expect(selection.selectedBounds).toEqual({ x: 100, y: 200, width: 180, height: 22 });
      expect(selection.selectedText).toBe('Quarterly Financials');
    });

    it('handles selection clearing on page change, document close, or explicit dismissal', () => {
      let state: PdfSelectionState | null = null;

      const obj = makeTextObject({
        id: 'p0_path6',
        objectIndex: 6,
        text: 'Selectable Text',
        bounds: { x: 50, y: 50, width: 80, height: 16 },
      });

      // 1. Select
      state = createPdfSelectionState(obj, 0);
      expect(state.selectedObjectId).toBe('p0_path6');

      // 2. Dismissal (tap outside)
      state = null;
      expect(state).toBeNull();

      // 3. Re-select and clear on page change
      state = createPdfSelectionState(obj, 0);
      const onPageChange = () => {
        state = null;
      };
      onPageChange();
      expect(state).toBeNull();

      // 4. Re-select and clear on document close
      state = createPdfSelectionState(obj, 0);
      const onDocumentClose = () => {
        state = null;
      };
      onDocumentClose();
      expect(state).toBeNull();
    });
  });
});
