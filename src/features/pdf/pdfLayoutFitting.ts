import { PdfRect, PdfTextObject, PdfTextFormatOptions, PdfTextFittingState } from './types';

export type { PdfTextFittingState };

export interface PdfTextFitResult {
  readonly fittedFontSize: number;
  readonly scaleFactor: number;
  readonly estimatedWidth: number;
  readonly isOverflowing: boolean;
  readonly strategy: 'PRESERVED' | 'SCALED_DOWN';
  readonly state: PdfTextFittingState;
  readonly notes: string;
}

export const MINIMUM_SAFE_FONT_SIZE = 8; // points

/**
 * Conservative layout fitting strategy for PDF vector text replacement.
 *
 * Requirements:
 * 1. Preserve original font size where possible when replacement text fits.
 * 2. When replacement is significantly longer, apply a conservative scale factor (down to 70%)
 *    to minimize horizontal overflow into neighboring elements.
 * 3. Enforce a minimum safe font size (floor of 8pt) to prevent illegible microprint.
 * 4. Explicitly distinguish fitting states: PRESERVED, SCALED_DOWN, UNSUPPORTED, OVERFLOW.
 */
export function calculatePdfTextFit(
  originalBounds: PdfRect,
  originalText: string,
  newText: string,
  originalFontSize: number,
  options?: { minimumFontSize?: number; conservativeFloor?: number },
): PdfTextFitResult {
  if (!isFinite(originalFontSize) || originalFontSize <= 0) {
    return {
      fittedFontSize: Math.max(1, originalFontSize || 12),
      scaleFactor: 1.0,
      estimatedWidth: 0,
      isOverflowing: false,
      strategy: 'PRESERVED',
      state: 'UNSUPPORTED',
      notes: 'Invalid or unsupported font size for layout calculation.',
    };
  }

  const origLen = Math.max(1, (originalText || '').trim().length);
  const newLen = Math.max(1, (newText || '').trim().length);
  const charRatio = newLen / origLen;
  const minSize = options?.minimumFontSize ?? MINIMUM_SAFE_FONT_SIZE;
  const floorScale = options?.conservativeFloor ?? 0.70;

  if (charRatio <= 1.15) {
    const charWidth = originalFontSize * 0.52;
    return {
      fittedFontSize: originalFontSize,
      scaleFactor: 1.0,
      estimatedWidth: newLen * charWidth,
      isOverflowing: false,
      strategy: 'PRESERVED',
      state: 'PRESERVED',
      notes: 'Replacement text fits within the original bounding box; original font size preserved.',
    };
  }

  // Significantly longer text: apply conservative scaling
  const rawScale = 1.0 / charRatio;
  const clampedScale = Math.max(floorScale, Math.round(rawScale * 100) / 100);
  const fittedFontSize = Math.max(minSize, Math.round(originalFontSize * clampedScale * 10) / 10);
  const charWidth = fittedFontSize * 0.52;
  const estimatedWidth = newLen * charWidth;
  const isOverflowing = estimatedWidth > originalBounds.width * 1.2;

  const state: PdfTextFittingState = isOverflowing ? 'OVERFLOW' : 'SCALED_DOWN';

  return {
    fittedFontSize,
    scaleFactor: clampedScale,
    estimatedWidth,
    isOverflowing,
    strategy: 'SCALED_DOWN',
    state,
    notes: isOverflowing
      ? 'Replacement text is significantly longer than original. Font size conservatively scaled down to 70% to prevent excessive overlap.'
      : 'Replacement text scaled down proportionally to fit the original bounding box.',
  };
}

export interface PdfFormattingReconciliationResult {
  readonly matches: boolean;
  readonly fontSizeMatches: boolean;
  readonly colorMatches: boolean;
  readonly differences: readonly string[];
}

export function reconcilePdfTextFormatting(
  requested: PdfTextFormatOptions,
  reopenedObj: PdfTextObject,
  tolerances = { fontSize: 0.5, colorComponent: 2, matrix: 0.01 },
): PdfFormattingReconciliationResult {
  const diffs: string[] = [];
  let fontSizeMatches = true;
  let colorMatches = true;

  if (requested.fontSize !== undefined && requested.fontSize > 0) {
    const actualSize = reopenedObj.fontSize ?? 0;
    if (Math.abs(actualSize - requested.fontSize) > tolerances.fontSize) {
      fontSizeMatches = false;
      diffs.push(
        `Font size mismatch: expected ${requested.fontSize}pt, got ${actualSize}pt (tolerance ${tolerances.fontSize}pt)`,
      );
    }
  }

  if (requested.color) {
    const normalizeHex = (hex: string) => {
      let h = hex.trim().replace(/^#/, '');
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      if (h.length === 8) h = h.slice(0, 6);
      return h.toUpperCase();
    };

    const expHex = normalizeHex(requested.color);
    const actHex = normalizeHex(reopenedObj.color || '#000000');
    if (expHex !== actHex) {
      const expR = parseInt(expHex.substring(0, 2), 16) || 0;
      const expG = parseInt(expHex.substring(2, 4), 16) || 0;
      const expB = parseInt(expHex.substring(4, 6), 16) || 0;

      const actR = parseInt(actHex.substring(0, 2), 16) || 0;
      const actG = parseInt(actHex.substring(2, 4), 16) || 0;
      const actB = parseInt(actHex.substring(4, 6), 16) || 0;

      if (
        Math.abs(expR - actR) > tolerances.colorComponent ||
        Math.abs(expG - actG) > tolerances.colorComponent ||
        Math.abs(expB - actB) > tolerances.colorComponent
      ) {
        colorMatches = false;
        diffs.push(`Color mismatch: expected #${expHex}, got #${actHex}`);
      }
    }
  }

  return {
    matches: fontSizeMatches && colorMatches,
    fontSizeMatches,
    colorMatches,
    differences: diffs,
  };
}
