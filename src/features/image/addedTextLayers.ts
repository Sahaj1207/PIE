/**
 * Added-text layers of the canonical image document (Document.pages[].addedText).
 *
 * Pure, immutable operations used by the image editor. Every operation returns a NEW document
 * and touches only the layer with the given id; all other layers, OCR regions and the source
 * image reference are carried over unchanged. Added text is never flattened into the source
 * image: it stays a layer that the shared render plan draws on screen and in export.
 *
 * Bounds are derived from the shared text layout (layoutAddedText) with the same measurer the
 * canvas and exporter use, so selection geometry matches the drawn text.
 */
import { AddedTextElement, Document, DocumentPage, TextStyleSpec } from '../../types/document';
import { DocumentPoint } from '../../types/geometry';
import { TextMeasurer, estimateTextWidth, resolveRenderableFontFamily } from '../text/textLayout';
import { DEFAULT_ADDED_TEXT_FONT_SIZE, DEFAULT_TEXT_COLOR, layoutAddedText } from './imageRenderPlan';

/** Minimum size of an added-text box so it stays selectable. */
export const MIN_ADDED_TEXT_BOX = 8;
/** Gap kept between added text and the right image edge when choosing a wrap width. */
export const ADDED_TEXT_EDGE_MARGIN = 8;

export interface AddedTextStyleInput {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string;
  readonly fontStyle?: 'normal' | 'italic';
  readonly color?: string;
  readonly alignment?: 'left' | 'center' | 'right';
}

let idCounter = 0;

/** Stable, collision-free layer id (unique within the page even within one millisecond). */
export function createAddedTextId(existing: readonly AddedTextElement[], now: number = Date.now()): string {
  const taken = new Set(existing.map((e) => e.id));
  let id: string;
  do {
    idCounter += 1;
    id = `added-${now.toString(36)}-${idCounter.toString(36)}`;
  } while (taken.has(id));
  return id;
}

/** Normalizes user text: unified newlines, no leading/trailing blank space. */
export function normalizeAddedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '');
}

function buildStyle(input: AddedTextStyleInput, base?: TextStyleSpec): TextStyleSpec {
  const fontSize = input.fontSize ?? base?.fontSize ?? DEFAULT_ADDED_TEXT_FONT_SIZE;
  return {
    ...base,
    fontFamily: resolveRenderableFontFamily(input.fontFamily ?? base?.fontFamily),
    fontSize: fontSize > 0 ? fontSize : DEFAULT_ADDED_TEXT_FONT_SIZE,
    fontWeight: input.fontWeight ?? base?.fontWeight ?? 'normal',
    fontStyle: input.fontStyle ?? base?.fontStyle ?? 'normal',
    color: input.color ?? base?.color ?? DEFAULT_TEXT_COLOR,
    alignment: input.alignment ?? base?.alignment ?? 'left',
  };
}

/** Recomputes width/height from the shared layout, keeping the element's origin. */
export function measureAddedTextElement(
  element: AddedTextElement,
  measure: TextMeasurer = estimateTextWidth,
): AddedTextElement {
  const { layout } = layoutAddedText(element, measure);
  const width = Math.max(MIN_ADDED_TEXT_BOX, Math.ceil(layout.width));
  const height = Math.max(MIN_ADDED_TEXT_BOX, Math.ceil(layout.height));
  return { ...element, bounds: { ...element.bounds, width, height } };
}

function getPage(document: Document, pageIndex: number): DocumentPage {
  const page = document.pages[pageIndex];
  if (!page) {
    throw new Error(`Page ${pageIndex} does not exist in this document.`);
  }
  return page;
}

function withAddedText(document: Document, pageIndex: number, addedText: AddedTextElement[]): Document {
  return {
    ...document,
    metadata: { ...document.metadata, updatedAt: Date.now() },
    pages: document.pages.map((p, i) => (i === pageIndex ? { ...p, addedText } : p)),
  };
}

