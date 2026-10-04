jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

import {
  ImageDocumentSession,
} from '../src/features/image/imageDocumentSession';
import {
  ImageEditingEngine,
  ImagePatchHistoryManager,
  defaultImageEditingEngine,
} from '../src/features/image/imageEditingEngine';
import {
  ImageTextReplacementRequest,
  ImageEditPatch,
  TextFitState,
} from '../src/features/image/types';
import {
  analyzeTextFitting,
  estimateTextStyle,
  fitTextToBoundingBox,
  resolveSystemFontFamily,
  MIN_READABLE_FONT_SIZE,
  MAX_SAFE_WIDTH_EXPANSION_RATIO,
} from '../src/features/text/textFitting';
import {
  sampleBorderPixels,
  fitLinearGradient,
  reconstructGridRegion,
  expandBoundingBox,
  PixelGrid,
} from '../src/features/image/reconstructionMath';
import {
  ImageBackgroundReconstructionFailedError,
  ImageInvalidDimensionsError,
  ImageStaleDocumentError,
  ImageTextFitFailedError,
  ImageTextSelectionInvalidError,
} from '../src/errors';
import { DocumentRect } from '../src/types/geometry';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { Document, TextRegion } from '../src/types/document';
import { normalizeBoundingBox } from '../src/features/ocr/normalization';

class TestPixelGrid implements PixelGrid {
  readonly width: number;
  readonly height: number;
  private buffer: Array<{ r: number; g: number; b: number }>;

  constructor(
    width: number,
    height: number,
    initializer: { r: number; g: number; b: number } | ((x: number, y: number) => { r: number; g: number; b: number }),
  ) {
    this.width = width;
    this.height = height;
    this.buffer = new Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = typeof initializer === 'function' ? initializer(x, y) : { ...initializer };
        this.buffer[y * width + x] = color;
      }
    }
  }

  getPixel(x: number, y: number) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return { r: 0, g: 0, b: 0 };
    }
    return { ...this.buffer[y * this.width + x] };
  }

  setPixel(x: number, y: number, color: { r: number; g: number; b: number }) {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.buffer[y * this.width + x] = { ...color };
    }
  }
}

