import {
  viewportToDocument as centralizedVpToDoc,
  documentToViewport as centralizedDocToVp,
} from '../../utils/coordinates';

export interface PdfViewportTransform {
  readonly baseScale: number;
  readonly pageOriginX: number;
  readonly pageOriginY: number;
  readonly zoom: number;
  readonly translateX: number;
  readonly translateY: number;
}

/**
 * Converts a gesture point local to the viewport into the PDF editor's
 * top-left document coordinate space. Centrally delegates to coordinates utility.
 */
export function viewportPointToDocumentPoint(
  point: { x: number; y: number },
  transform: PdfViewportTransform,
): { x: number; y: number } {
  return centralizedVpToDoc(
    point,
    {
      scale: transform.zoom || 1,
      translateX: transform.translateX || 0,
      translateY: transform.translateY || 0,
    },
    {
      baseScale: transform.baseScale || 1,
      originX: transform.pageOriginX || 0,
      originY: transform.pageOriginY || 0,
    },
  );
}

/**
 * Part of the page (document points, top-left origin) currently visible in a viewport of
 * the given size, clamped to the page. Built only from viewportPointToDocumentPoint, so it
 * uses exactly the same transform as hit-testing. Null when the page is not visible.
 */
export function visibleDocumentRect(
  viewport: { width: number; height: number },
  transform: PdfViewportTransform,
  page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const a = viewportPointToDocumentPoint({ x: 0, y: 0 }, transform);
  const b = viewportPointToDocumentPoint({ x: viewport.width, y: viewport.height }, transform);
  const left = Math.max(0, Math.min(a.x, b.x));
  const top = Math.max(0, Math.min(a.y, b.y));
  const right = Math.min(page.width, Math.max(a.x, b.x));
  const bottom = Math.min(page.height, Math.max(a.y, b.y));
  if (!(right > left) || !(bottom > top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Converts a PDF document point into viewport space coordinates.
 * Centrally delegates to coordinates utility.
 */
export function documentPointToViewportPoint(
  point: { x: number; y: number },
  transform: PdfViewportTransform,
): { x: number; y: number } {
  return centralizedDocToVp(
    point,
    {
      scale: transform.zoom || 1,
      translateX: transform.translateX || 0,
      translateY: transform.translateY || 0,
    },
    {
      baseScale: transform.baseScale || 1,
      originX: transform.pageOriginX || 0,
      originY: transform.pageOriginY || 0,
    },
  );
}
