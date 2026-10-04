import { DocumentRect, DocumentSize } from '../../types/geometry';
import { TextRegion } from '../../types/document';
import {
  OcrBlock,
  OcrDocument,
  OcrElement,
  OcrLine,
  OcrResult,
  RawBoundingBox,
  RawNativeOcrResult,
} from './types';

/**
 * Validates that an OCR bounding box satisfies canonical coordinate constraints:
 * - x >= 0, y >= 0
 * - width > 0, height > 0
 * - stays within image dimensions (allowing small floating-point tolerance)
 */
export function validateOcrBounds(
  bounds: DocumentRect,
  imageDimensions: DocumentSize,
  tolerance = 0.5,
): boolean {
  if (
    !bounds ||
    isNaN(bounds.x) ||
    isNaN(bounds.y) ||
    isNaN(bounds.width) ||
    isNaN(bounds.height)
  ) {
    return false;
  }

  if (bounds.x < -tolerance || bounds.y < -tolerance) {
    return false;
  }

  if (bounds.width <= 0 || bounds.height <= 0) {
    return false;
  }

  if (
    bounds.x + bounds.width > imageDimensions.width + tolerance ||
    bounds.y + bounds.height > imageDimensions.height + tolerance
  ) {
    return false;
  }

  return true;
}

/**
 * Normalizes and clamps a raw bounding box into canonical top-left document coordinate space.
 */
export function normalizeBoundingBox(
  box: RawBoundingBox | undefined,
  imageDimensions: DocumentSize,
): DocumentRect {
  if (!box || isNaN(box.x) || isNaN(box.y) || isNaN(box.width) || isNaN(box.height)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // Ensure non-negative dimensions
  const width = Math.max(0, box.width);
  const height = Math.max(0, box.height);

  // Clamp within image bounds
  const x = Math.max(0, Math.min(box.x, imageDimensions.width));
  const y = Math.max(0, Math.min(box.y, imageDimensions.height));

  const clampedWidth = Math.min(width, Math.max(0, imageDimensions.width - x));
  const clampedHeight = Math.min(height, Math.max(0, imageDimensions.height - y));

  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    width: Math.round(clampedWidth * 100) / 100,
    height: Math.round(clampedHeight * 100) / 100,
  };
}

/**
 * Normalizes Apple Vision normalized bottom-left coordinates into top-left document pixel space.
 *
 * Vision conventions:
 * - Origin (0,0) is bottom-left
 * - Values are normalized [0.0, 1.0]
 */
export function normalizeVisionBoundingBox(
  normalizedBox: RawBoundingBox,
  imageDimensions: DocumentSize,
): DocumentRect {
  if (!normalizedBox) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const pixelWidth = Math.max(0, normalizedBox.width * imageDimensions.width);
  const pixelHeight = Math.max(0, normalizedBox.height * imageDimensions.height);
  const pixelX = Math.max(0, normalizedBox.x * imageDimensions.width);
  // Invert Y axis: Vision Y=0 is bottom, Document Y=0 is top
  const pixelY = Math.max(
    0,
    (1.0 - normalizedBox.y - normalizedBox.height) * imageDimensions.height,
  );

  return normalizeBoundingBox(
    {
      x: pixelX,
      y: pixelY,
      width: pixelWidth,
      height: pixelHeight,
    },
    imageDimensions,
  );
}

/**
 * Converts raw native OCR payload into canonical OcrDocument with deterministic, scoped IDs.
 */
export function normalizeToOcrDocument(
  raw: RawNativeOcrResult,
  documentId: string,
): OcrDocument {
  const imageWidth = Math.max(1, raw.imageWidth || 1);
  const imageHeight = Math.max(1, raw.imageHeight || 1);
  const imageDimensions: DocumentSize = { width: imageWidth, height: imageHeight };

  const blocks: OcrBlock[] = (raw.blocks || []).map((rawBlock, blockIdx) => {
    const blockId = `ocr-${documentId}-b${blockIdx}`;
    const blockBounds = normalizeBoundingBox(rawBlock.boundingBox, imageDimensions);

    const lines: OcrLine[] = (rawBlock.lines || []).map((rawLine, lineIdx) => {
      const lineId = `${blockId}-l${lineIdx}`;
      const lineBounds = normalizeBoundingBox(rawLine.boundingBox, imageDimensions);

      const elements: OcrElement[] = (rawLine.words || []).map((rawWord, elemIdx) => {
        const elementId = `${lineId}-e${elemIdx}`;
        return {
          id: elementId,
          text: rawWord.text || '',
          confidence: rawWord.confidence,
          bounds: normalizeBoundingBox(rawWord.boundingBox, imageDimensions),
          blockId,
          lineId,
          index: elemIdx,
        };
      });

      return {
        id: lineId,
        text: rawLine.text || '',
        confidence: rawLine.confidence,
        bounds: lineBounds,
        blockId,
        elements,
        words: elements,
      };
    });

    return {
      id: blockId,
      text: rawBlock.text || '',
      bounds: blockBounds,
      lines,
    };
  });

  return {
    documentId,
    imageWidth,
    imageHeight,
    fullText: raw.fullText || '',
    blocks,
    recognizedAt: Date.now(),
  };
}

/**
 * Converts raw native OCR payload into standardized domain OcrResult (backwards-compatible).
 */
export function normalizeRawNativeOcrResult(
  raw: RawNativeOcrResult,
  documentId = 'doc',
): OcrResult {
  const ocrDoc = normalizeToOcrDocument(raw, documentId);

  return {
    fullText: ocrDoc.fullText,
    imageDimensions: {
      width: ocrDoc.imageWidth,
      height: ocrDoc.imageHeight,
    },
    blocks: ocrDoc.blocks,
    processedAt: ocrDoc.recognizedAt,
  };
}

/**
 * Transforms an OcrResult or OcrDocument into editable TextRegion[] elements for the Document model.
 */
export function ocrResultToTextRegions(
  ocrResult: OcrResult | OcrDocument,
  pageIndex = 0,
): TextRegion[] {
  const regions: TextRegion[] = [];
  let regionCounter = 1;

  for (const block of ocrResult.blocks) {
    for (const line of block.lines) {
      if (!line.text.trim()) continue;

      // Approximate font size from line bounding box height
      const estimatedFontSize = Math.max(8, Math.round(line.bounds.height * 0.75));

      regions.push({
        id: `text-region-${pageIndex}-${regionCounter++}`,
        pageIndex,
        bounds: line.bounds,
        originalText: line.text,
        currentText: line.text,
        status: 'detected',
        style: {
          fontSize: estimatedFontSize,
          color: '#000000',
          fontWeight: 'normal',
        },
        confidence: line.confidence,
      });
    }
  }

  return regions;
}
