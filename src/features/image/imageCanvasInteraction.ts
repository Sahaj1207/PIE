/**
 * Touch interaction for the image editor canvas (pure, shared by JS and gesture worklets).
 *
 * All tolerances are defined in SCREEN points and converted to document pixels with the
 * current zoom, so targets stay finger-sized whatever the image resolution or zoom: on a
 * 12 MP photo shown at fit scale (~0.1) a fixed document-pixel tolerance is sub-point and
 * makes text practically untappable.
 *
 * Added text (user layers) and OCR text regions (existing image text) are reported as
 * distinct kinds and are never confused.
 */
import { DocumentPoint, DocumentRect } from '../../types/geometry';
import { AddedTextElement, TextRegion } from '../../types/document';

/** Finger tolerance for taps (screen points). */
export const TAP_TOLERANCE_PT = 14;
/** Extra grab margin around an added-text layer that still starts a drag (screen points). */
export const DRAG_TOUCH_SLOP_PT = 16;
/** Margin around the selected layer within which a pinch resizes it (screen points). */
export const PINCH_TARGET_SLOP_PT = 56;
/** Smallest / largest added-text font size reachable by pinching (document pixels). */
export const MIN_ADDED_TEXT_FONT_SIZE = 4;

/** Largest added-text font size for a page: its short side (at least 64 px). */
export function maxAddedTextFontSize(page: { width: number; height: number }): number {
  'worklet';
  const shortSide = Math.min(page.width || 0, page.height || 0);
  return Math.max(64, shortSide);
}

/** Converts a screen-point tolerance to document pixels at the given zoom. */
export function screenToDocumentTolerance(points: number, zoom: number): number {
  'worklet';
  return zoom > 0 ? points / zoom : points;
}

/** Distance from a point to a rectangle (0 when inside). */
export function distanceToRect(rect: DocumentRect, p: DocumentPoint): number {
  'worklet';
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height));
  return Math.sqrt(dx * dx + dy * dy);
}

export type ImageCanvasHit =
  | { readonly kind: 'added'; readonly element: AddedTextElement }
  | { readonly kind: 'region'; readonly region: TextRegion };

/**
 * Tap hit test. Order:
 * 1. Targets containing the point: added text first (it is drawn on top), the top-most
 *    (last) added layer; else the smallest containing OCR region.
 * 2. Otherwise the target nearest to the point within `toleranceDoc`; on equal distance an
 *    added layer wins (top-most).
 * Deleted OCR regions are never hit. Returns null when nothing is within tolerance.
 */
export function hitTestImageCanvas(
  point: DocumentPoint,
  addedText: readonly AddedTextElement[],
  regions: readonly TextRegion[],
  toleranceDoc: number,
): ImageCanvasHit | null {
  const live = regions.filter((r) => r.status !== 'deleted');

  for (let i = addedText.length - 1; i >= 0; i--) {
    if (distanceToRect(addedText[i].bounds, point) === 0) {
      return { kind: 'added', element: addedText[i] };
    }
  }
  let containing: TextRegion | null = null;
  for (const r of live) {
    if (distanceToRect(r.bounds, point) === 0) {
      const area = r.bounds.width * r.bounds.height;
      if (!containing || area < containing.bounds.width * containing.bounds.height) containing = r;
    }
  }
  if (containing) return { kind: 'region', region: containing };

  let best: ImageCanvasHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = addedText.length - 1; i >= 0; i--) {
    const d = distanceToRect(addedText[i].bounds, point);
    if (d <= toleranceDoc && d < bestDistance) {
      best = { kind: 'added', element: addedText[i] };
      bestDistance = d;
    }
  }
  for (const r of live) {
    const d = distanceToRect(r.bounds, point);
    if (d <= toleranceDoc && d < bestDistance) {
      best = { kind: 'region', region: r };
      bestDistance = d;
    }
  }
  return best;
}

/** Minimal layer description mirrored to the UI thread for direct manipulation. */
export interface ManipulableLayer {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fontSize: number;
}

export function toManipulableLayers(addedText: readonly AddedTextElement[]): ManipulableLayer[] {
  return addedText.map((el) => ({
    id: el.id,
    x: el.bounds.x,
    y: el.bounds.y,
    w: el.bounds.width,
    h: el.bounds.height,
    fontSize: el.style?.fontSize || 16,
  }));
}

/**
 * Layer a one-finger drag starting at `point` grabs: the selected layer when the finger is on
 * or near it, else the top-most layer containing the point, else the nearest layer within
 * `slopDoc`. Null means the drag pans the canvas instead.
 */
export function hitTestManipulableLayer(
  layers: readonly ManipulableLayer[],
  point: DocumentPoint,
  slopDoc: number,
  selectedId: string | null,
): string | null {
  'worklet';
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const d = distanceToRect({ x: l.x, y: l.y, width: l.w, height: l.h }, point);
    if (d > slopDoc) continue;
    if (l.id === selectedId) return l.id;
    if (d < bestDistance) {
      best = l.id;
      bestDistance = d;
    }
  }
  return best;
}

/** True when a pinch centred at `focal` should resize `layer` (instead of zooming the page). */
export function pinchTargetsLayer(layer: ManipulableLayer, focal: DocumentPoint, slopDoc: number): boolean {
  'worklet';
  return distanceToRect({ x: layer.x, y: layer.y, width: layer.w, height: layer.h }, focal) <= slopDoc;
}

/** Clamps a pinch scale so the resulting font size stays within [minFont, maxFont]. */
export function clampManipulationScale(fontSize: number, scale: number, minFont: number, maxFont: number): number {
  'worklet';
  if (!(fontSize > 0) || !(scale > 0)) return 1;
  const target = Math.min(Math.max(fontSize * scale, minFont), maxFont);
  return target / fontSize;
}

/** What is selected on the image canvas (ids of the current document). */
export interface ImageCanvasSelection {
  readonly regionId: string | null;
  readonly addedId: string | null;
}

export interface ImageTapOutcome {
  /** Selection after the tap (at most one kind is ever selected). */
  readonly selection: ImageCanvasSelection;
  /** The tap landed on the text that was already selected: open its Edit panel. */
  readonly openEditor: boolean;
}

/**
 * Selection change for one tap on the image canvas. One hit (or none) yields exactly one
 * selection; tapping the selected text again keeps it selected and asks for the editor.
 */
export function resolveImageCanvasTap(current: ImageCanvasSelection, hit: ImageCanvasHit | null): ImageTapOutcome {
  if (!hit) return { selection: { regionId: null, addedId: null }, openEditor: false };
  if (hit.kind === 'region') {
    return {
      selection: { regionId: hit.region.id, addedId: null },
      openEditor: current.regionId === hit.region.id,
    };
  }
  return {
    selection: { regionId: null, addedId: hit.element.id },
    openEditor: current.addedId === hit.element.id,
  };
}
