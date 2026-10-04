import {
  expandBoundingBox,
  fitLinearGradient,
  reconstructGridRegion,
  sampleBorderPixels,
  PixelGrid,
  RGBColor,
} from '../src/features/image/reconstructionMath';
import { fitTextToBoundingBox } from '../src/features/text/textFitting';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { Document, TextRegion } from '../src/types/document';
import { LocalBackgroundReconstructionEngine } from '../src/features/image/reconstructionEngine';

class SyntheticPixelGrid implements PixelGrid {
  readonly width: number;
  readonly height: number;
  private buffer: RGBColor[];

  constructor(width: number, height: number, fillColor: RGBColor = { r: 255, g: 255, b: 255 }) {
    this.width = width;
    this.height = height;
    this.buffer = new Array(width * height).fill(null).map(() => ({ ...fillColor }));
  }

  getPixel(x: number, y: number): RGBColor {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return { r: 0, g: 0, b: 0 };
    }
    return { ...this.buffer[y * this.width + x] };
  }

  setPixel(x: number, y: number, color: RGBColor): void {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.buffer[y * this.width + x] = { ...color };
    }
  }
}

describe('Phase 2B: Text Replacement & Background Reconstruction', () => {
  describe('Bounding Box Expansion & Coordinate Preservation', () => {
    it('expands bounding box by specified padding without altering center coordinates', () => {
      const box = { x: 50, y: 50, width: 100, height: 20 };
      const expanded = expandBoundingBox(box, 5, { width: 400, height: 400 });

      expect(expanded.x).toBe(45);
      expect(expanded.y).toBe(45);
      expect(expanded.width).toBe(110);
      expect(expanded.height).toBe(30);
    });

    it('clamps expanded bounding box to image boundaries', () => {
      const box = { x: 2, y: 3, width: 20, height: 10 };
      const expanded = expandBoundingBox(box, 10, { width: 100, height: 100 });

      expect(expanded.x).toBe(0);
      expect(expanded.y).toBe(0);
      expect(expanded.width).toBe(32);
      expect(expanded.height).toBe(23);
    });
  });

  describe('Text Fitting Algorithm', () => {
    const originalBounds = { x: 100, y: 100, width: 120, height: 24 };

    it('maintains font size when replacement text is shorter or equal length', () => {
      const result = fitTextToBoundingBox(originalBounds, 'Hello World', 'Hello');
      expect(result.scaleFactor).toBe(1.0);
      expect(result.fittedFontSize).toBeGreaterThanOrEqual(16);
      expect(result.baselineY).toBeGreaterThan(originalBounds.y);
    });

    it('deterministically scales down font size when replacement text is longer', () => {
      const result = fitTextToBoundingBox(
        originalBounds,
        'Short',
        'This is a significantly longer replacement text string',
      );
      expect(result.scaleFactor).toBeLessThan(1.0);
      expect(result.fittedFontSize).toBeLessThan(
        fitTextToBoundingBox(originalBounds, 'Short', 'Short').fittedFontSize,
      );
    });

    it('respects minimum font size floor for extreme text lengths', () => {
      const result = fitTextToBoundingBox(
        originalBounds,
        'Hi',
        'A'.repeat(500),
      );
      expect(result.fittedFontSize).toBeGreaterThanOrEqual(7);
    });
  });

  describe('Deterministic Background Reconstruction (Synthetic Image Processing)', () => {
    it('reconstructs a solid color background accurately', () => {
      const grid = new SyntheticPixelGrid(60, 40, { r: 240, g: 240, b: 240 });
      // Draw simulated black text pixels in the center
      for (let y = 15; y <= 25; y++) {
        for (let x = 20; x <= 40; x++) {
          grid.setPixel(x, y, { r: 10, g: 10, b: 10 });
        }
      }

      const targetBox = { x: 20, y: 15, width: 21, height: 11 };
      const analysis = reconstructGridRegion(grid, targetBox, 4);

      // Verify analysis estimated light background and dark text
      expect(analysis.estimatedBackgroundColor).toBe('#F0F0F0');
      expect(analysis.estimatedTextColor).toBe('#0A0A0A');

      // Verify pixels inside target box are reconstructed to ~240
      const centerPixel = grid.getPixel(30, 20);
      expect(centerPixel.r).toBeCloseTo(240, -1);
      expect(centerPixel.g).toBeCloseTo(240, -1);
      expect(centerPixel.b).toBeCloseTo(240, -1);
    });

    it('reconstructs a horizontal linear gradient smoothly across the target region', () => {
      const grid = new SyntheticPixelGrid(80, 40);
      // Fill with horizontal gradient: x = 0 (r=50) to x = 80 (r=210)
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 80; x++) {
          const val = Math.round(50 + (x / 80) * 160);
          grid.setPixel(x, y, { r: val, g: 100, b: 150 });
        }
      }

      // Corrupt/mask the target text box in center
      const targetBox = { x: 30, y: 15, width: 20, height: 10 };
      for (let y = 15; y < 25; y++) {
        for (let x = 30; x < 50; x++) {
          grid.setPixel(x, y, { r: 0, g: 0, b: 0 });
        }
      }

      const analysis = reconstructGridRegion(grid, targetBox, 4);
      expect(analysis.isGradient).toBe(true);

      // Check center of reconstructed box at x = 40 (should be ~ 50 + 0.5*160 = 130)
      const reconstructedCenter = grid.getPixel(40, 20);
      expect(reconstructedCenter.r).toBeGreaterThanOrEqual(120);
      expect(reconstructedCenter.r).toBeLessThanOrEqual(140);
      expect(reconstructedCenter.g).toBeCloseTo(100, -1);
      expect(reconstructedCenter.b).toBeCloseTo(150, -1);
    });
  });

  describe('Document History Manager (Undo / Redo)', () => {
    const createTestDoc = (title: string, text: string): Document => ({
      id: 'doc-1',
      metadata: {
        id: 'doc-1',
        title,
        kind: 'image',
        sourceUri: 'file:///test.png',
        pageCount: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
      pages: [
        {
          id: 'p-1',
          pageIndex: 0,
          dimensions: { width: 500, height: 500 },
          rotation: 0,
          originalContent: { pageIndex: 0, width: 500, height: 500 },
          editableTextRegions: [
            {
              id: 'reg-1',
              pageIndex: 0,
              bounds: { x: 10, y: 10, width: 100, height: 20 },
              originalText: 'Initial Text',
              currentText: text,
              status: text === 'Initial Text' ? 'detected' : 'modified',
              style: { fontSize: 16, color: '#000000' },
            },
          ],
          addedText: [],
        },
      ],
    });

    it('supports push, undo, and redo transitions without mutating state', () => {
      const history = new DocumentHistoryManager();
      const docV1 = createTestDoc('Doc', 'Initial Text');
      const docV2 = createTestDoc('Doc', 'Edited Text 1');
      const docV3 = createTestDoc('Doc', 'Edited Text 2');

      history.initialize(docV1);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);

      history.push(docV2);
      expect(history.canUndo).toBe(true);
      expect(history.canRedo).toBe(false);

      history.push(docV3);
      expect(history.canUndo).toBe(true);

      // Undo 1 step: returns docV2
      const undone = history.undo();
      expect(undone?.pages[0].editableTextRegions[0].currentText).toBe('Edited Text 1');
      expect(history.canUndo).toBe(true);
      expect(history.canRedo).toBe(true);

      // Redo 1 step: returns docV3
      const redone = history.redo();
      expect(redone?.pages[0].editableTextRegions[0].currentText).toBe('Edited Text 2');
      expect(history.canRedo).toBe(false);
    });

    it('clears future redo branch when a new state is pushed after undo', () => {
      const history = new DocumentHistoryManager();
      const docV1 = createTestDoc('Doc', 'V1');
      const docV2 = createTestDoc('Doc', 'V2');
      const docBranch = createTestDoc('Doc', 'V2-Branch');

      history.initialize(docV1);
      history.push(docV2);
      history.undo();
      expect(history.canRedo).toBe(true);

      history.push(docBranch);
      expect(history.canRedo).toBe(false);
      expect(history.currentState?.pages[0].editableTextRegions[0].currentText).toBe('V2-Branch');
    });
  });

  describe('Reconstruction Input Validation', () => {
    it('rejects empty image URI with typed error', async () => {
      const engine = new LocalBackgroundReconstructionEngine();
      await expect(
        engine.reconstructBackground('', { x: 10, y: 10, width: 50, height: 20 }),
      ).rejects.toThrow('Image URI is required');
    });

    it('rejects zero or negative bounds with typed error', async () => {
      const engine = new LocalBackgroundReconstructionEngine();
      await expect(
        engine.reconstructBackground('file:///test.png', { x: 10, y: 10, width: 0, height: 20 }),
      ).rejects.toThrow('Invalid bounding box dimensions');
    });
  });
});
