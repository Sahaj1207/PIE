/**
 * Deterministic, on-device OCR input preparation (no network, no generative processing).
 *
 * The native recognizer decodes the working image itself (applying EXIF orientation so
 * coordinates are upright), flattens transparency onto a contrasting opaque background and
 * resamples by the scale planned here. Recognized boxes are mapped back to the original
 * (upright, full-resolution) pixel grid, i.e. document coordinates.
 *
 * Why:
 * - Very large images (>16 MP) are decoded at full size by ML Kit's file loader and can
 *   fail with out-of-memory; they are downscaled to a bounded pixel budget.
 * - Small images (long side < 1280 px) often carry text smaller than the recognizer's
 *   minimum glyph size; upscaling (max 3x) recovers it.
 * - Transparent PNG/WebP (logos, screenshots with alpha) decode with black transparent
 *   pixels, so dark text on a transparent background becomes invisible to OCR.
 */
import { DocumentRect, DocumentSize } from '../../types/geometry';
import { TextRegion } from '../../types/document';

export const OCR_MAX_PIXELS = 16_000_000;
export const OCR_SMALL_IMAGE_LONG_SIDE = 1280;
export const OCR_UPSCALE_TARGET_LONG_SIDE = 1920;
export const OCR_MAX_UPSCALE = 3;
/** Upscaling below this factor is not worth the extra work. */
export const OCR_MIN_USEFUL_UPSCALE = 1.2;

export type OcrResampleReason = 'none' | 'upscale' | 'downscale';

export interface OcrInputPlan {
  /** Resampling factor applied before recognition (1 = unchanged). */
  readonly scale: number;
  readonly reason: OcrResampleReason;
}

function floor3(v: number): number {
  return Math.floor(v * 1000) / 1000;
}

/** Plans OCR resampling for an upright image of the given pixel size. */
export function planOcrInput(width: number, height: number): OcrInputPlan {
  if (!(width > 0) || !(height > 0)) return { scale: 1, reason: 'none' };
  const pixels = width * height;
  if (pixels > OCR_MAX_PIXELS) {
    return { scale: floor3(Math.sqrt(OCR_MAX_PIXELS / pixels)), reason: 'downscale' };
  }
  const longSide = Math.max(width, height);
  if (longSide < OCR_SMALL_IMAGE_LONG_SIDE) {
    const byTarget = OCR_UPSCALE_TARGET_LONG_SIDE / longSide;
    const byBudget = Math.sqrt(OCR_MAX_PIXELS / pixels);
    const scale = floor3(Math.min(OCR_MAX_UPSCALE, byTarget, byBudget));
    if (scale >= OCR_MIN_USEFUL_UPSCALE) return { scale, reason: 'upscale' };
  }
  return { scale: 1, reason: 'none' };
}

/** Options passed to the native recognizer (OcrNativeModule.recognizeTextWithOptions). */
export interface NativeOcrOptions {
  readonly scale: number;
  readonly flattenAlpha: boolean;
}

export function nativeOcrOptions(width: number, height: number): NativeOcrOptions {
  return { scale: planOcrInput(width, height).scale, flattenAlpha: true };
}

function scaleRect(rect: DocumentRect, sx: number, sy: number, doc: DocumentSize): DocumentRect {
  const x = Math.max(0, Math.min(doc.width, rect.x * sx));
  const y = Math.max(0, Math.min(doc.height, rect.y * sy));
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    width: Math.round(Math.min(rect.width * sx, doc.width - x) * 100) / 100,
    height: Math.round(Math.min(rect.height * sy, doc.height - y) * 100) / 100,
  };
}

/**
 * Safety net for coordinate spaces: when the OCR result's pixel grid differs from the
 * document's (e.g. legacy documents whose asset is not the upright working copy), regions are
 * rescaled into document coordinates. Identical sizes return the input unchanged.
 */
export function alignRegionsToDocument(
  regions: readonly TextRegion[],
  ocrSize: DocumentSize,
  documentSize: DocumentSize,
): TextRegion[] {
  if (!(ocrSize.width > 0) || !(ocrSize.height > 0) || !(documentSize.width > 0) || !(documentSize.height > 0)) {
    return [...regions];
  }
  const sx = documentSize.width / ocrSize.width;
  const sy = documentSize.height / ocrSize.height;
  if (Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return [...regions];
  return regions
    .map((r) => ({
      ...r,
      bounds: scaleRect(r.bounds, sx, sy, documentSize),
      style: { ...r.style, fontSize: Math.max(8, Math.round(r.style.fontSize * sy)) },
    }))
    .filter((r) => r.bounds.width > 0 && r.bounds.height > 0);
}