/** Keeps an origin inside the page (at least partly visible and selectable). */
export function clampAddedTextOrigin(
  origin: DocumentPoint,
  size: { width: number; height: number },
  page: Pick<DocumentPage, 'dimensions'>,
): DocumentPoint {
  const pageW = page.dimensions?.width ?? Number.POSITIVE_INFINITY;
  const pageH = page.dimensions?.height ?? Number.POSITIVE_INFINITY;
  const maxX = Math.max(0, pageW - Math.min(size.width, pageW));
  const maxY = Math.max(0, pageH - Math.min(size.height, pageH));
  return {
    x: Math.round(Math.min(Math.max(0, origin.x), maxX)),
    y: Math.round(Math.min(Math.max(0, origin.y), maxY)),
  };
}

export interface CreateAddedTextInput {
  readonly text: string;
  readonly origin: DocumentPoint;
  readonly style: AddedTextStyleInput;
  readonly pageIndex?: number;
}

/**
 * Creates a new added-text layer at `origin` (document coordinates). Long lines wrap at the
 * right image edge (wrapWidth), explicit newlines are preserved.
 */
export function createAddedText(
  document: Document,
  input: CreateAddedTextInput,
  measure: TextMeasurer = estimateTextWidth,
): { document: Document; element: AddedTextElement } {
  const pageIndex = input.pageIndex ?? 0;
  const page = getPage(document, pageIndex);
  const text = normalizeAddedText(input.text);
  if (!text) {
    throw new Error('Added text cannot be empty.');
  }
  const existing = page.addedText || [];
  const pageWidth = page.dimensions?.width ?? 0;
  const x = Math.max(0, Math.round(input.origin.x));
  const available = pageWidth > 0 ? pageWidth - x - ADDED_TEXT_EDGE_MARGIN : 0;

  let element: AddedTextElement = {
    id: createAddedTextId(existing),
    pageIndex,
    text,
    bounds: { x, y: Math.max(0, Math.round(input.origin.y)), width: 0, height: 0 },
    style: buildStyle(input.style),
    ...(available > MIN_ADDED_TEXT_BOX ? { wrapWidth: Math.floor(available) } : {}),
  };
  element = measureAddedTextElement(element, measure);
  const origin = clampAddedTextOrigin(element.bounds, element.bounds, page);
  element = { ...element, bounds: { ...element.bounds, ...origin } };

  return { document: withAddedText(document, pageIndex, [...existing, element]), element };
}

export interface UpdateAddedTextInput {
  readonly text?: string;
  readonly style?: AddedTextStyleInput;
}

/**
 * Edits text and/or formatting of ONE layer. Its position (origin), wrap width and any
 * other properties are preserved; only its size is re-measured.
 */
export function updateAddedText(
  document: Document,
  id: string,
  changes: UpdateAddedTextInput,
  measure: TextMeasurer = estimateTextWidth,
  pageIndex = 0,
): { document: Document; element: AddedTextElement } {
  const page = getPage(document, pageIndex);
  const existing = page.addedText || [];
  const current = existing.find((e) => e.id === id);
  if (!current) {
    throw new Error(`Added text "${id}" no longer exists.`);
  }
  const text = changes.text !== undefined ? normalizeAddedText(changes.text) : current.text;
  if (!text) {
    throw new Error('Added text cannot be empty.');
  }
  const updated = measureAddedTextElement(
    { ...current, text, style: buildStyle(changes.style ?? {}, current.style) },
    measure,
  );
  return {
    document: withAddedText(document, pageIndex, existing.map((e) => (e.id === id ? updated : e))),
    element: updated,
  };
}

