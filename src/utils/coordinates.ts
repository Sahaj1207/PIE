export type {
  DocumentViewportLayout,
  ViewportTransform,
  ViewportOrigin,
  ViewportPoint,
  ViewportRect,
} from '../types/geometry';
import {
  DocumentPoint,
  DocumentRect,
  DocumentViewportLayout,
  ScreenPoint,
  ScreenRect,
  ViewportOrigin,
  ViewportPoint,
  ViewportRect,
  ViewportTransform,
} from '../types/geometry';

/** Authoritative scale constraints across PDF & Image Viewports */
export const MIN_VIEWPORT_SCALE = 0.5;
export const MAX_VIEWPORT_SCALE = 4.0;
export const DEFAULT_VIEWPORT_SCALE = 1.0;

/** Default identity layout (used for 1:1 image canvas where document matches canvas) */
export const DEFAULT_DOCUMENT_LAYOUT: DocumentViewportLayout = {
  baseScale: 1.0,
  originX: 0,
  originY: 0,
};

/**
 * Clamps a numeric value between a minimum and maximum.
 */
export function clamp(val: number, min: number, max: number): number {
  if (isNaN(val)) return min;
  return Math.min(Math.max(val, min), max);
}

/**
 * Validates and clamps a scale factor strictly to [minScale, maxScale] (default 0.5 to 4.0).
 * Prevents NaN, infinite, or zero/negative scales.
 */
export function clampScale(
  scale: number,
  minScale = MIN_VIEWPORT_SCALE,
  maxScale = MAX_VIEWPORT_SCALE,
): number {
  if (!isFinite(scale) || scale <= 0) {
    return DEFAULT_VIEWPORT_SCALE;
  }
  return Math.min(Math.max(scale, minScale), maxScale);
}

/**
 * Enforces valid finite values across all transform components.
 */
export function sanitizeViewportTransform(
  transform: ViewportTransform,
  minScale = MIN_VIEWPORT_SCALE,
  maxScale = MAX_VIEWPORT_SCALE,
): ViewportTransform {
  const safeScale = clampScale(transform.scale, minScale, maxScale);
  const safeTx = isFinite(transform.translateX) ? transform.translateX : 0;
  const safeTy = isFinite(transform.translateY) ? transform.translateY : 0;
  return {
    scale: Math.round(safeScale * 1000) / 1000,
    translateX: Math.round(safeTx),
    translateY: Math.round(safeTy),
  };
}

/**
 * Calculates new transform (scale and focal translation) preserving the point under fingers.
 */
export function calculateFocalZoom(params: {
  readonly currentScale: number;
  readonly targetScale: number;
  readonly focalX: number;
  readonly focalY: number;
  readonly currentTx: number;
  readonly currentTy: number;
  readonly minScale?: number;
  readonly maxScale?: number;
}): { scale: number; translateX: number; translateY: number } {
  const minScale = params.minScale ?? MIN_VIEWPORT_SCALE;
  const maxScale = params.maxScale ?? MAX_VIEWPORT_SCALE;

  const validCurrentScale = clampScale(params.currentScale, minScale, maxScale);
  const nextScale = clampScale(params.targetScale, minScale, maxScale);
  const scaleRatio = nextScale / validCurrentScale;

  const newTx = params.focalX - (params.focalX - params.currentTx) * scaleRatio;
  const newTy = params.focalY - (params.focalY - params.currentTy) * scaleRatio;

  return {
    scale: nextScale,
    translateX: isFinite(newTx) ? newTx : params.currentTx,
    translateY: isFinite(newTy) ? newTy : params.currentTy,
  };
}

// =============================================================================
// COORDINATE SPACE CONVERSIONS
// Space A: Screen (Device physical touch coordinates)
// Space B: Viewport (Inside editor container after insets)
// Space C: Document (PDF pt coordinates or intrinsic image pixel coordinates)
// =============================================================================

/**
 * Screen Space -> Viewport Space
 */
export function screenToViewport(
  point: ScreenPoint,
  origin: ViewportOrigin,
): ViewportPoint {
  return {
    x: point.x - origin.x,
    y: point.y - origin.y,
  };
}

/**
 * Viewport Space -> Screen Space
 */
export function viewportToScreen(
  point: ViewportPoint,
  origin: ViewportOrigin,
): ScreenPoint {
  return {
    x: point.x + origin.x,
    y: point.y + origin.y,
  };
}

/**
 * Viewport Space -> Document Space
 * Document = (Viewport - origin - translation) / (scale * baseScale)
 */
