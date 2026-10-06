/**
 * PDF render-scale selection (pixels per PDF point).
 *
 * - The full page is rendered once per revision at a moderate scale (default 2 px/pt),
 *   capped by a pixel budget so very large pages never allocate huge bitmaps.
 * - When the user zooms in beyond what that render can show sharply, only the VISIBLE
 *   region (plus a margin) is rendered at a higher scale once the gesture settles — never on
 *   every pinch frame, and never as a giant full-page bitmap.
 */

export const DEFAULT_PAGE_RENDER_SCALE = 2;
export const MIN_PAGE_RENDER_SCALE = 0.25;
/** Full-page render budget (ARGB: ~32 MB). */
export const MAX_PAGE_RENDER_PIXELS = 8_000_000;
/** Region (zoom detail) render budget (ARGB: ~24 MB). */
export const MAX_DETAIL_RENDER_PIXELS = 6_000_000;
export const MAX_DETAIL_RENDER_SCALE = 12;
/** Quantized detail scales: settling at nearby zoom levels reuses the same render. */
export const DETAIL_SCALE_STEPS: readonly number[] = [3, 4, 6, 8, 12];
/** Detail is only rendered when the base render is clearly too coarse. */
export const DETAIL_TRIGGER_RATIO = 1.15;
/** Extra area around the visible region so small pans stay sharp. */
export const DETAIL_MARGIN_RATIO = 0.25;

export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step + 1e-9) * step;
}

/**
 * Scale for the full-page base render: `preferred` (default 2 px/pt) unless that would
 * exceed the pixel budget, in which case the largest scale within budget (0.05 steps).
 */
export function choosePageRenderScale(
  pageWidth: number,
  pageHeight: number,
  options: { preferred?: number; maxPixels?: number } = {},
): number {
  const preferred = options.preferred ?? DEFAULT_PAGE_RENDER_SCALE;
  const maxPixels = options.maxPixels ?? MAX_PAGE_RENDER_PIXELS;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return preferred;
  const budgetScale = Math.sqrt(maxPixels / (pageWidth * pageHeight));
  if (preferred <= budgetScale) return preferred;
  return Math.max(MIN_PAGE_RENDER_SCALE, floorTo(budgetScale, 0.05));
}

/** Device pixels per PDF point needed to show the page sharply at this zoom. */
export function requiredPixelsPerPoint(baseFitScale: number, zoom: number, pixelRatio: number): number {
  return Math.max(0, baseFitScale) * Math.max(0, zoom) * Math.max(1, pixelRatio);
}

export interface DetailRenderPlan {
  readonly scale: number;
  /** Region of the page (display points), whole-point aligned. */
  readonly rect: PdfRect;
}

export interface DetailRenderInput {
  readonly page: { readonly width: number; readonly height: number };
  /** Visible part of the page in document points (see visibleDocumentRect). */
  readonly visibleRect: PdfRect | null;
  /** On-screen points per PDF point at zoom 1 (fit scale). */
  readonly baseFitScale: number;
  readonly zoom: number;
  readonly pixelRatio: number;
  /** Scale of the current full-page render. */
  readonly baseRenderScale: number;
  readonly maxPixels?: number;
  readonly marginRatio?: number;
}

/**
 * Decides whether the visible region needs a sharper render and at which scale. Returns
 * null when the base render is sufficient (or the budget allows no real improvement).
 */
export function chooseDetailRender(input: DetailRenderInput): DetailRenderPlan | null {
  const { page, visibleRect } = input;
  if (!visibleRect || !(page.width > 0) || !(page.height > 0)) return null;
  const required = requiredPixelsPerPoint(input.baseFitScale, input.zoom, input.pixelRatio);
  const threshold = input.baseRenderScale * DETAIL_TRIGGER_RATIO;
  if (!(required > threshold)) return null;

  const margin = input.marginRatio ?? DETAIL_MARGIN_RATIO;
  const mx = visibleRect.width * margin;
  const my = visibleRect.height * margin;
  const left = Math.max(0, Math.floor(visibleRect.x - mx));
  const top = Math.max(0, Math.floor(visibleRect.y - my));
  const right = Math.min(page.width, Math.ceil(visibleRect.x + visibleRect.width + mx));
  const bottom = Math.min(page.height, Math.ceil(visibleRect.y + visibleRect.height + my));
  if (!(right > left) || !(bottom > top)) return null;
  const rect = { x: left, y: top, width: right - left, height: bottom - top };

  const step = DETAIL_SCALE_STEPS.find((s) => s >= required) ?? MAX_DETAIL_RENDER_SCALE;
  const budgetScale = Math.sqrt((input.maxPixels ?? MAX_DETAIL_RENDER_PIXELS) / (rect.width * rect.height));
  const scale = Math.min(step, MAX_DETAIL_RENDER_SCALE, floorTo(budgetScale, 0.25));
  if (!(scale > threshold)) return null;
  return { scale, rect };
}

/** True when an existing detail render already covers `plan` at the same or higher scale. */
export function detailRenderCovers(
  existing: { readonly scale: number; readonly rect: PdfRect } | null | undefined,
  plan: DetailRenderPlan,
): boolean {
  if (!existing) return false;
  const e = existing.rect;
  const p = plan.rect;
  return (
    existing.scale >= plan.scale &&
    e.x <= p.x &&
    e.y <= p.y &&
    e.x + e.width >= p.x + p.width &&
    e.y + e.height >= p.y + p.height
  );
}