/** Moves ONE layer to a new origin (document coordinates), clamped inside the page. */
export function moveAddedText(
  document: Document,
  id: string,
  origin: DocumentPoint,
  pageIndex = 0,
): { document: Document; element: AddedTextElement } {
  const page = getPage(document, pageIndex);
  const existing = page.addedText || [];
  const current = existing.find((e) => e.id === id);
  if (!current) {
    throw new Error(`Added text "${id}" no longer exists.`);
  }
  const next = clampAddedTextOrigin(origin, current.bounds, page);
  const moved: AddedTextElement = { ...current, bounds: { ...current.bounds, x: next.x, y: next.y } };
  return {
    document: withAddedText(document, pageIndex, existing.map((e) => (e.id === id ? moved : e))),
    element: moved,
  };
}

export interface AddedTextManipulation {
  /** Translation in document pixels. */
  readonly dx: number;
  readonly dy: number;
  /** Uniform scale of the layer (font size and wrap width) around its centre. */
  readonly scale: number;
}

export interface ManipulationLimits {
  readonly minFontSize: number;
  readonly maxFontSize: number;
}

/**
 * Applies a completed direct manipulation (one-finger move and/or two-finger resize) to ONE
 * layer as a single operation. Resizing scales the font size and wrap width together, so
 * the text keeps its line breaks, and keeps the layer's centre (plus the move) fixed. The
 * result is clamped inside the page. `changed` is false when nothing moved or resized.
 */
export function manipulateAddedText(
  document: Document,
  id: string,
  manipulation: AddedTextManipulation,
  limits: ManipulationLimits,
  measure: TextMeasurer = estimateTextWidth,
  pageIndex = 0,
): { document: Document; element: AddedTextElement; changed: boolean } {
  const page = getPage(document, pageIndex);
  const existing = page.addedText || [];
  const current = existing.find((e) => e.id === id);
  if (!current) {
    throw new Error(`Added text "${id}" no longer exists.`);
  }
  const dx = Number.isFinite(manipulation.dx) ? manipulation.dx : 0;
  const dy = Number.isFinite(manipulation.dy) ? manipulation.dy : 0;
  const requestedScale = Number.isFinite(manipulation.scale) && manipulation.scale > 0 ? manipulation.scale : 1;

  const baseFont = current.style?.fontSize || DEFAULT_ADDED_TEXT_FONT_SIZE;
  const targetFont =
    Math.round(Math.min(Math.max(baseFont * requestedScale, limits.minFontSize), limits.maxFontSize) * 10) / 10;
  const resized = Math.abs(targetFont - baseFont) >= 0.05;

  let next: AddedTextElement = current;
  if (resized) {
    const effective = targetFont / baseFont;
    next = measureAddedTextElement(
      {
        ...current,
        style: { ...current.style, fontSize: targetFont },
        ...(current.wrapWidth ? { wrapWidth: Math.max(MIN_ADDED_TEXT_BOX, Math.round(current.wrapWidth * effective)) } : {}),
      },
      measure,
    );
  }

  // Keep the (moved) centre fixed while the size changes
  const centerX = current.bounds.x + current.bounds.width / 2 + dx;
  const centerY = current.bounds.y + current.bounds.height / 2 + dy;
  const origin = clampAddedTextOrigin(
    { x: centerX - next.bounds.width / 2, y: centerY - next.bounds.height / 2 },
    next.bounds,
    page,
  );
  const result: AddedTextElement = { ...next, bounds: { ...next.bounds, x: origin.x, y: origin.y } };

  const changed =
    resized || result.bounds.x !== current.bounds.x || result.bounds.y !== current.bounds.y;
  if (!changed) {
    return { document, element: current, changed: false };
  }
  return {
    document: withAddedText(document, pageIndex, existing.map((e) => (e.id === id ? result : e))),
    element: result,
    changed: true,
  };
}

/** Removes ONE layer. */
export function deleteAddedText(document: Document, id: string, pageIndex = 0): Document {
  const page = getPage(document, pageIndex);
  const existing = page.addedText || [];
  return withAddedText(document, pageIndex, existing.filter((e) => e.id !== id));
}
