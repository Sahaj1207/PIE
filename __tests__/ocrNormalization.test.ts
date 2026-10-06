import {
  normalizeBoundingBox,
  normalizeVisionBoundingBox,
  normalizeRawNativeOcrResult,
  ocrResultToTextRegions,
} from '../src/features/ocr/normalization';
import { DocumentSize } from '../src/types/geometry';
import { RawNativeOcrResult } from '../src/features/ocr/types';

describe('OCR Coordinate Normalization', () => {
  const imageSize: DocumentSize = { width: 1000, height: 2000 };

  describe('normalizeBoundingBox (Pixel / ML Kit Space)', () => {
    test('keeps standard bounding box inside image bounds', () => {
      const box = { x: 50, y: 100, width: 200, height: 40 };
      const normalized = normalizeBoundingBox(box, imageSize);
      expect(normalized).toEqual({
        x: 50,
        y: 100,
        width: 200,
        height: 40,
      });
    });

    test('clamps negative coordinates to 0', () => {
      const box = { x: -20, y: -10, width: 100, height: 50 };
      const normalized = normalizeBoundingBox(box, imageSize);
      expect(normalized.x).toBe(0);
      expect(normalized.y).toBe(0);
      expect(normalized.width).toBe(100);
      expect(normalized.height).toBe(50);
    });

    test('clamps bounding box that extends beyond image dimensions', () => {
      const box = { x: 900, y: 1950, width: 250, height: 100 };
      const normalized = normalizeBoundingBox(box, imageSize);
      expect(normalized.x).toBe(900);
      expect(normalized.y).toBe(1950);
      expect(normalized.width).toBe(100); // 1000 - 900
      expect(normalized.height).toBe(50); // 2000 - 1950
    });

    test('handles undefined bounding box gracefully', () => {
      const normalized = normalizeBoundingBox(undefined, imageSize);
      expect(normalized).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });
  });

  describe('normalizeVisionBoundingBox (Apple Vision Space)', () => {
    test('inverts Y-axis from Vision bottom-left to Document top-left', () => {
      // Box at top of image in Vision (y=0.8, height=0.2 => y reaches 1.0)
      const visionBox = { x: 0.1, y: 0.8, width: 0.5, height: 0.2 };
      const docBox = normalizeVisionBoundingBox(visionBox, imageSize);

      expect(docBox.x).toBe(100); // 0.1 * 1000
      expect(docBox.width).toBe(500); // 0.5 * 1000
      expect(docBox.height).toBe(400); // 0.2 * 2000
      // Inverted Y: 1.0 - (0.8 + 0.2) = 0.0 => 0 px from top!
      expect(docBox.y).toBe(0);
    });

    test('converts Vision box at bottom of image to bottom in Document space', () => {
      // Box at bottom of image in Vision (y=0.0, height=0.1)
      const visionBox = { x: 0.2, y: 0.0, width: 0.3, height: 0.1 };
      const docBox = normalizeVisionBoundingBox(visionBox, imageSize);

      expect(docBox.x).toBe(200); // 0.2 * 1000
      expect(docBox.width).toBe(300); // 0.3 * 1000
      expect(docBox.height).toBe(200); // 0.1 * 2000
      // Inverted Y: 1.0 - (0.0 + 0.1) = 0.9 => 0.9 * 2000 = 1800 px from top
      expect(docBox.y).toBe(1800);
    });
  });

  describe('normalizeRawNativeOcrResult', () => {
    test('transforms raw ML Kit result into structured OcrResult', () => {
      const raw: RawNativeOcrResult = {
        fullText: 'Invoice #1001\nTotal: $500',
        imageWidth: 800,
        imageHeight: 1200,
        blocks: [
          {
            text: 'Invoice #1001',
            boundingBox: { x: 50, y: 50, width: 250, height: 35 },
            lines: [
              {
                text: 'Invoice #1001',
                confidence: 0.98,
                boundingBox: { x: 50, y: 50, width: 250, height: 35 },
                words: [
                  {
                    text: 'Invoice',
                    confidence: 0.99,
                    boundingBox: { x: 50, y: 50, width: 120, height: 35 },
                  },
                  {
                    text: '#1001',
                    confidence: 0.97,
                    boundingBox: { x: 180, y: 50, width: 120, height: 35 },
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = normalizeRawNativeOcrResult(raw);

      expect(result.fullText).toBe('Invoice #1001\nTotal: $500');
      expect(result.imageDimensions).toEqual({ width: 800, height: 1200 });
      expect(result.blocks.length).toBe(1);
      expect(result.blocks[0].lines.length).toBe(1);
      expect(result.blocks[0].lines[0].words.length).toBe(2);
      expect(result.blocks[0].lines[0].confidence).toBe(0.98);
      expect(result.blocks[0].lines[0].bounds.width).toBe(250);
    });

    test('handles empty or malformed raw OCR payload safely', () => {
      const emptyRaw = {} as unknown as RawNativeOcrResult;
      const result = normalizeRawNativeOcrResult(emptyRaw);

      expect(result.fullText).toBe('');
      expect(result.imageDimensions.width).toBe(1);
      expect(result.imageDimensions.height).toBe(1);
      expect(result.blocks).toEqual([]);
    });
  });

  describe('ocrResultToTextRegions', () => {
    test('creates TextRegions from OcrResult with document bounds and styling', () => {
      const ocrResult = normalizeRawNativeOcrResult({
        fullText: 'Hello World',
        imageWidth: 600,
        imageHeight: 800,
        blocks: [
          {
            text: 'Hello World',
            boundingBox: { x: 10, y: 20, width: 200, height: 30 },
            lines: [
              {
                text: 'Hello World',
                confidence: 0.95,
                boundingBox: { x: 10, y: 20, width: 200, height: 30 },
                words: [],
              },
            ],
          },
        ],
      });

      const regions = ocrResultToTextRegions(ocrResult, 0);

      expect(regions.length).toBe(1);
      expect(regions[0].pageIndex).toBe(0);
      expect(regions[0].originalText).toBe('Hello World');
      expect(regions[0].currentText).toBe('Hello World');
      expect(regions[0].status).toBe('detected');
      expect(regions[0].confidence).toBe(0.95);
      expect(regions[0].bounds).toEqual({ x: 10, y: 20, width: 200, height: 30 });
      // Capitals, no descenders: 30 / (0.72 + 0.01) (was 0.75 x height, which drew replacements
      // ~23% too small on device)
      expect(regions[0].style.fontSize).toBe(41);
    });

    test('filters out blank whitespace lines', () => {
      const ocrResult = normalizeRawNativeOcrResult({
        fullText: '   ',
        imageWidth: 600,
        imageHeight: 800,
        blocks: [
          {
            text: '   ',
            lines: [
              {
                text: '   ',
                boundingBox: { x: 0, y: 0, width: 10, height: 10 },
              },
            ],
          },
        ],
      });

      const regions = ocrResultToTextRegions(ocrResult, 0);
      expect(regions.length).toBe(0);
    });
  });
});
