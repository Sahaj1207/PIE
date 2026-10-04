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