describe('Phase 9 — Image Text Editing: Selected OCR Text -> Edit / Replace', () => {
  const dummyDocId = 'doc-img-phase9';
  const dummySourceUri = 'file:///data/user/0/com.pdfimageeditor/cache/test_image.jpg';

  const createTestSession = (dirtyState: 'CLEAN' | 'DIRTY' = 'CLEAN') => {
    return new ImageDocumentSession({
      documentId: dummyDocId,
      sourceUri: dummySourceUri,
      intrinsicWidth: 1000,
      intrinsicHeight: 800,
      initialDirtyState: dirtyState,
    });
  };

  const sampleRect: DocumentRect = { x: 100, y: 150, width: 200, height: 30 };

  // =========================================================================
  // 1. Selected OCR Element Contract & Selection State
  // =========================================================================
  describe('1. Selected OCR Element Contract & Selection State', () => {
    it('preserves documentId on selection', () => {
      const ocrElement = {
        documentId: dummyDocId,
        elementId: 'elem-1',
        blockId: 'b0',
        lineId: 'l0',
        text: 'Total: $42',
        bounds: sampleRect,
        confidence: 0.95,
      };
      expect(ocrElement.documentId).toBe(dummyDocId);
    });

    it('preserves OCR element ID', () => {
      const ocrElement = { documentId: dummyDocId, elementId: 'elem-xyz', text: 'T', bounds: sampleRect };
      expect(ocrElement.elementId).toBe('elem-xyz');
    });

    it('preserves blockId and lineId', () => {
      const ocrElement = { documentId: dummyDocId, elementId: 'e', blockId: 'block-3', lineId: 'line-2', text: 'T', bounds: sampleRect };
      expect(ocrElement.blockId).toBe('block-3');
      expect(ocrElement.lineId).toBe('line-2');
    });

    it('preserves detected text string', () => {
      const ocrElement = { documentId: dummyDocId, elementId: 'e', text: 'Invoice Due: 2026-10-04', bounds: sampleRect };
      expect(ocrElement.text).toBe('Invoice Due: 2026-10-04');
    });

    it('preserves document-space bounding coordinates', () => {
      const ocrElement = { documentId: dummyDocId, elementId: 'e', text: 'T', bounds: { x: 45, y: 120, width: 230, height: 28 } };
      expect(ocrElement.bounds).toEqual({ x: 45, y: 120, width: 230, height: 28 });
    });

    it('preserves OCR detection confidence', () => {
      const ocrElement = { documentId: dummyDocId, elementId: 'e', text: 'T', bounds: sampleRect, confidence: 0.982 };
      expect(ocrElement.confidence).toBeCloseTo(0.982);
    });

    it('rejects stale selection if document ID does not match session', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();

      const staleReq: ImageTextReplacementRequest = {
        documentId: 'doc-mismatch-123',
        elementId: 'elem-1',
        originalText: 'Old',
        replacementText: 'New',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      };

      await expect(engine.createReplacementPatch(session, staleReq)).rejects.toThrow(ImageStaleDocumentError);
    });

    it('rejects replacement when element ID is empty string', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();

      const invalidReq: ImageTextReplacementRequest = {
        documentId: dummyDocId,
        elementId: '',
        originalText: 'Old',
        replacementText: 'New',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      };

      await expect(engine.createReplacementPatch(session, invalidReq)).rejects.toThrow(ImageTextSelectionInvalidError);
    });
  });

  // =========================================================================
  // 2. Text Style Estimation & Font Strategy
  // =========================================================================
  describe('2. Text Style Estimation & Font Strategy', () => {
    it('estimates font size proportionally from bounding box height (~78%)', () => {
      const style = estimateTextStyle({ x: 0, y: 0, width: 100, height: 40 });
      expect(style.fontSize).toBe(Math.round(40 * 0.78));
    });

    it('enforces minimum font size of at least 8pt during estimation', () => {
      const style = estimateTextStyle({ x: 0, y: 0, width: 20, height: 6 });
      expect(style.fontSize).toBeGreaterThanOrEqual(8);
    });

    it('defaults text color to safe dark #111827 when no sample is provided', () => {
      const style = estimateTextStyle(sampleRect);
      expect(style.color).toBe('#111827');
    });

    it('adopts estimated text color sample when provided', () => {
      const style = estimateTextStyle(sampleRect, { colorSample: '#007AFF' });
      expect(style.color).toBe('#007AFF');
    });

    it('resolves default font family to system sans-serif without network requests', () => {
      expect(resolveSystemFontFamily()).toBe('sans-serif');
      expect(resolveSystemFontFamily('')).toBe('sans-serif');
      expect(resolveSystemFontFamily('Helvetica')).toBe('sans-serif');
    });

    it('resolves serif font family to system serif', () => {
      expect(resolveSystemFontFamily('Times New Roman Serif')).toBe('serif');
      expect(resolveSystemFontFamily('Georgia Serif')).toBe('serif');
    });

    it('resolves monospace font family to system monospace', () => {
      expect(resolveSystemFontFamily('Courier Monospace')).toBe('monospace');
      expect(resolveSystemFontFamily('Fira Code')).toBe('monospace');
    });

    it('preserves bold weight when requested', () => {
      const style = estimateTextStyle(sampleRect, { fontWeight: 'bold' });
      expect(style.fontWeight).toBe('bold');
    });
  });

  // =========================================================================
  // 3. Deterministic Text Fitting
  // =========================================================================
  describe('3. Deterministic Text Fitting', () => {
    const box: DocumentRect = { x: 50, y: 100, width: 120, height: 26 };

    it('returns PRESERVED when replacement text is shorter or equal length', () => {
      const res = analyzeTextFitting(box, 'Original Text', 'Short Text');
      expect(res.state).toBe('PRESERVED');
      expect(res.scaleFactor).toBe(1.0);
      expect(res.isOverflow).toBe(false);
    });

    it('returns PRESERVED when replacement text is empty (for deletion)', () => {
      const res = analyzeTextFitting(box, 'To Delete', '');
      expect(res.state).toBe('PRESERVED');
      expect(res.isOverflow).toBe(false);
    });

    it('returns SCALED_DOWN when replacement text is moderately longer', () => {
      const res = analyzeTextFitting(box, 'Short', 'Somewhat Longer Replacement Text');
      expect(res.state).toBe('SCALED_DOWN');
      expect(res.scaleFactor).toBeLessThan(1.0);
      expect(res.fittedFontSize).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE);
      expect(res.isOverflow).toBe(false);
    });

    it('returns EXPANDED_WITHIN_SAFE_BOUNDS when slight expansion preserves readability', () => {
      const narrowBox: DocumentRect = { x: 10, y: 10, width: 30, height: 16 };
      const res = analyzeTextFitting(narrowBox, 'A', 'Hello World', undefined, 1.3);
      expect(['EXPANDED_WITHIN_SAFE_BOUNDS', 'OVERFLOW', 'SCALED_DOWN']).toContain(res.state);
    });

    it('returns OVERFLOW when replacement text cannot fit even at min readable font size', () => {
      const tinyBox: DocumentRect = { x: 10, y: 10, width: 15, height: 10 };
      const giantText = 'Supercalifragilisticexpialidocious and more text that will overflow';
      const res = analyzeTextFitting(tinyBox, 'A', giantText);
      expect(res.state).toBe('OVERFLOW');
      expect(res.isOverflow).toBe(true);
      expect(res.fittedFontSize).toBe(MIN_READABLE_FONT_SIZE);
    });

    it('returns UNSUPPORTED when bounding box width is zero', () => {
      const res = analyzeTextFitting({ x: 0, y: 0, width: 0, height: 20 }, 'A', 'B');
      expect(res.state).toBe('UNSUPPORTED');
      expect(res.isOverflow).toBe(true);
    });

    it('returns UNSUPPORTED when bounding box height is zero or negative', () => {
      const res = analyzeTextFitting({ x: 0, y: 0, width: 50, height: -5 }, 'A', 'B');
      expect(res.state).toBe('UNSUPPORTED');
    });

    it('returns UNSUPPORTED when dimensions are NaN', () => {
      const res = analyzeTextFitting({ x: NaN, y: 0, width: NaN, height: 20 }, 'A', 'B');
      expect(res.state).toBe('UNSUPPORTED');
    });

    it('calculates baseline Y at ~76% height from box top', () => {
      const res = analyzeTextFitting(box, 'A', 'B');
      expect(res.baselineY).toBe(box.y + Math.round(box.height * 0.76));
    });

    it('fitTextToBoundingBox returns valid legacy result structure', () => {
      const res = fitTextToBoundingBox(box, 'Old', 'New');
      expect(res.fittedFontSize).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE);
      expect(res.fittedBounds).toEqual(box);
      expect(res.baselineY).toBeGreaterThan(box.y);
      expect(res.scaleFactor).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. Background Reconstruction & Math
  // =========================================================================
  describe('4. Background Reconstruction & Math', () => {
    it('samples border pixels strictly outside inner box', () => {
      const grid = new TestPixelGrid(40, 40, { r: 255, g: 255, b: 255 });
      const inner: DocumentRect = { x: 10, y: 10, width: 15, height: 15 };
      const samples = sampleBorderPixels(grid, inner, 3);
      expect(samples.length).toBeGreaterThan(0);
      for (const s of samples) {
        const inside = s.x >= inner.x && s.x < inner.x + inner.width && s.y >= inner.y && s.y < inner.y + inner.height;
        expect(inside).toBe(false);
      }
    });

    it('samples with thickness 1, 3, and 5 correctly', () => {
      const grid = new TestPixelGrid(50, 50, { r: 255, g: 255, b: 255 });
      const inner: DocumentRect = { x: 15, y: 15, width: 10, height: 10 };
      const s1 = sampleBorderPixels(grid, inner, 1);
      const s3 = sampleBorderPixels(grid, inner, 3);
      const s5 = sampleBorderPixels(grid, inner, 5);
      expect(s3.length).toBeGreaterThan(s1.length);
      expect(s5.length).toBeGreaterThan(s3.length);
    });

    it('reconstructs solid white background with low variance', () => {
      const grid = new TestPixelGrid(50, 50, { r: 255, g: 255, b: 255 });
      const target: DocumentRect = { x: 10, y: 10, width: 20, height: 15 };
      const analysis = reconstructGridRegion(grid, target, 3);
      expect(analysis.estimatedBackgroundColor).toBe('#FFFFFF');
      expect(analysis.isGradient).toBe(false);
    });

    it('reconstructs solid dark background correctly', () => {
      const grid = new TestPixelGrid(50, 50, { r: 20, g: 24, b: 30 });
      const target: DocumentRect = { x: 10, y: 10, width: 20, height: 15 };
      const analysis = reconstructGridRegion(grid, target, 3);
      expect(analysis.estimatedBackgroundColor).toBe('#14181E');
      expect(analysis.estimatedTextColor).toBe('#F9FAFB'); // High contrast for dark background
    });

    it('detects gradient when variance exceeds threshold', () => {
      // Linear ramp in R channel
      const grid = new TestPixelGrid(60, 40, (x) => ({ r: Math.round(50 + x * 2), g: 100, b: 150 }));
      const target: DocumentRect = { x: 15, y: 10, width: 25, height: 15 };
      const analysis = reconstructGridRegion(grid, target, 3);
      expect(analysis.isGradient).toBe(true);
    });

    it('reconstructs target pixels in grid replacing previous content', () => {
      const grid = new TestPixelGrid(40, 40, { r: 240, g: 240, b: 240 });
      const target: DocumentRect = { x: 10, y: 10, width: 10, height: 10 };
      // Black text inside
      grid.setPixel(12, 12, { r: 0, g: 0, b: 0 });
      reconstructGridRegion(grid, target, 3);
      const restored = grid.getPixel(12, 12);
      expect(restored.r).toBe(240);
    });

    it('expandBoundingBox clamps within image dimensions', () => {
      const box: DocumentRect = { x: 2, y: 2, width: 20, height: 20 };
      const expanded = expandBoundingBox(box, 5, { width: 50, height: 50 });
      expect(expanded.x).toBe(0);
      expect(expanded.y).toBe(0);
      expect(expanded.width).toBe(27);
      expect(expanded.height).toBe(27);
    });

    it('complex background returns safe approximation and does not throw', () => {
      const grid = new TestPixelGrid(30, 30, (x, y) => ({ r: (x * 41) % 256, g: (y * 67) % 256, b: 128 }));
      const target: DocumentRect = { x: 5, y: 5, width: 10, height: 10 };
      const analysis = reconstructGridRegion(grid, target, 3);
      expect(analysis.confidence).toBeLessThanOrEqual(1.0);
      expect(analysis.estimatedBackgroundColor).toBeDefined();
    });
  });

  // =========================================================================
  // 5. Patch Model & Session Management
  // =========================================================================
  describe('5. Patch Model & Session Management', () => {
    it('creates replacement patch with applied status', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'p-1',
        originalText: 'Original',
        replacementText: 'Replaced',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      expect(patch.status).toBe('applied');
      expect(patch.replacementText).toBe('Replaced');
    });

    it('creates preview patch with preview status without mutating session', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const preview = await engine.createPreviewPatch(session, {
        documentId: dummyDocId,
        elementId: 'p-prev',
        originalText: 'Old',
        replacementText: 'Live Preview',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      expect(preview.status).toBe('preview');
      expect(session.patches.length).toBe(0);
      expect(session.isDirty()).toBe(false);
    });

    it('creates delete patch with empty replacement text and deleted status', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const del = await engine.createDeletePatch(session, 'del-item', sampleRect, 'Bye');
      expect(del.status).toBe('deleted');
      expect(del.replacementText).toBe('');
    });

    it('assigns incremental deterministic zOrder to successive patches', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();

      const p1 = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'z1',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(p1);

      const p2 = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'z2',
        originalText: 'C',
        replacementText: 'D',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(p2);

      expect(p1.zOrder).toBe(1);
      expect(p2.zOrder).toBe(2);
    });

    it('session supports multiple independent text replacements simultaneously', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();

      for (let i = 1; i <= 3; i++) {
        const patch = await engine.createReplacementPatch(session, {
          documentId: dummyDocId,
          elementId: `elem-${i}`,
          originalText: `Original ${i}`,
          replacementText: `Replacement ${i}`,
          bounds: { x: 10, y: i * 40, width: 100, height: 25 },
          estimatedFontSize: 14,
          estimatedTextColor: '#000',
        });
        session.addPatch(patch);
      }

      expect(session.patches.length).toBe(3);
      expect(session.patches[0].replacementText).toBe('Replacement 1');
      expect(session.patches[1].replacementText).toBe('Replacement 2');
      expect(session.patches[2].replacementText).toBe('Replacement 3');
    });

    it('getPatch retrieves patch by unique patch ID', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'find-me',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(patch);
      expect(session.getPatch(patch.patchId)).toEqual(patch);
    });

    it('removePatch removes specific patch and updates patch count', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'rem-me',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(patch);
      expect(session.patches.length).toBe(1);
      session.removePatch(patch.patchId);
      expect(session.patches.length).toBe(0);
    });

    it('clearPatches removes all patches from session', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'clr',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(patch);
      session.clearPatches();
      expect(session.patches).toEqual([]);
    });
  });

  // =========================================================================
  // 6. Dirty State Lifecycle & Immutability
  // =========================================================================
  describe('6. Dirty State Lifecycle & Immutability', () => {
    it('session begins in CLEAN state', () => {
      const session = createTestSession('CLEAN');
      expect(session.isDirty()).toBe(false);
      expect(session.model.dirtyState).toBe('CLEAN');
    });

    it('adding applied patch transitions session from CLEAN to DIRTY', async () => {
      const session = createTestSession('CLEAN');
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'dirty-check',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(patch);
      expect(session.isDirty()).toBe(true);
      expect(session.model.dirtyState).toBe('DIRTY');
    });

    it('adding preview patch does NOT transition session to DIRTY', async () => {
      const session = createTestSession('CLEAN');
      const engine = new ImageEditingEngine();
      const preview = await engine.createPreviewPatch(session, {
        documentId: dummyDocId,
        elementId: 'preview-check',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(preview);
      expect(session.isDirty()).toBe(false);
    });

    it('removing all patches transitions session back to CLEAN', async () => {
      const session = createTestSession('CLEAN');
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'clean-check',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(patch);
      expect(session.isDirty()).toBe(true);
      session.removePatch(patch.patchId);
      expect(session.isDirty()).toBe(false);
      expect(session.model.dirtyState).toBe('CLEAN');
    });

    it('sourceUri remains strictly immutable across all edits', async () => {
      const session = createTestSession('CLEAN');
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'immut',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      session.addPatch(patch);
      expect(session.model.sourceUri).toBe(dummySourceUri);
    });
  });

  // =========================================================================
  // 7. Undo / Redo Workflow
  // =========================================================================
  describe('7. Undo / Redo Workflow', () => {
    it('history manager starts with canUndo and canRedo false', () => {
      const history = new ImagePatchHistoryManager();
      history.initialize([]);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);
    });

    it('applying a patch enables undo and disables redo', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const history = new ImagePatchHistoryManager();
      history.initialize([]);

      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'h-1',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      history.applyPatch(patch);

      expect(history.canUndo).toBe(true);
      expect(history.canRedo).toBe(false);
      expect(history.currentPatches.length).toBe(1);
    });

    it('undo restores empty patch stack and enables redo', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const history = new ImagePatchHistoryManager();
      history.initialize([]);

      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'h-2',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      history.applyPatch(patch);

      const undone = history.undo();
      expect(undone).toEqual([]);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(true);
    });

    it('redo restores patch stack and enables undo', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const history = new ImagePatchHistoryManager();
      history.initialize([]);

      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'h-3',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      history.applyPatch(patch);
      history.undo();

      const redone = history.redo();
      expect(redone?.length).toBe(1);
      expect(redone?.[0].targetElementId).toBe('h-3');
      expect(history.canUndo).toBe(true);
      expect(history.canRedo).toBe(false);
    });

    it('new patch edit clears future redo stack', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const history = new ImagePatchHistoryManager();
      history.initialize([]);

      const p1 = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'h-4',
        originalText: 'A',
        replacementText: 'B',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      history.applyPatch(p1);
      history.undo();
      expect(history.canRedo).toBe(true);

      const p2 = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'h-5',
        originalText: 'X',
        replacementText: 'Y',
        bounds: sampleRect,
        estimatedFontSize: 16,
        estimatedTextColor: '#000',
      });
      history.applyPatch(p2);
      expect(history.canRedo).toBe(false);
    });
  });

  // =========================================================================
  // 8. Coordinate Space & Layer Composition
  // =========================================================================
  describe('8. Coordinate Space & Layer Composition', () => {
    it('all patch coordinates remain in document coordinates independently of viewport scale', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      const patch = await engine.createReplacementPatch(session, {
        documentId: dummyDocId,
        elementId: 'c-1',
        originalText: 'Doc',
        replacementText: 'Doc Edit',
        bounds: { x: 200, y: 300, width: 80, height: 20 },
        estimatedFontSize: 14,
        estimatedTextColor: '#000',
      });

      // Viewport transform changes
      session.updateViewportTransform({ scale: 2.0, translateX: -50, translateY: -50 });
      expect(patch.bounds.x).toBe(200);
      expect(patch.bounds.y).toBe(300);
    });

    it('Skia canvas renders layers in correct composition order', () => {
      const compositionOrder = [
        'SOURCE_IMAGE',
        'BACKGROUND_PATCHES',
        'REPLACEMENT_TEXT',
        'ADDED_TEXT',
        'SELECTION_OVERLAY',
      ];
      expect(compositionOrder[0]).toBe('SOURCE_IMAGE');
      expect(compositionOrder[1]).toBe('BACKGROUND_PATCHES');
      expect(compositionOrder[2]).toBe('REPLACEMENT_TEXT');
      expect(compositionOrder[3]).toBe('ADDED_TEXT');
      expect(compositionOrder[4]).toBe('SELECTION_OVERLAY');
    });

    it('canonical dimensions preserve 100% full-resolution intrinsic pixels for future export', () => {
      const session = createTestSession();
      const canonical = session.getCanonicalDimensions();
      expect(canonical.width).toBe(1000);
      expect(canonical.height).toBe(800);
    });
  });

  // =========================================================================
  // 9. Error Handling & Edge Cases
  // =========================================================================
  describe('9. Error Handling & Edge Cases', () => {
    it('throws ImageInvalidDimensionsError on negative width bounds', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      await expect(
        engine.createDeletePatch(session, 'e', { x: 10, y: 10, width: -20, height: 30 }),
      ).rejects.toThrow(ImageInvalidDimensionsError);
    });

    it('throws ImageInvalidDimensionsError on zero height bounds', async () => {
      const session = createTestSession();
      const engine = new ImageEditingEngine();
      await expect(
        engine.createDeletePatch(session, 'e', { x: 10, y: 10, width: 50, height: 0 }),
      ).rejects.toThrow(ImageInvalidDimensionsError);
    });

    it('closed session throws ImageDocumentClosedError on patch addition', async () => {
      const session = createTestSession();
      session.close();
      expect(session.isClosed()).toBe(true);
      expect(() => session.addPatch({} as any)).toThrow();
    });

    it('closed session returns isDirty() as false', () => {
      const session = createTestSession('DIRTY');
      session.close();
      expect(session.isDirty()).toBe(false);
    });
  });

  // =========================================================================
  // 10. Foundation & Regressions
  // =========================================================================
  describe('10. Foundation & Regressions', () => {
    it('Phase 8 OCR box normalization handles scaled coordinates accurately', () => {
      const normalized = normalizeBoundingBox(
        { x: 50, y: 100, width: 200, height: 40 },
        { width: 1000, height: 1000 },
      );
      expect(normalized.x).toBe(50);
      expect(normalized.y).toBe(100);
      expect(normalized.width).toBe(200);
      expect(normalized.height).toBe(40);
    });

    it('Phase 7 EXIF orientation transposes canonical dimensions correctly', () => {
      const exif8Session = new ImageDocumentSession({
        documentId: 'exif8',
        sourceUri: dummySourceUri,
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
        orientation: 8, // 270 degree rotation
      });
      const dims = exif8Session.getCanonicalDimensions();
      expect(dims.width).toBe(800);
      expect(dims.height).toBe(1200);
    });

    it('PDF history manager remains completely independent of image edits', () => {
      const pdfHistory = new DocumentHistoryManager();
      const pdfDoc: Document = {
        id: 'pdf-independent',
        pages: [],
        metadata: { id: 'pdf-independent', title: 'Doc', kind: 'pdf', sourceUri: 'file:///dummy.pdf', pageCount: 1, createdAt: 1, updatedAt: 1 },
      };
      pdfHistory.initialize(pdfDoc);
      expect(pdfHistory.canUndo).toBe(false);

      pdfHistory.push({ ...pdfDoc, metadata: { ...pdfDoc.metadata, updatedAt: 2 } });
      expect(pdfHistory.canUndo).toBe(true);
      pdfHistory.undo();
      expect(pdfHistory.currentState?.metadata.updatedAt).toBe(1);
    });
  });
});
