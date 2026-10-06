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
} from '../../types/geometry';
import {
  clamp,
  clampScale,
  DEFAULT_DOCUMENT_LAYOUT,
  MIN_VIEWPORT_SCALE,
  MAX_VIEWPORT_SCALE,
  DEFAULT_VIEWPORT_SCALE,
  screenToViewport,
  viewportToScreen,
  viewportToDocument as baseVpToDoc,
  documentToViewport as baseDocToVp,
  screenToDocument as baseScreenToDoc,
  documentToScreen as baseDocToScreen,
  viewportToDocumentRect as baseVpToDocRect,
  documentToViewportRect as baseDocToVpRect,
} from '../../utils/coordinates';

export const MIN_IMAGE_SCALE = MIN_VIEWPORT_SCALE; // 0.5
export const MAX_IMAGE_SCALE = MAX_VIEWPORT_SCALE; // 4.0
export const DEFAULT_IMAGE_SCALE = DEFAULT_VIEWPORT_SCALE; // 1.0

export interface ImageInitialFitParams {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly padding?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
}

export interface ImageFocalZoomParams {
  readonly currentScale: number;
  readonly targetScale: number;
  readonly focalX: number;
  readonly focalY: number;
  readonly currentTx: number;
  readonly currentTy: number;
  readonly minScale?: number;
  readonly maxScale?: number;
}

export interface ImagePanClampParams {
  readonly translateX: number;
  readonly translateY: number;
  readonly scale: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly allowDriftMargin?: number;
}

/**
 * Calculates deterministic initial fit transform that fits the entire image
 * within the available viewport while preserving aspect ratio and centering.
 */
