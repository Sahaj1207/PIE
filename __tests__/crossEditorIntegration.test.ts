import { IPdfiumEngine, PdfDocumentHandle, PdfRenderedPage, PdfTextObject, PdfMultiEditResult } from '../src/features/pdf/types';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { ImageExportEngine } from '../src/features/export/imageExportEngine';
import { Document, TextRegion } from '../src/types/document';
import { ExportError, PdfBatchEditError } from '../src/errors';
import { documentStorage } from '../src/storage';
import { NativeModules } from 'react-native';

const asMutable = <T>(obj: T): any => obj;

class MockPdfiumEngine implements IPdfiumEngine {
  public openDocuments = new Set<number>();
  public nextHandle = 100;
  public batchEditCalls: any[] = [];
  public shouldFailBatchEdit = false;
  public shouldFailOpen = false;

  async openDocument(filePath: string): Promise<PdfDocumentHandle> {
    if (this.shouldFailOpen) {
      throw new Error(`Failed to open corrupted PDF file: ${filePath}`);
    }
    const handle = this.nextHandle++;
    this.openDocuments.add(handle);
    return {
      docHandle: handle,
      pageCount: 2,
      filePath,
    };
  }

  async closeDocument(docHandle: number): Promise<boolean> {
    this.openDocuments.delete(docHandle);
    return true;
  }

  async getPageCount(_docHandle: number): Promise<number> {
    return 2;
  }

  async renderPage(
    _docHandle: number,
    pageIndex: number,
    _options?: any,
  ): Promise<PdfRenderedPage> {
    return {
      filePath: 'file:///data/sample.pdf',
      uri: `file:///cache/rendered_page_${pageIndex}.png`,
      pageIndex,
      width: 1200,
      height: 1600,
      pageWidth: 595,
      pageHeight: 842,
      scale: 2.0,
    };
  }

  async getPageSize(_docHandle: number, pageIndex: number) {
    return { pageIndex, width: 595, height: 842 };
  }

  async getTextObjects(_docHandle: number, pageIndex: number): Promise<PdfTextObject[]> {
    return [
      {
        id: `p${pageIndex}_obj1`,
        pageIndex,
        objectIndex: 0,
        text: 'Sample Header Text',
        bounds: { x: 50, y: 700, width: 200, height: 24 },
        pdfBounds: { left: 50, bottom: 100, right: 250, top: 124 },
        fontSize: 18,
        fontName: 'Helvetica',
        color: '#111827',
        colorRgba: { r: 17, g: 24, b: 39, a: 1 },
        matrix: { a: 18, b: 0, c: 0, d: 18, e: 50, f: 100 },
        isEditable: true,
      },
    ];
  }

  // Verified copy (Save with no queued commands). Test double only: emulates the native
  // copy through this mock's batch implementation so failure injection still applies.
  async copyDocument(inputPdfPath: string, outputPdfPath: string): Promise<PdfMultiEditResult> {
    return this.applyBatchEdits({ inputPdfPath, outputPdfPath, commands: [] });
  }

  async applyBatchEdits(request: any): Promise<PdfMultiEditResult> {
    this.batchEditCalls.push(request);
    if (this.shouldFailBatchEdit) {
      throw new Error('Disk write failed during PDF save');
    }
    return {
      outputPath: request.outputPdfPath,
      totalCommands: request.commands.length,
      appliedCommands: request.commands.length,
      pageCountBefore: 2,
      pageCountAfter: 2,
      sourceUnchanged: true,
      sourceChecksumBefore: 'abc',
      sourceChecksumAfter: 'abc',
      commands: [],
      reopenedVerification: {
        allReplacementsVerified: true,
        allDeletionsVerified: true,
        verifiedReplacements: [],
        missingReplacements: [],
        residualDeletions: [],
      },
      limitations: [],
    };
  }

  async extractAssetPdf(assetName: string): Promise<string> {
    return `file:///cache/${assetName}`;
  }

  async hitTestTextObject(): Promise<PdfTextObject | null> {
    return null;
  }

  async replaceTextObject(_request: any): Promise<any> {
    return {} as any;
  }

  createEditor(): any {
    return {} as any;
  }
}

