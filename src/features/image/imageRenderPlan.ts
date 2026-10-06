import { DocumentRect } from '../../types/geometry';
import { AddedTextElement, DocumentPage } from '../../types/document';
import { fitTextToBoundingBox, MIN_READABLE_FONT_SIZE } from '../text/textFitting';
import {
  TextMeasurer,
  estimateTextWidth,
  layoutTextBlock,
  resolveRenderableFontFamily,
} from '../text/textLayout';

/**
 * Single source of truth for how an image page's edit layers are composited.
 *
 * Both the on-screen Skia canvas (DocumentCanvas) and the native exporter consume this
 * plan, so the exported image matches what the user sees. All values are in document
 * (intrinsic image pixel) coordinates; no viewport data is involved. Line breaking and line
 * positions are computed here (once, with one measurer); renderers only draw the lines.
 */

export const DEFAULT_ADDED_TEXT_FONT_SIZE = 16;
export const DEFAULT_TEXT_COLOR = '#111827';
export const DEFAULT_FONT_FAMILY = 'sans-serif';
/** Baseline offset of added text relative to its top edge, as a fraction of font size. */
export const ADDED_TEXT_BASELINE_RATIO = 0.85;
/** Horizontal inset applied to replacement text inside its OCR bounds. */
export const REPLACEMENT_TEXT_X_INSET = 1;

export type RenderTextAlignment = 'left' | 'center' | 'right';

export interface RenderPatchLayer {
  readonly regionId: string;
  readonly patchUri: string;
  readonly bounds: DocumentRect;
}

/** One drawn line of a text layer. */
export interface RenderTextLine {
  readonly text: string;
  /** Line start X in document pixels (alignment already applied). */
  readonly x: number;
  /** Line baseline Y in document pixels. */
  readonly baselineY: number;
  /** Measured advance width of the line. */
  readonly width: number;
}

export interface RenderTextLayer {
  readonly sourceId: string;
  readonly kind: 'replacement' | 'added';
  readonly text: string;
  /** Logical element bounds (selection / hit-testing geometry). */
  readonly bounds: DocumentRect;
  /** Final rendered font size in document pixels. */
  readonly fittedFontSize: number;
  /** Baseline Y of the first line in document pixels. */
  readonly baselineY: number;
  /** Start X of the first line in document pixels. */
  readonly drawX: number;
  readonly color: string;
  readonly fontWeight: string;
  readonly fontStyle: 'normal' | 'italic';
  /** A family every renderer can provide (see resolveRenderableFontFamily). */
  readonly fontFamily: string;
  readonly alignment: RenderTextAlignment;
  /** Line advance in document pixels. */
  readonly lineHeight: number;
  /** Lines to draw, in order. Renderers must draw exactly these (no re-wrapping). */
  readonly lines: RenderTextLine[];
}

/** Markup layer drawn on top of everything (same path commands for canvas and export). */
export interface RenderDrawingLayer {
  readonly id: string;
  readonly commands: readonly (readonly (string | number)[])[];
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
  /** Highlighter strokes multiply with the image underneath. */
  readonly multiply: boolean;
}

export interface ImageRenderPlan {
  readonly patches: RenderPatchLayer[];
  readonly textElements: RenderTextLayer[];
  readonly drawings: RenderDrawingLayer[];
}

export interface ImageRenderPlanOptions {
  /**
   * Text measurer for line breaking and alignment. Pass the SAME measurer for the canvas
   * and for export (defaultTextMeasurer). Defaults to the deterministic estimate.
   */
  readonly measureText?: TextMeasurer;
}

function renderFontSize(size: number): number {
  return Math.max(MIN_READABLE_FONT_SIZE, Math.round(size));
}

function toRenderAlignment(alignment?: string): RenderTextAlignment {
  return alignment === 'center' || alignment === 'right' ? alignment : 'left';
}

/** Bounds of an added text element, tolerating legacy flat x/y/width/height records. */
export function addedTextBounds(element: AddedTextElement): DocumentRect {
  const legacy = element as unknown as { x?: number; y?: number; width?: number; height?: number };
  return (
    element.bounds || {
      x: legacy.x || 0,
      y: legacy.y || 0,
      width: legacy.width || 0,
      height: legacy.height || 0,
    }
  );
}

/**
 * Full text layout of an added text element: font, lines (wrapping + explicit newlines),
 * per-line positions and the resulting block size. Used by the render plan and to compute
 * the element's bounds when it is created, edited or moved.
 */