export function calculateImageInitialFit(params: ImageInitialFitParams): ViewportTransform {
  const {
    viewportWidth,
    viewportHeight,
    imageWidth,
    imageHeight,
    padding = 24,
    minScale = 0.05,
    maxScale = MAX_IMAGE_SCALE,
  } = params;

  if (
    !isFinite(viewportWidth) ||
    !isFinite(viewportHeight) ||
    !isFinite(imageWidth) ||
    !isFinite(imageHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return { scale: DEFAULT_IMAGE_SCALE, translateX: 0, translateY: 0 };
  }

  const availW = Math.max(viewportWidth - padding * 2, 20);
  const availH = Math.max(viewportHeight - padding * 2, 20);

  const scaleX = availW / imageWidth;
  const scaleY = availH / imageHeight;
  const rawFitScale = Math.min(scaleX, scaleY);
  const fitScale = clamp(rawFitScale, minScale, maxScale);

  const scaledW = imageWidth * fitScale;
  const scaledH = imageHeight * fitScale;

  const translateX = (viewportWidth - scaledW) / 2;
  const translateY = (viewportHeight - scaledH) / 2;

  return {
    scale: Math.round(fitScale * 1000) / 1000,
    translateX: Math.round(translateX),
    translateY: Math.round(translateY),
  };
}

export interface ImageZoomBounds {
  readonly minScale: number;
  readonly maxScale: number;
}

/** Lowest zoom allowed relative to the fit-to-viewport scale (zooming out past fit). */
export const IMAGE_MIN_ZOOM_OUT_OF_FIT = 0.5;

/**
 * Resolves absolute zoom bounds for an image whose fit-to-viewport scale is `fitScale`.
 *
 * Large images fit at scales far below MIN_IMAGE_SCALE (e.g. 0.1 for a 4000 px photo).
 * Clamping such a transform to the fixed [0.5, 4.0] range made the first pinch jump the
 * image to 0.5. The minimum therefore extends down to half the fit scale, while the
 * maximum keeps the established 4.0 upper bound (never below the fit scale itself).
 */
export function resolveImageZoomBounds(fitScale: number): ImageZoomBounds {
  if (!isFinite(fitScale) || fitScale <= 0) {
    return { minScale: MIN_IMAGE_SCALE, maxScale: MAX_IMAGE_SCALE };
  }
  const minScale = Math.min(MIN_IMAGE_SCALE, fitScale * IMAGE_MIN_ZOOM_OUT_OF_FIT);
  const maxScale = Math.max(MAX_IMAGE_SCALE, fitScale);
  return {
    minScale: Math.round(minScale * 10000) / 10000,
    maxScale,
  };
}

/**
 * Calculates new transform (scale and focal translation) preserving the point under fingers.
 * Clamps scale strictly to [minScale, maxScale] (default 0.5 to 4.0).
 */
export function calculateImageFocalZoom(params: ImageFocalZoomParams): ViewportTransform {
  const minScale = params.minScale ?? MIN_IMAGE_SCALE;
  const maxScale = params.maxScale ?? MAX_IMAGE_SCALE;

  const validCurrentScale = clampScale(params.currentScale, minScale, maxScale);
  const nextScale = clampScale(params.targetScale, minScale, maxScale);
  const scaleRatio = nextScale / validCurrentScale;

  const newTx = params.focalX - (params.focalX - params.currentTx) * scaleRatio;
  const newTy = params.focalY - (params.focalY - params.currentTy) * scaleRatio;

  return {
    scale: Math.round(nextScale * 1000) / 1000,
    translateX: isFinite(newTx) ? Math.round(newTx) : Math.round(params.currentTx),
    translateY: isFinite(newTy) ? Math.round(newTy) : Math.round(params.currentTy),
  };
}

/**
 * Clamps translation so the image doesn't drift uncontrollably into empty space.
 */
export function clampImageTranslation(params: ImagePanClampParams): { translateX: number; translateY: number } {
  const {
    translateX,
    translateY,
    scale,
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    allowDriftMargin = 50,
  } = params;

  if (viewportWidth <= 0 || viewportHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { translateX, translateY };
  }

  const scaledW = imageWidth * scale;
  const scaledH = imageHeight * scale;

  let minTx: number;
  let maxTx: number;
  if (scaledW <= viewportWidth) {
    // Image fits horizontally: center with slight drift tolerance
    const centerX = (viewportWidth - scaledW) / 2;
    minTx = centerX - allowDriftMargin;
    maxTx = centerX + allowDriftMargin;
  } else {
    // Image is wider than viewport: allow panning from right edge to left edge
    minTx = viewportWidth - scaledW - allowDriftMargin;
    maxTx = allowDriftMargin;
  }

  let minTy: number;
  let maxTy: number;
  if (scaledH <= viewportHeight) {
    // Image fits vertically: center with slight drift tolerance
    const centerY = (viewportHeight - scaledH) / 2;
    minTy = centerY - allowDriftMargin;
    maxTy = centerY + allowDriftMargin;
  } else {
    // Image is taller than viewport: allow panning from bottom edge to top edge
    minTy = viewportHeight - scaledH - allowDriftMargin;
    maxTy = allowDriftMargin;
  }

  return {
    translateX: Math.round(clamp(translateX, minTx, maxTx)),
    translateY: Math.round(clamp(translateY, minTy, maxTy)),
  };
}

// Coordinate transformations (Document Space <-> Viewport Space <-> Screen Space)
export const documentToViewport = baseDocToVp;
export const viewportToDocument = baseVpToDoc;
export const screenToDocument = baseScreenToDoc;
export const documentToScreen = baseDocToScreen;
export const documentToViewportRect = baseDocToVpRect;
export const viewportToDocumentRect = baseVpToDocRect;

export function screenToDocumentRect(
  rect: ScreenRect,
  origin: ViewportOrigin,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): DocumentRect {
  const vpRect: ViewportRect = {
    x: rect.x - origin.x,
    y: rect.y - origin.y,
    width: rect.width,
    height: rect.height,
  };
  return viewportToDocumentRect(vpRect, transform, layout);
}

export function documentToScreenRect(
  rect: DocumentRect,
  origin: ViewportOrigin,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
): ScreenRect {
  const vpRect = documentToViewportRect(rect, transform, layout);
  return {
    x: vpRect.x + origin.x,
    y: vpRect.y + origin.y,
    width: vpRect.width,
    height: vpRect.height,
  };
}

/**
 * Validates that documentToScreen(screenToDocument(point)) round-trips within epsilon.
 */
export function verifyCoordinateRoundTrip(
  docPoint: DocumentPoint,
  origin: ViewportOrigin,
  transform: ViewportTransform,
  layout: DocumentViewportLayout = DEFAULT_DOCUMENT_LAYOUT,
  tolerance = 0.001,
): boolean {
  const screen = documentToScreen(docPoint, origin, transform, layout);
  const backToDoc = screenToDocument(screen, origin, transform, layout);
  const dx = Math.abs(backToDoc.x - docPoint.x);
  const dy = Math.abs(backToDoc.y - docPoint.y);
  return dx <= tolerance && dy <= tolerance;
}
