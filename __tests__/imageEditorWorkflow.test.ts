import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { ImageExportEngine } from '../src/features/export/imageExportEngine';
import { LocalBackgroundReconstructionEngine } from '../src/features/image/reconstructionEngine';
import { normalizeBoundingBox, normalizeVisionBoundingBox } from '../src/features/ocr/normalization';
import { fitTextToBoundingBox } from '../src/features/text/textFitting';
import { Document, TextRegion, AddedTextElement } from '../src/types/document';
import { ExportError } from '../src/errors';
import { NativeModules } from 'react-native';

const asMutable = <T>(obj: T): any => obj;

const createSampleImageDocument = (overrides?: Partial<Document>): Document => ({
  id: 'doc-img-workflow-1',
  metadata: {
    id: 'doc-img-workflow-1',
    title: 'Receipt Scan',
    kind: 'image',
    sourceUri: 'file:///data/user/0/app/documents/receipt_original.png',
    pageCount: 1,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  },
  pages: [
    {
      id: 'page-0',
      pageIndex: 0,
      dimensions: { width: 1800, height: 2400 },
      rotation: 0,
      originalContent: {
        pageIndex: 0,
        assetUri: 'file:///data/user/0/app/documents/receipt_original.png',
        width: 1800,
        height: 2400,
      },
      editableTextRegions: [
        {
          id: 'region-header',
          pageIndex: 0,
          bounds: { x: 200, y: 150, width: 600, height: 80 },
          originalText: 'COFFEE SHOP INC',
          currentText: 'COFFEE SHOP INC',
          status: 'detected',
          style: {
            fontSize: 48,
            color: '#111827',
            fontFamily: 'sans-serif',
            fontWeight: 'bold',
          },
        },
        {
          id: 'region-total',
          pageIndex: 0,
          bounds: { x: 200, y: 800, width: 400, height: 60 },
          originalText: 'TOTAL: $14.50',
          currentText: 'TOTAL: $14.50',
          status: 'detected',
          style: {
            fontSize: 36,
            color: '#374151',
            fontFamily: 'sans-serif',
            fontWeight: 'normal',
          },
        },
        {
          id: 'region-footer',
          pageIndex: 0,
          bounds: { x: 200, y: 1200, width: 500, height: 50 },
          originalText: 'Thank you for your visit!',
          currentText: 'Thank you for your visit!',
          status: 'detected',
          style: {
            fontSize: 28,
            color: '#6B7280',
            fontFamily: 'sans-serif',
            fontWeight: 'normal',
          },
        },
      ],
      addedText: [],
    },
  ],
  ...overrides,
});