export function layoutAddedText(element: AddedTextElement, measure: TextMeasurer = estimateTextWidth) {
  const styleSize = element.style?.fontSize || DEFAULT_ADDED_TEXT_FONT_SIZE;
  const fittedFontSize = renderFontSize(styleSize);
  const font = {
    fontFamily: resolveRenderableFontFamily(element.style?.fontFamily),
    fontSize: fittedFontSize,
    fontWeight: element.style?.fontWeight || 'normal',
    fontStyle: (element.style?.fontStyle || 'normal') as 'normal' | 'italic',
  };
  const layout = layoutTextBlock(element.text, font, {
    lineHeight: element.style?.lineHeight,
    maxWidth: element.wrapWidth,
    measure,
  });
  const bounds = addedTextBounds(element);
  const alignment = toRenderAlignment(element.style?.alignment);
  const firstBaseline = bounds.y + styleSize * ADDED_TEXT_BASELINE_RATIO;
  const lines: RenderTextLine[] = layout.lines.map((line, i) => {
    const offset =
      alignment === 'center' ? (layout.width - line.width) / 2 : alignment === 'right' ? layout.width - line.width : 0;
    return {
      text: line.text,
      x: bounds.x + offset,
      baselineY: firstBaseline + i * layout.lineHeight,
      width: line.width,
    };
  });
  return { font, fittedFontSize, alignment, layout, lines, bounds };
}

export function buildImageRenderPlan(
  page: Pick<DocumentPage, 'editableTextRegions' | 'addedText'> & Partial<Pick<DocumentPage, 'drawings'>>,
  options: ImageRenderPlanOptions = {},
): ImageRenderPlan {
  const measure = options.measureText ?? estimateTextWidth;
  const regions = page.editableTextRegions || [];

  // Layer 2: reconstructed background patches for modified and deleted regions.
  const patches: RenderPatchLayer[] = regions
    .filter(
      (r) => (r.status === 'modified' || r.status === 'deleted') && !!r.reconstructedPatchUri,
    )
    .map((r) => ({
      regionId: r.id,
      patchUri: r.reconstructedPatchUri!,
      bounds: r.reconstructedPatchBounds || r.bounds,
    }));

  // Layer 3: replacement text for modified regions (single fitted line, unchanged behaviour).
  const replacementLayers: RenderTextLayer[] = regions
    .filter((r) => r.status === 'modified' && !!r.currentText && r.currentText.trim().length > 0)
    .map((r) => {
      const fit = fitTextToBoundingBox(r.bounds, r.originalText, r.currentText, r.style);
      const fittedFontSize = renderFontSize(fit.fittedFontSize);
      const fontFamily = r.style.fontFamily
        ? resolveRenderableFontFamily(r.style.fontFamily)
        : DEFAULT_FONT_FAMILY;
      const fontWeight = r.style.fontWeight || 'normal';
      const fontStyle = r.style.fontStyle || 'normal';
      const drawX = r.bounds.x + REPLACEMENT_TEXT_X_INSET;
      const width = measure(r.currentText, {
        fontFamily: resolveRenderableFontFamily(fontFamily),
        fontSize: fittedFontSize,
        fontWeight,
        fontStyle,
      });
      return {
        sourceId: r.id,
        kind: 'replacement' as const,
        text: r.currentText,
        bounds: r.bounds,
        fittedFontSize,
        baselineY: fit.baselineY,
        drawX,
        color: r.style.color || DEFAULT_TEXT_COLOR,
        fontWeight,
        fontStyle,
        fontFamily,
        alignment: 'left' as const,
        lineHeight: fittedFontSize * 1.25,
        lines: [{ text: r.currentText, x: drawX, baselineY: fit.baselineY, width }],
      };
    });

  // Layer 4: user-added text elements (multi-line, aligned, wrapped).
  const addedLayers: RenderTextLayer[] = (page.addedText || [])
    .filter((a) => !!a.text && a.text.trim().length > 0)
    .map((a) => {
      const { font, fittedFontSize, alignment, layout, lines, bounds } = layoutAddedText(a, measure);
      return {
        sourceId: a.id,
        kind: 'added' as const,
        text: a.text,
        bounds,
        fittedFontSize,
        baselineY: lines[0].baselineY,
        drawX: lines[0].x,
        color: a.style?.color || DEFAULT_TEXT_COLOR,
        fontWeight: font.fontWeight,
        fontStyle: font.fontStyle,
        fontFamily: font.fontFamily,
        alignment,
        lineHeight: layout.lineHeight,
        lines,
      };
    });

  // Layer 5: markup (ink, highlighter, shapes, signatures), in drawing order.
  const drawings: RenderDrawingLayer[] = (page.drawings || [])
    .filter((d) => Array.isArray(d.commands) && d.commands.length > 0 && d.width > 0)
    .map((d) => ({
      id: d.id,
      commands: d.commands,
      color: d.color,
      width: d.width,
      opacity: Math.max(0, Math.min(1, d.opacity ?? 1)),
      multiply: d.kind === 'highlighter',
    }));

  return {
    patches,
    textElements: [...replacementLayers, ...addedLayers],
    drawings,
  };
}