export function viewportToDocument(
  point: ViewportPoint,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): DocumentPoint {
  const safeScale = clampScale(transform.scale);
  const safeBaseScale = layout.baseScale > 0 && isFinite(layout.baseScale) ? layout.baseScale : 1.0;
  const divisor = safeScale * safeBaseScale;

  const origX = isFinite(layout.originX) ? layout.originX : 0;
  const origY = isFinite(layout.originY) ? layout.originY : 0;
  const tx = isFinite(transform.translateX) ? transform.translateX : 0;
  const ty = isFinite(transform.translateY) ? transform.translateY : 0;

  return {
    x: (point.x - origX - tx) / divisor,
    y: (point.y - origY - ty) / divisor,
  };
}

/**
 * Document Space -> Viewport Space
 * Viewport = origin + translation + Document * baseScale * scale
 */
export function documentToViewport(
  point: DocumentPoint,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): ViewportPoint {
  const safeScale = clampScale(transform.scale);
  const safeBaseScale = layout.baseScale > 0 && isFinite(layout.baseScale) ? layout.baseScale : 1.0;
  const multiplier = safeScale * safeBaseScale;

  const origX = isFinite(layout.originX) ? layout.originX : 0;
  const origY = isFinite(layout.originY) ? layout.originY : 0;
  const tx = isFinite(transform.translateX) ? transform.translateX : 0;
  const ty = isFinite(transform.translateY) ? transform.translateY : 0;

  return {
    x: origX + tx + point.x * multiplier,
    y: origY + ty + point.y * multiplier,
  };
}

/**
 * Full Pipeline: Screen Space -> Viewport Space -> Document Space
 */
export function screenToDocument(
  point: ScreenPoint,
  origin: ViewportOrigin,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): DocumentPoint {
  const vpPoint = screenToViewport(point, origin);
  return viewportToDocument(vpPoint, transform, layout);
}

/**
 * Full Pipeline: Document Space -> Viewport Space -> Screen Space
 */
export function documentToScreen(
  point: DocumentPoint,
  origin: ViewportOrigin,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): ScreenPoint {
  const vpPoint = documentToViewport(point, transform, layout);
  return viewportToScreen(vpPoint, origin);
}

// =============================================================================
// RECTANGLE TRANSFORMATIONS
// =============================================================================

export function viewportToDocumentRect(
  rect: ViewportRect,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): DocumentRect {
  const topLeft = viewportToDocument({ x: rect.x, y: rect.y }, transform, layout);
  const safeScale = clampScale(transform.scale);
  const safeBaseScale = layout.baseScale > 0 && isFinite(layout.baseScale) ? layout.baseScale : 1.0;
  const divisor = safeScale * safeBaseScale;

  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width / divisor,
    height: rect.height / divisor,
  };
}

export function documentToViewportRect(
  rect: DocumentRect,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): ViewportRect {
  const topLeft = documentToViewport({ x: rect.x, y: rect.y }, transform, layout);
  const safeScale = clampScale(transform.scale);
  const safeBaseScale = layout.baseScale > 0 && isFinite(layout.baseScale) ? layout.baseScale : 1.0;
  const multiplier = safeScale * safeBaseScale;

  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * multiplier,
    height: rect.height * multiplier,
  };
}

// =============================================================================
// BACKWARDS-COMPATIBILITY ADAPTERS
// (For existing components and tests using DocumentPoint/ScreenPoint directly)
// =============================================================================

/**
 * Transforms a point from Document Coordinates to Screen Coordinates (assumes origin 0,0).
 */
export function documentToScreenPoint(
  point: DocumentPoint,
  transform: ViewportTransform,
): ScreenPoint {
  return documentToViewport(point, transform, DEFAULT_DOCUMENT_LAYOUT);
}

/**
 * Transforms a point from Screen Coordinates to Document Coordinates (assumes origin 0,0).
 */
export function screenToDocumentPoint(
  point: ScreenPoint,
  transform: ViewportTransform,
): DocumentPoint {
  if (transform.scale === 0) {
    throw new Error('Transform scale cannot be zero');
  }
  return viewportToDocument(point, transform, DEFAULT_DOCUMENT_LAYOUT);
}

export function documentToScreenRect(
  rect: DocumentRect,
  transform: ViewportTransform,
): ScreenRect {
  return documentToViewportRect(rect, transform, DEFAULT_DOCUMENT_LAYOUT);
}

export function screenToDocumentRect(
  rect: ScreenRect,
  transform: ViewportTransform,
): DocumentRect {
  return viewportToDocumentRect(rect, transform, DEFAULT_DOCUMENT_LAYOUT);
}

/**
 * Determines whether a document coordinate point is within a document rectangle.
 */
export function rectContainsPoint(
  rect: DocumentRect,
  point: DocumentPoint,
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Determines whether two document rectangles intersect.
 */
export function rectsIntersect(a: DocumentRect, b: DocumentRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