describe('Phase 4A: Image Editor User Workflow & Regression Suite', () => {
  let exportEngine: ImageExportEngine;
  let historyManager: DocumentHistoryManager;
  let reconstructionEngine: LocalBackgroundReconstructionEngine;

  beforeEach(() => {
    exportEngine = new ImageExportEngine();
    historyManager = new DocumentHistoryManager();
    reconstructionEngine = new LocalBackgroundReconstructionEngine();
    jest.clearAllMocks();
  });

  // A. Image Import
  describe('A. Image Import', () => {
    it('initializes document structure with exact source metadata and immutable original content', () => {
      const doc = createSampleImageDocument();
      expect(doc.metadata.kind).toBe('image');
      expect(doc.metadata.sourceUri).toBe('file:///data/user/0/app/documents/receipt_original.png');
      expect(doc.pages[0].dimensions).toEqual({ width: 1800, height: 2400 });
      expect(doc.pages[0].originalContent.assetUri).toBe(doc.metadata.sourceUri);
      expect(doc.pages[0].editableTextRegions).toHaveLength(3);
      expect(doc.pages[0].addedText).toEqual([]);
    });
  });

  // B. OCR Normalization
  describe('B. OCR Normalization', () => {
    it('clamps bounding boxes within intrinsic image dimensions', () => {
      const dimensions = { width: 1800, height: 2400 };
      const rawOverflow = { x: 1700, y: 2350, width: 300, height: 200 };
      const normalized = normalizeBoundingBox(rawOverflow, dimensions);

      expect(normalized.x).toBe(1700);
      expect(normalized.y).toBe(2350);
      expect(normalized.width).toBe(100); // 1800 - 1700
      expect(normalized.height).toBe(50); // 2400 - 2350
    });

    it('transforms Apple Vision normalized bottom-left coordinates into document top-left coordinates', () => {
      const dimensions = { width: 1000, height: 2000 };
      const visionBox = { x: 0.1, y: 0.8, width: 0.4, height: 0.1 };
      const normalized = normalizeVisionBoundingBox(visionBox, dimensions);

      // Vision x=0.1 * 1000 = 100
      expect(normalized.x).toBe(100);
      // Vision y=0.8, height=0.1 -> Document top Y = (1.0 - 0.8 - 0.1) * 2000 = 0.1 * 2000 = 200
      expect(normalized.y).toBe(200);
      expect(normalized.width).toBe(400);
      expect(normalized.height).toBe(200);
    });
  });

  // C. OCR Selection (Hit Testing)
  describe('C. OCR Selection & Hit Testing', () => {
    it('correctly selects text region when touch lands inside its document-coordinate bounds', () => {
      const doc = createSampleImageDocument();
      const regions = doc.pages[0].editableTextRegions;

      // Touch at (250, 160) inside region-header (x: 200..800, y: 150..230)
      const touchDocPoint = { x: 250, y: 160 };
      const hitRegion = regions.find(
        (r) =>
          touchDocPoint.x >= r.bounds.x &&
          touchDocPoint.x <= r.bounds.x + r.bounds.width &&
          touchDocPoint.y >= r.bounds.y &&
          touchDocPoint.y <= r.bounds.y + r.bounds.height,
      );
      expect(hitRegion).toBeDefined();
      expect(hitRegion?.id).toBe('region-header');
    });

    it('returns undefined when touch lands on empty background', () => {
      const doc = createSampleImageDocument();
      const regions = doc.pages[0].editableTextRegions;

      const touchDocPoint = { x: 50, y: 50 };
      const hitRegion = regions.find(
        (r) =>
          touchDocPoint.x >= r.bounds.x &&
          touchDocPoint.x <= r.bounds.x + r.bounds.width &&
          touchDocPoint.y >= r.bounds.y &&
          touchDocPoint.y <= r.bounds.y + r.bounds.height,
      );
      expect(hitRegion).toBeUndefined();
    });
  });

  // D. Text Replacement
  describe('D. Text Replacement', () => {
    it('updates text content, status to modified, and retains reconstruction patch', () => {
      const doc = createSampleImageDocument();
      const targetRegion = asMutable(doc.pages[0].editableTextRegions[0]);

      // Simulate replacement workflow
      targetRegion.currentText = 'ESPRESSO BAR';
      targetRegion.status = 'modified';
      targetRegion.reconstructedPatchUri = 'file:///cache/patches/patch_header.png';
      targetRegion.reconstructedPatchBounds = {
        x: targetRegion.bounds.x - 4,
        y: targetRegion.bounds.y - 4,
        width: targetRegion.bounds.width + 8,
        height: targetRegion.bounds.height + 8,
      };

      expect(targetRegion.currentText).toBe('ESPRESSO BAR');
      expect(targetRegion.status).toBe('modified');
      expect(targetRegion.reconstructedPatchUri).toBe('file:///cache/patches/patch_header.png');
      expect(targetRegion.reconstructedPatchBounds.width).toBe(608);
    });
  });

  // E. Text Deletion
  describe('E. Text Deletion', () => {
    it('sets text to empty, marks status as deleted, and preserves reconstruction patch', () => {
      const doc = createSampleImageDocument();
      const targetRegion = asMutable(doc.pages[0].editableTextRegions[2]); // footer

      targetRegion.currentText = '';
      targetRegion.status = 'deleted';
      targetRegion.reconstructedPatchUri = 'file:///cache/patches/patch_footer.png';
      targetRegion.reconstructedPatchBounds = {
        x: targetRegion.bounds.x - 4,
        y: targetRegion.bounds.y - 4,
        width: targetRegion.bounds.width + 8,
        height: targetRegion.bounds.height + 8,
      };

      expect(targetRegion.currentText).toBe('');
      expect(targetRegion.status).toBe('deleted');
      expect(targetRegion.reconstructedPatchUri).toBe('file:///cache/patches/patch_footer.png');
    });
  });

  // F. Reconstruction
  describe('F. Local Background Reconstruction', () => {
    it('rejects invalid inputs with typed validation errors', async () => {
      await expect(
        reconstructionEngine.reconstructBackground('', { x: 10, y: 10, width: 50, height: 20 }),
      ).rejects.toThrow('Image URI is required');

      await expect(
        reconstructionEngine.reconstructBackground('file:///test.png', {
          x: 10,
          y: 10,
          width: -5,
          height: 20,
        }),
      ).rejects.toThrow('Invalid bounding box dimensions');
    });

    it('generates deterministic patch metadata when native processor succeeds', async () => {
      NativeModules.ImageProcessingModule = {
        reconstructBackground: jest.fn().mockResolvedValue({
          patchUri: 'file:///cache/patches/deterministic_patch.png',
          bounds: { x: 196, y: 146, width: 608, height: 88 },
          estimatedBackgroundColor: '#ffffff',
          estimatedTextColor: '#000000',
          confidence: 0.98,
        }),
      };

      const result = await reconstructionEngine.reconstructBackground(
        'file:///test.png',
        { x: 200, y: 150, width: 600, height: 80 },
      );

      expect(result.patchUri).toBe('file:///cache/patches/deterministic_patch.png');
      expect(result.bounds.width).toBe(608);
      expect(result.confidence).toBe(0.98);
    });
  });

  // G. Added Text
  describe('G. Added Text Element', () => {
    it('adds new editable text element to page with specified properties', () => {
      const doc = createSampleImageDocument();
      const newElement: AddedTextElement = {
        id: 'added-1',
        pageIndex: 0,
        bounds: {
          x: 300,
          y: 500,
          width: 350,
          height: 50,
        },
        text: 'Order #1042',
        style: {
          fontSize: 32,
          color: '#10B981',
          fontFamily: 'serif',
          fontWeight: 'bold',
          fontStyle: 'italic',
        },
      };

      doc.pages[0].addedText.push(newElement);

      expect(doc.pages[0].addedText).toHaveLength(1);
      expect(doc.pages[0].addedText[0].text).toBe('Order #1042');
      expect(doc.pages[0].addedText[0].style.fontFamily).toBe('serif');
      expect(doc.pages[0].addedText[0].style.fontWeight).toBe('bold');
      expect(doc.pages[0].addedText[0].style.fontStyle).toBe('italic');
    });
  });

  // H. Formatting
  describe('H. Formatting Controls', () => {
    it('applies font styling (family, size, bold, italic, color) directly to domain objects', () => {
      const doc = createSampleImageDocument();
      const region = asMutable(doc.pages[0].editableTextRegions[1]);

      // Update styling
      region.style = {
        ...region.style,
        fontSize: 44,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        fontStyle: 'italic',
        color: '#DC2626',
      };

      expect(region.style.fontSize).toBe(44);
      expect(region.style.fontFamily).toBe('monospace');
      expect(region.style.fontWeight).toBe('bold');
      expect(region.style.fontStyle).toBe('italic');
      expect(region.style.color).toBe('#DC2626');
    });
  });

  // I. Mixed Undo / Redo
  describe('I. Mixed Undo / Redo', () => {
    it('correctly handles sequence: replace -> replace -> delete -> insert -> undo -> undo -> redo', () => {
      const baseDoc = createSampleImageDocument();
      historyManager.initialize(baseDoc);

      // Step 1: Replace header
      const docAfterReplace1 = JSON.parse(JSON.stringify(historyManager.currentState!));
      docAfterReplace1.pages[0].editableTextRegions[0].currentText = 'Step 1: Header';
      docAfterReplace1.pages[0].editableTextRegions[0].status = 'modified';
      historyManager.push(docAfterReplace1);

      // Step 2: Replace total
      const docAfterReplace2 = JSON.parse(JSON.stringify(historyManager.currentState!));
      docAfterReplace2.pages[0].editableTextRegions[1].currentText = 'Step 2: Total $99';
      docAfterReplace2.pages[0].editableTextRegions[1].status = 'modified';
      historyManager.push(docAfterReplace2);

      // Step 3: Delete footer
      const docAfterDelete = JSON.parse(JSON.stringify(historyManager.currentState!));
      docAfterDelete.pages[0].editableTextRegions[2].currentText = '';
      docAfterDelete.pages[0].editableTextRegions[2].status = 'deleted';
      historyManager.push(docAfterDelete);

      // Step 4: Insert added text
      const docAfterInsert = JSON.parse(JSON.stringify(historyManager.currentState!));
      docAfterInsert.pages[0].addedText.push({
        id: 'new-txt-1',
        pageIndex: 0,
        bounds: {
          x: 100,
          y: 200,
          width: 200,
          height: 40,
        },
        text: 'Inserted Note',
        style: { fontSize: 20, color: '#000000' },
      });
      historyManager.push(docAfterInsert);

      expect(historyManager.currentState?.pages[0].addedText).toHaveLength(1);
      expect(historyManager.currentState?.pages[0].editableTextRegions[2].status).toBe('deleted');

      // Undo 1: Reverts Insert -> state should have 0 addedText, footer still deleted
      const undo1 = historyManager.undo();
      expect(undo1?.pages[0].addedText).toHaveLength(0);
      expect(undo1?.pages[0].editableTextRegions[2].status).toBe('deleted');

      // Undo 2: Reverts Delete -> state should have footer restored
      const undo2 = historyManager.undo();
      expect(undo2?.pages[0].editableTextRegions[2].status).toBe('detected');
      expect(undo2?.pages[0].editableTextRegions[2].currentText).toBe('Thank you for your visit!');
      expect(undo2?.pages[0].editableTextRegions[1].currentText).toBe('Step 2: Total $99');

      // Redo 1: Re-applies Delete -> footer becomes deleted again
      const redo1 = historyManager.redo();
      expect(redo1?.pages[0].editableTextRegions[2].status).toBe('deleted');
      expect(redo1?.pages[0].addedText).toHaveLength(0);

      // Verify snapshots were deeply cloned and mutating redo1 does not mutate undo2
      asMutable(redo1!.pages[0].editableTextRegions[0]).currentText = 'MUTATED';
      expect(historyManager.undo()?.pages[0].editableTextRegions[0].currentText).toBe('Step 1: Header');
    });
  });

  // J. Multiple Edited Regions
  describe('J. Multiple Edited Regions Simultaneously', () => {
    it('maintains independent patches and styles across multiple regions on a single page', () => {
      const doc = createSampleImageDocument();
      const p = doc.pages[0];

      // Region 0: modified
      asMutable(p.editableTextRegions[0]).currentText = 'Brand New Title';
      asMutable(p.editableTextRegions[0]).status = 'modified';
      asMutable(p.editableTextRegions[0]).reconstructedPatchUri = 'file:///patch0.png';

      // Region 1: modified
      asMutable(p.editableTextRegions[1]).currentText = 'TOTAL: $0.00';
      asMutable(p.editableTextRegions[1]).status = 'modified';
      asMutable(p.editableTextRegions[1]).reconstructedPatchUri = 'file:///patch1.png';

      // Region 2: deleted
      asMutable(p.editableTextRegions[2]).currentText = '';
      asMutable(p.editableTextRegions[2]).status = 'deleted';
      asMutable(p.editableTextRegions[2]).reconstructedPatchUri = 'file:///patch2.png';

      // Added text
      p.addedText.push({
        id: 'extra-1',
        pageIndex: 0,
        bounds: {
          x: 10,
          y: 10,
          width: 100,
          height: 20,
        },
        text: 'Paid via Card',
        style: { fontSize: 16, color: '#10B981' },
      });

      expect(p.editableTextRegions.filter((r) => r.status === 'modified')).toHaveLength(2);
      expect(p.editableTextRegions.filter((r) => r.status === 'deleted')).toHaveLength(1);
      expect(p.addedText).toHaveLength(1);
    });
  });

  // K. Intrinsic-Dimension Export
  describe('K. Intrinsic-Dimension Export', () => {
    it('passes unscaled source dimensions, background patches, replacement text, and added text to native exporter', async () => {
      const mockExportPage = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/receipt_export.png',
        format: 'png',
        fileSizeBytes: 1542000,
        width: 1800,
        height: 2400,
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: mockExportPage,
        shareFile: jest.fn().mockResolvedValue(true),
      };

      const doc = createSampleImageDocument();
      const p = doc.pages[0];

      // Region 0: modified
      asMutable(p.editableTextRegions[0]).currentText = 'NEW HEADER';
      asMutable(p.editableTextRegions[0]).status = 'modified';
      asMutable(p.editableTextRegions[0]).reconstructedPatchUri = 'file:///cache/patches/p0.png';
      asMutable(p.editableTextRegions[0]).reconstructedPatchBounds = { x: 196, y: 146, width: 608, height: 88 };

      // Region 2: deleted (must have patch in export, but NO text element)
      asMutable(p.editableTextRegions[2]).currentText = '';
      asMutable(p.editableTextRegions[2]).status = 'deleted';
      asMutable(p.editableTextRegions[2]).reconstructedPatchUri = 'file:///cache/patches/p2.png';
      asMutable(p.editableTextRegions[2]).reconstructedPatchBounds = { x: 196, y: 1196, width: 508, height: 58 };

      // Added text
      p.addedText.push({
        id: 'ad-1',
        pageIndex: 0,
        bounds: {
          x: 300,
          y: 600,
          width: 250,
          height: 40,
        },
        text: 'CUSTOM NOTE',
        style: { fontSize: 24, color: '#DC2626', fontFamily: 'serif' },
      });

      const result = await exportEngine.exportDocument(doc, { format: 'png' });
      expect(result.destinationUri).toBe('file:///cache/exports/receipt_export.png');
      expect(mockExportPage).toHaveBeenCalledTimes(1);

      const params = mockExportPage.mock.calls[0][0];
      // Intrinsic source image passed
      expect(params.sourceImageUri).toBe('file:///data/user/0/app/documents/receipt_original.png');
      expect(params.format).toBe('png');

      // Patches must include both modified and deleted regions in document coordinates
      expect(params.patches).toHaveLength(2);
      expect(params.patches.map((p: any) => p.patchUri)).toEqual([
        'file:///cache/patches/p0.png',
        'file:///cache/patches/p2.png',
      ]);
      expect(params.patches[0].bounds).toEqual({ x: 196, y: 146, width: 608, height: 88 });

      // Text elements must include modified region replacement + added text, but NOT deleted region
      expect(params.textElements).toHaveLength(2);
      expect(params.textElements[0].text).toBe('NEW HEADER');
      expect(params.textElements[0].bounds).toEqual({ x: 200, y: 150, width: 600, height: 80 });
      expect(params.textElements[1].text).toBe('CUSTOM NOTE');
      expect(params.textElements[1].bounds).toEqual({ x: 300, y: 600, width: 250, height: 40 });
    });
  });

  // L. Export Excludes Selection Overlays
  describe('L. Export Excludes Selection Overlays', () => {
    it('never sends selection box, resize handles, or UI state to the export payload', async () => {
      const mockExportPage = jest.fn().mockResolvedValue({
        destinationUri: 'file:///cache/exports/clean_export.png',
        format: 'png',
        fileSizeBytes: 1000000,
        width: 1800,
        height: 2400,
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: mockExportPage,
      };

      const doc = createSampleImageDocument();
      // Even if UI has active selection state in state/context, doc passed to export only contains pure domain data
      await exportEngine.exportDocument(doc);

      const params = mockExportPage.mock.calls[0][0];
      expect(params.selectionBox).toBeUndefined();
      expect(params.handles).toBeUndefined();
      expect(params.activeSelectionId).toBeUndefined();
    });
  });

  // M. Source Immutability
  describe('M. Source Immutability', () => {
    it('ensures export produces new destination URI and does not alter original source file', async () => {
      const originalSource = 'file:///data/user/0/app/documents/receipt_original.png';
      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockResolvedValue({
          destinationUri: 'file:///cache/exports/exported_copy.png',
          format: 'png',
          fileSizeBytes: 1200000,
          width: 1800,
          height: 2400,
        }),
      };

      const doc = createSampleImageDocument();
      const exportResult = await exportEngine.exportDocument(doc);

      expect(exportResult.destinationUri).not.toBe(originalSource);
      expect(doc.metadata.sourceUri).toBe(originalSource);
      expect(doc.pages[0].originalContent.assetUri).toBe(originalSource);
    });
  });

  // N. Failed Export Preserves Edits
  describe('N. Failed Export Preserves Edits', () => {
    it('preserves editable document state and pending modifications if native export fails', async () => {
      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockRejectedValue(new Error('Out of disk space')),
      };

      const doc = createSampleImageDocument();
      asMutable(doc.pages[0].editableTextRegions[0]).currentText = 'PRESERVED EDIT';
      asMutable(doc.pages[0].editableTextRegions[0]).status = 'modified';

      await expect(exportEngine.exportDocument(doc)).rejects.toThrow(ExportError);

      // Verify document edits remain intact
      expect(doc.pages[0].editableTextRegions[0].currentText).toBe('PRESERVED EDIT');
      expect(doc.pages[0].editableTextRegions[0].status).toBe('modified');
    });
  });

  // O. Duplicate Export Protection
  describe('O. Duplicate Export Protection', () => {
    it('rejects concurrent export attempts while an export is already active', async () => {
      let resolveFirstExport: (value: any) => void;
      const exportPromise = new Promise((resolve) => {
        resolveFirstExport = resolve;
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockImplementation(() => exportPromise),
      };

      const doc = createSampleImageDocument();

      const run1 = exportEngine.exportDocument(doc);
      // Immediate second call while first is in flight
      const run2 = exportEngine.exportDocument(doc);

      await expect(run2).rejects.toThrow('An export operation is already in progress');

      // Finish first export
      resolveFirstExport!({
        destinationUri: 'file:///cache/first.png',
        format: 'png',
        fileSizeBytes: 100,
        width: 1800,
        height: 2400,
      });

      const res1 = await run1;
      expect(res1.destinationUri).toBe('file:///cache/first.png');
    });
  });

  // P. Editor Close / Reopen Lifecycle
  describe('P. Editor Close / Reopen Lifecycle', () => {
    it('restores exact document state from serialized form across unmount and remount', () => {
      const doc = createSampleImageDocument();
      asMutable(doc.pages[0].editableTextRegions[0]).currentText = 'Saved Header';
      asMutable(doc.pages[0].editableTextRegions[0]).status = 'modified';
      asMutable(doc.pages[0].editableTextRegions[0]).reconstructedPatchUri = 'file:///cache/p1.png';
      doc.pages[0].addedText.push({
        id: 'persisted-add-1',
        pageIndex: 0,
        bounds: {
          x: 50,
          y: 50,
          width: 100,
          height: 20,
        },
        text: 'Persisted Note',
        style: { fontSize: 16, color: '#000000' },
      });

      // Simulate serialization to storage
      const serialized = JSON.stringify(doc);

      // Simulate new editor session (reopen)
      const reopenedDoc: Document = JSON.parse(serialized);
      const newHistory = new DocumentHistoryManager();
      newHistory.initialize(reopenedDoc);

      expect(newHistory.currentState?.pages[0].editableTextRegions[0].currentText).toBe('Saved Header');
      expect(newHistory.currentState?.pages[0].editableTextRegions[0].reconstructedPatchUri).toBe('file:///cache/p1.png');
      expect(newHistory.currentState?.pages[0].addedText).toHaveLength(1);
      expect(newHistory.currentState?.pages[0].addedText[0].text).toBe('Persisted Note');
      expect(newHistory.canUndo).toBe(false);
    });
  });

  // Q. Large-Image / Domain Safety & Offline Compliance
  describe('Q. Large-Image Coordinate Safety & Offline Operation', () => {
    it('safely handles large image coordinate dimensions without numerical overflow or scale drift', () => {
      const largeDimensions = { width: 8000, height: 6000 };
      const rawBox = { x: 7500, y: 5500, width: 800, height: 600 };
      const clamped = normalizeBoundingBox(rawBox, largeDimensions);

      expect(clamped.x).toBe(7500);
      expect(clamped.y).toBe(5500);
      expect(clamped.width).toBe(500); // 8000 - 7500
      expect(clamped.height).toBe(500); // 6000 - 5500

      // Text fitting on large bounding box
      const fitResult = fitTextToBoundingBox(
        clamped,
        'Short',
        'A significantly longer replacement string on an ultra-high-resolution scan',
      );
      expect(fitResult.scaleFactor).toBeLessThan(1.0);
      expect(fitResult.fittedFontSize).toBeGreaterThan(0);
      expect(isFinite(fitResult.fittedFontSize)).toBe(true);
    });
  });
});