const createSampleImageDoc = (id = 'img-doc-1'): Document => ({
  id,
  metadata: {
    id,
    title: 'Sample Image Document',
    kind: 'image',
    sourceUri: 'file:///data/original_scan.png',
    pageCount: 1,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  },
  pages: [
    {
      id: `${id}-page-0`,
      pageIndex: 0,
      dimensions: { width: 1200, height: 1600 },
      rotation: 0,
      originalContent: {
        pageIndex: 0,
        assetUri: 'file:///data/original_scan.png',
        width: 1200,
        height: 1600,
      },
      editableTextRegions: [
        {
          id: 'region-1',
          pageIndex: 0,
          bounds: { x: 100, y: 150, width: 300, height: 50 },
          originalText: 'Original Scan Header',
          currentText: 'Original Scan Header',
          status: 'detected',
          style: { fontSize: 24, color: '#000000' },
        },
      ],
      addedText: [],
    },
  ],
});

describe('Phase 4B: Cross-Editor Integration & Production Hardening', () => {
  let mockEngine: MockPdfiumEngine;
  let pdfEditor: PdfDocumentEditor;
  let historyManager: DocumentHistoryManager;
  let exportEngine: ImageExportEngine;

  beforeEach(() => {
    mockEngine = new MockPdfiumEngine();
    pdfEditor = new PdfDocumentEditor(mockEngine);
    historyManager = new DocumentHistoryManager();
    exportEngine = new ImageExportEngine();
    jest.clearAllMocks();
  });

  // A. PDF → Home → Image
  describe('A. PDF -> Home -> Image Lifecycle Transition', () => {
    it('seamlessly transitions from PDF editor to Image editor, releasing native PDF handle', async () => {
      // 1. Open PDF document
      await pdfEditor.open('file:///data/sample.pdf');
      expect(mockEngine.openDocuments.size).toBe(1);

      // Extract text objects to populate cache
      await pdfEditor.getTextObjects(0);

      // Perform a PDF edit
      pdfEditor.replaceText('p0_obj1', 'Replaced Vector Text');
      expect(pdfEditor.getPendingEdits()).toHaveLength(1);

      // 2. Return to Home -> Editor closes and releases native handle
      await pdfEditor.close();
      expect(mockEngine.openDocuments.size).toBe(0);
      expect(pdfEditor.getPendingEdits()).toHaveLength(0);

      // 3. Open Image Editor
      const imageDoc = createSampleImageDoc('img-from-home');
      historyManager.initialize(imageDoc);
      expect(historyManager.currentState?.id).toBe('img-from-home');
      expect(historyManager.canUndo).toBe(false);

      // Modify image document
      const modifiedDoc = JSON.parse(JSON.stringify(imageDoc));
      asMutable(modifiedDoc.pages[0].editableTextRegions[0]).currentText = 'New Image Text';
      asMutable(modifiedDoc.pages[0].editableTextRegions[0]).status = 'modified';
      historyManager.push(modifiedDoc);

      expect(historyManager.canUndo).toBe(true);
      expect(historyManager.currentState?.pages[0].editableTextRegions[0].currentText).toBe('New Image Text');
    });
  });

  // B. Image → Home → PDF
  describe('B. Image -> Home -> PDF Lifecycle Transition', () => {
    it('clears image history snapshots on return Home before opening a new PDF document', async () => {
      // 1. Active Image Editor session
      const imageDoc = createSampleImageDoc('img-session-1');
      historyManager.initialize(imageDoc);
      const modDoc = JSON.parse(JSON.stringify(imageDoc));
      asMutable(modDoc.pages[0].editableTextRegions[0]).currentText = 'Edited Region';
      historyManager.push(modDoc);
      expect(historyManager.canUndo).toBe(true);

      // 2. Return Home: clear image editor state
      historyManager.clear();
      expect(historyManager.currentState).toBeNull();
      expect(historyManager.canUndo).toBe(false);

      // 3. Launch PDF Editor
      await pdfEditor.open('file:///data/document.pdf');
      expect(mockEngine.openDocuments.size).toBe(1);

      const objects = await pdfEditor.getTextObjects(0);
      expect(objects).toHaveLength(1);
      expect(objects[0].text).toBe('Sample Header Text');

      await pdfEditor.close();
      expect(mockEngine.openDocuments.size).toBe(0);
    });
  });

  // C. PDF failed import → recovery
  describe('C. PDF Failed Import -> Error Recovery', () => {
    it('handles corrupted PDF without leaking handles and recovers cleanly to sample PDF', async () => {
      mockEngine.shouldFailOpen = true;

      await expect(pdfEditor.open('file:///data/corrupted.pdf')).rejects.toThrow(
        'Failed to open corrupted PDF file',
      );

      // Zero handles leaked
      expect(mockEngine.openDocuments.size).toBe(0);

      // Recovery path: open bundled sample PDF
      mockEngine.shouldFailOpen = false;
      await pdfEditor.open('file:///cache/pdfium_spike_sample.pdf');
      expect(mockEngine.openDocuments.size).toBe(1);
      expect(pdfEditor.getPageCount()).toBe(2);

      await pdfEditor.close();
      expect(mockEngine.openDocuments.size).toBe(0);
    });
  });

  // D. Image failed import → recovery
  describe('D. Image Failed Import -> Error Recovery', () => {
    it('handles non-existent document ID gracefully via storage lookup', async () => {
      const nonExistentId = 'doc-does-not-exist-999';
      const doc = await documentStorage.getDocument(nonExistentId);
      expect(doc).toBeNull();

      // Ensure history manager remains safe when not initialized with null
      expect(historyManager.currentState).toBeNull();
      expect(historyManager.canUndo).toBe(false);
    });
  });

  // E. PDF save failure preserves state
  describe('E. PDF Save Failure Preserves State', () => {
    it('retains all pending edits and undo history when disk write fails', async () => {
      await pdfEditor.open('file:///data/contract.pdf');
      await pdfEditor.getTextObjects(0);
      pdfEditor.replaceText('p0_obj1', 'Modified Clause');
      expect(pdfEditor.getPendingEdits()).toHaveLength(1);
      expect(pdfEditor.canUndo()).toBe(true);

      // Simulate failure during batch edit save
      mockEngine.shouldFailBatchEdit = true;
      await expect(pdfEditor.saveEdits('file:///data/contract_saved.pdf')).rejects.toThrow(
        'Disk write failed during PDF save',
      );

      // Verify edits and history are preserved for retry
      expect(pdfEditor.getPendingEdits()).toHaveLength(1);
      expect((pdfEditor.getPendingEdits()[0] as any).newText).toBe('Modified Clause');
      expect(pdfEditor.canUndo()).toBe(true);

      // Retry when storage is restored
      mockEngine.shouldFailBatchEdit = false;
      const result = await pdfEditor.saveEdits('file:///data/contract_saved.pdf');
      expect(result.sourceUnchanged).toBe(true);
      expect(pdfEditor.getPendingEdits()).toHaveLength(0);

      await pdfEditor.close();
    });
  });

  // F. Image export failure preserves state
  describe('F. Image Export Failure Preserves State', () => {
    it('preserves document state and editable regions if native raster export fails', async () => {
      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockRejectedValue(new Error('Out of memory')),
      };

      const doc = createSampleImageDoc('img-fail-test');
      asMutable(doc.pages[0].editableTextRegions[0]).currentText = 'Edits Before Failed Export';
      asMutable(doc.pages[0].editableTextRegions[0]).status = 'modified';
      asMutable(doc.pages[0].editableTextRegions[0]).reconstructedPatchUri = 'file:///cache/p1.png';

      await expect(exportEngine.exportDocument(doc)).rejects.toThrow(ExportError);

      // Verify edits in memory were not destroyed
      expect(doc.pages[0].editableTextRegions[0].currentText).toBe('Edits Before Failed Export');
      expect(doc.pages[0].editableTextRegions[0].reconstructedPatchUri).toBe('file:///cache/p1.png');
    });
  });

  // G. Navigating away releases resources
  describe('G. Resource Release on Navigation Away', () => {
    it('guarantees complete native handle and state teardown when closing editors', async () => {
      await pdfEditor.open('file:///data/doc1.pdf');
      expect(mockEngine.openDocuments.size).toBe(1);

      await pdfEditor.close();
      expect(mockEngine.openDocuments.size).toBe(0);

      // Calling close repeatedly is safe (idempotent)
      await pdfEditor.close();
      expect(mockEngine.openDocuments.size).toBe(0);
    });
  });

  // H. Reopening another document resets state
  describe('H. Reopening Another Document Resets State', () => {
    it('closes prior PDF handle and clears prior caches when opening a second PDF', async () => {
      await pdfEditor.open('file:///data/first.pdf');
      const firstHandle = Array.from(mockEngine.openDocuments)[0];
      await pdfEditor.getTextObjects(0);
      pdfEditor.replaceText('p0_obj1', 'First Doc Edit');
      expect(pdfEditor.getPendingEdits()).toHaveLength(1);

      // Open second document on same editor instance
      await pdfEditor.open('file:///data/second.pdf');
      expect(mockEngine.openDocuments.has(firstHandle)).toBe(false);
      expect(mockEngine.openDocuments.size).toBe(1);
      expect(pdfEditor.getPendingEdits()).toHaveLength(0); // Edits from first doc are cleanly discarded

      await pdfEditor.close();
    });
  });

  // I. Unsaved changes remain detectable
  describe('I. Unsaved Changes Detectability', () => {
    it('accurately reports pending unsaved changes across both PDF and Image workflows', async () => {
      // PDF
      await pdfEditor.open('file:///data/detect.pdf');
      expect(pdfEditor.getPendingEdits().length).toBe(0);
      pdfEditor.insertText(0, 'New Note', { x: 50, y: 50 });
      expect(pdfEditor.getPendingEdits().length).toBe(1);
      expect(pdfEditor.canUndo()).toBe(true);

      // Image
      const imgDoc = createSampleImageDoc('detect-img');
      historyManager.initialize(imgDoc);
      expect(historyManager.canUndo).toBe(false);

      const modified = JSON.parse(JSON.stringify(imgDoc));
      modified.pages[0].addedText.push({
        id: 'note-1',
        pageIndex: 0,
        bounds: { x: 10, y: 10, width: 100, height: 20 },
        text: 'New Header',
        style: { fontSize: 16, color: '#000000' },
      });
      historyManager.push(modified);
      expect(historyManager.canUndo).toBe(true);

      await pdfEditor.close();
    });
  });

  // J. Duplicate save / export protection
  describe('J. Duplicate Save / Export Protection', () => {
    it('guards against concurrent PDF saves', async () => {
      await pdfEditor.open('file:///data/dup.pdf');
      await pdfEditor.getTextObjects(0);
      pdfEditor.replaceText('p0_obj1', 'Edit');

      let resolveSave: (value: any) => void;
      const deferredSave = new Promise((resolve) => {
        resolveSave = resolve;
      });

      mockEngine.applyBatchEdits = jest.fn().mockImplementation(() => deferredSave);

      const savePromise1 = pdfEditor.saveEdits('file:///data/dup_out.pdf');
      const savePromise2 = pdfEditor.saveEdits('file:///data/dup_out.pdf');

      await expect(savePromise2).rejects.toThrow('A save operation is already in progress');

      // Phase 12: a save must report its applied, reopen-verified edits to succeed.
      resolveSave!({
        outputPath: 'file:///data/dup_out.pdf',
        totalCommands: 1,
        appliedCommands: 1,
        pageCountBefore: 2,
        pageCountAfter: 2,
        sourceUnchanged: true,
        sourceChecksumBefore: 'abc',
        sourceChecksumAfter: 'abc',
        commands: [
          { type: 'replace', objectId: 'p0_obj1', pageIndex: 0, objectIndex: 1, status: 'applied', verifiedInReopened: true },
        ],
        reopenedVerification: {
          allReplacementsVerified: true,
          allDeletionsVerified: true,
          verifiedReplacements: ['Edit'],
          missingReplacements: [],
          residualDeletions: [],
        },
        limitations: [],
      });
      await savePromise1;
      await pdfEditor.close();
    });

    it('guards against concurrent Image exports', async () => {
      let resolveExport: (value: any) => void;
      const deferredExport = new Promise((resolve) => {
        resolveExport = resolve;
      });

      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockImplementation(() => deferredExport),
      };

      const doc = createSampleImageDoc('dup-export');
      const exp1 = exportEngine.exportDocument(doc);
      const exp2 = exportEngine.exportDocument(doc);

      await expect(exp2).rejects.toThrow('An export operation is already in progress');

      resolveExport!({
        destinationUri: 'file:///cache/out.png',
        format: 'png',
        fileSizeBytes: 200,
        width: 1200,
        height: 1600,
      });
      await exp1;
    });
  });

  // K. Source immutability across both editors
  describe('K. Source Immutability Across Both Editors', () => {
    it('enforces that PDF input and output paths are distinct', async () => {
      await pdfEditor.open('file:///data/source.pdf');
      await pdfEditor.getTextObjects(0);
      pdfEditor.replaceText('p0_obj1', 'New Text');

      // Attempting to overwrite source PDF must reject
      await expect(pdfEditor.saveEdits('file:///data/source.pdf')).rejects.toThrow(
        'Input and output paths must be different',
      );

      await pdfEditor.close();
    });

    it('enforces that image export produces new output path without overwriting source asset URI', async () => {
      const originalSource = 'file:///data/original_scan.png';
      NativeModules.ImageProcessingModule = {
        exportImagePage: jest.fn().mockResolvedValue({
          destinationUri: 'file:///cache/exports/exported_scan.png',
          format: 'png',
          fileSizeBytes: 2048,
          width: 1200,
          height: 1600,
        }),
      };

      const doc = createSampleImageDoc('immut-test');
      const result = await exportEngine.exportDocument(doc);

      expect(result.destinationUri).not.toBe(originalSource);
      expect(doc.metadata.sourceUri).toBe(originalSource);
      expect(doc.pages[0].originalContent.assetUri).toBe(originalSource);
    });
  });
});
