import { DocumentRect } from '../../types/geometry';
import { TextStyleSpec } from '../../types/document';
import { TextFitAnalysis, TextFitState } from '../image/types';

export interface TextFitResult {
  readonly fittedFontSize: number;
  readonly fittedBounds: DocumentRect;
  readonly baselineY: number;
  readonly scaleFactor: number;
}

export const MIN_READABLE_FONT_SIZE = 7;
export const DEFAULT_NATURAL_FONT_RATIO = 0.78;
export const AVERAGE_CHAR_ASPECT_RATIO = 0.52;
export const MAX_SAFE_WIDTH_EXPANSION_RATIO = 1.25;

/**
 * Deterministically fits replacement text within the original OCR bounding box.
 * Preserves backward compatibility with Phase 7 & 8 calls.
 */
export function fitTextToBoundingBox(
  bounds: DocumentRect,
  originalText: string,
  newText: string,
  style?: Partial<TextStyleSpec>,
): TextFitResult {
  const analysis = analyzeTextFitting(bounds, originalText, newText, style);
  return {
    fittedFontSize: analysis.fittedFontSize,
    fittedBounds: analysis.fittedBounds,
    baselineY: analysis.baselineY,
    scaleFactor: analysis.scaleFactor,
  };
}

/**
 * Deterministically analyzes how replacement text fits the original OCR bounding box.
 * Evaluates the 5 mandatory states:
 * - PRESERVED: fits comfortably at original/estimated font size
 * - SCALED_DOWN: scaled down to fit within bounds while remaining >= MIN_READABLE_FONT_SIZE
 * - EXPANDED_WITHIN_SAFE_BOUNDS: slightly widened within safe bounds to retain readability
 * - OVERFLOW: text cannot fit even with scaling and safe expansion
 * - UNSUPPORTED: invalid bounds or non-renderable dimensions
 */
export function analyzeTextFitting(
  bounds: DocumentRect,
  originalText: string,
  replacementText: string,
  style?: Partial<TextStyleSpec>,
  maxExpansionRatio: number = MAX_SAFE_WIDTH_EXPANSION_RATIO,
): TextFitAnalysis {
  // Check for unsupported / degenerate bounds
  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    isNaN(bounds.width) ||
    isNaN(bounds.height)
  ) {
    return {
      state: 'UNSUPPORTED',
      fittedFontSize: 0,
      fittedBounds: bounds || { x: 0, y: 0, width: 0, height: 0 },
      baselineY: bounds ? bounds.y : 0,
      scaleFactor: 0,
      isOverflow: true,
    };
  }

  const naturalFontSize = Math.max(
    MIN_READABLE_FONT_SIZE,
    style?.fontSize || Math.round(bounds.height * DEFAULT_NATURAL_FONT_RATIO),
  );

  const cleanOriginal = (originalText || '').trim();
  const cleanReplacement = (replacementText || '').trim();

  // If replacement is empty (e.g. deletion preview), it fits safely
  if (cleanReplacement.length === 0) {
    const baselineOffset = Math.round(bounds.height * 0.76);
    return {
      state: 'PRESERVED',
      fittedFontSize: naturalFontSize,
      fittedBounds: bounds,
      baselineY: bounds.y + baselineOffset,
      scaleFactor: 1.0,
      isOverflow: false,
    };
  }

  const origLen = Math.max(1, cleanOriginal.length);
  const newLen = cleanReplacement.length;

  // Estimated width required at 100% natural size
  const estimatedCharWidth = naturalFontSize * AVERAGE_CHAR_ASPECT_RATIO;
  const neededWidthNatural = newLen * estimatedCharWidth;

  let state: TextFitState = 'PRESERVED';
  let scaleFactor = 1.0;
  let fittedFontSize = naturalFontSize;
  let fittedBounds: DocumentRect = { ...bounds };
  let isOverflow = false;

  if (neededWidthNatural <= bounds.width || newLen <= origLen) {
    // Replacement fits within the original bounding box at natural font size
    state = 'PRESERVED';
    scaleFactor = 1.0;
    fittedFontSize = naturalFontSize;
  } else {
    // Replacement needs scaling
    const neededScale = bounds.width / neededWidthNatural;
    const scaledFontSize = Math.round(naturalFontSize * neededScale);

    if (scaledFontSize >= MIN_READABLE_FONT_SIZE) {
      // Scale down fits comfortably above minimum readable size
      state = 'SCALED_DOWN';
      scaleFactor = neededScale;
      fittedFontSize = scaledFontSize;
    } else {
      // Would be smaller than minimum readable size; check if expanding width within safe bounds works
      const expandedWidth = bounds.width * maxExpansionRatio;
      const scaleWithExpansion = expandedWidth / neededWidthNatural;
      const fontSizeWithExpansion = Math.round(naturalFontSize * scaleWithExpansion);

      if (fontSizeWithExpansion >= MIN_READABLE_FONT_SIZE) {
        state = 'EXPANDED_WITHIN_SAFE_BOUNDS';
        scaleFactor = scaleWithExpansion;
        fittedFontSize = fontSizeWithExpansion;
        fittedBounds = {
          ...bounds,
          width: Math.round(neededWidthNatural * (fontSizeWithExpansion / naturalFontSize)),
        };
      } else {
        // Even with max safe expansion, text would be illegible or overflow
        state = 'OVERFLOW';
        scaleFactor = MIN_READABLE_FONT_SIZE / naturalFontSize;
        fittedFontSize = MIN_READABLE_FONT_SIZE;
        isOverflow = true;
      }
    }
  }

  // Calculate typographic baseline Y within the bounding box
  const baselineOffset = Math.round(bounds.height * 0.76);
  const baselineY = bounds.y + baselineOffset;

  return {
    state,
    fittedFontSize,
    fittedBounds,
    baselineY,
    scaleFactor,
    isOverflow,
  };
}

export interface EstimateStyleOptions {
  ocrConfidence?: number;
  colorSample?: string;
  alignment?: 'left' | 'center' | 'right';
  fontWeight?: 'normal' | 'bold';
}

/**
 * Estimates typography styling deterministically from OCR bounding box and local hints.
 */
export function estimateTextStyle(
  bounds: DocumentRect,
  options?: EstimateStyleOptions,
): TextStyleSpec {
  const naturalFontSize = Math.max(
    8,
    Math.round(bounds.height * DEFAULT_NATURAL_FONT_RATIO),
  );

  return {
    fontFamily: resolveSystemFontFamily(),
    fontSize: naturalFontSize,
    color: options?.colorSample || '#111827',
    fontWeight: options?.fontWeight || 'normal',
    fontStyle: 'normal',
  };
}

/**
 * Resolves safe system local font family.
 * STRICT REQUIREMENT: No network requests, no remote font downloads.
 */
export function resolveSystemFontFamily(preferred?: string): string {
  if (!preferred) return 'sans-serif';
  const clean = preferred.toLowerCase().trim();
  if (clean.includes('serif') && !clean.includes('sans')) {
    return 'serif';
  }
  if (clean.includes('mono') || clean.includes('code')) {
    return 'monospace';
  }
  return 'sans-serif';
}
