/**
 * Image markup and page transforms on the canonical Document model (pure helpers + the
 * native transform call). Every function returns a NEW document; the editor commits it as one
 * DocumentHistoryManager step, so undo/redo/dirty/save behave like every other edit.
 */
import { NativeModules } from 'react-native';
import { Document, DocumentPage, ImageDrawing } from '../../types/document';
import { MarkupDrawing, nextDrawingId } from '../markup/markupModel';
import { PathCommand, fitStrokesInto } from '../markup/inkPath';
import { SavedSignature } from '../markup/signatureStore';
import { ImageTransformError } from '../../errors';
import { MAX_IMAGE_PIXELS, PREVIEW_MAX_DIMENSION } from './imageLimits';

declare const process: any;

function updatePage(document: Document, pageIndex: number, fn: (page: DocumentPage) => DocumentPage): Document {
  const page = document.pages[pageIndex];
  if (!page) return document;
  const pages = document.pages.map((p, i) => (i === pageIndex ? fn(p) : p));
  return { ...document, metadata: { ...document.metadata, updatedAt: Date.now() }, pages };
}

/** Converts finished markup drawings into document drawings. */
export function toImageDrawings(drawings: readonly MarkupDrawing[], pageIndex = 0): ImageDrawing[] {
  return drawings.map((d) => ({
    id: d.id,
    pageIndex,
    kind: d.kind,
    commands: d.commands as readonly (readonly (string | number)[])[],
    color: d.color,
    width: d.width,
    opacity: d.opacity,
  }));
}

/** Appends drawings to the page (one history step for a whole markup session). */
export function addImageDrawings(document: Document, drawings: readonly ImageDrawing[], pageIndex = 0): Document {
  if (drawings.length === 0) return document;
  return updatePage(document, pageIndex, (page) => ({ ...page, drawings: [...(page.drawings || []), ...drawings] }));
}

/** Removes one drawing (e.g. a misplaced signature). */
export function removeImageDrawing(document: Document, id: string, pageIndex = 0): Document {
  return updatePage(document, pageIndex, (page) => ({
    ...page,
    drawings: (page.drawings || []).filter((d) => d.id !== id),
  }));
}

/** A signature placed into `rect` (document pixels) as a drawing. */
export function signatureDrawing(
  signature: SavedSignature,
  rect: { x: number; y: number; width: number; height: number },
  color = '#1C1C1E',
  pageIndex = 0,
): ImageDrawing {
  const strokes = fitStrokesInto(signature.strokes, rect);
  const scale = rect.height / signature.height;
  const commands: PathCommand[] = strokes.flat();
  return {
    id: nextDrawingId('sig'),
    pageIndex,
    kind: 'signature',
    commands,
    color,
    width: Math.max(1, signature.strokeRatio * signature.height * scale),
    opacity: 1,
  };
}

/** True when the page carries edits that a transform must flatten (bake) first. */
export function pageHasEdits(page: DocumentPage | undefined): boolean {
  if (!page) return false;
  return (
    (page.addedText || []).length > 0 ||
    (page.drawings || []).length > 0 ||
    (page.editableTextRegions || []).some((r) => r.status === 'modified' || r.status === 'deleted')
  );
}

export interface ImageTransformRequest {
  /** Clockwise quarter turns (0-3). */
  readonly quarterTurns?: number;
  readonly flipHorizontal?: boolean;
  readonly flipVertical?: boolean;
  /** Crop rectangle in the CURRENT document pixel grid (applied before rotation). */
  readonly crop?: { x: number; y: number; width: number; height: number } | null;
}

export interface TransformedImage {
  readonly assetUri: string;
  readonly previewUri?: string;
  readonly width: number;
  readonly height: number;
}

/** Native rotate / flip / crop into a new upright working image in `outputDir`. */
export async function transformImageFile(
  sourceUri: string,
  outputDir: string,
  request: ImageTransformRequest,
): Promise<TransformedImage> {
  const mod = NativeModules.ImageProcessingModule;
  if (!mod || typeof mod.transformImage !== 'function') {
    if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test') {
      // Jest: deterministic simulated output (never used in the app).
      return { assetUri: `file:///simulated/transform_${Date.now()}.png`, width: 100, height: 100 };
    }
    throw new ImageTransformError('Rotating and cropping are not available on this device.');
  }
  try {
    const r = await mod.transformImage({
      sourceUri,
      outputDir,
      quarterTurns: request.quarterTurns ?? 0,
      flipHorizontal: !!request.flipHorizontal,
      flipVertical: !!request.flipVertical,
      crop: request.crop ?? null,
      maxPixels: MAX_IMAGE_PIXELS,
      previewMaxDimension: PREVIEW_MAX_DIMENSION,
    });
    return {
      assetUri: String(r.assetUri),
      previewUri: typeof r.previewUri === 'string' ? r.previewUri : undefined,
      width: Number(r.width),
      height: Number(r.height),
    };
  } catch (err: unknown) {
    throw new ImageTransformError(err instanceof Error ? err.message : String(err), err);
  }
}

/**
 * New document whose page is the transformed image. Edits that were baked into the source
 * (see the editor) are not carried over; OCR regions are cleared because their positions no
 * longer apply (Detect Text runs again on the new image).
 */
export function applyTransformedImage(document: Document, image: TransformedImage, pageIndex = 0): Document {
  if (!(image.width > 0) || !(image.height > 0)) throw new ImageTransformError('The transformed image is invalid.');
  return updatePage(document, pageIndex, (page) => ({
    ...page,
    dimensions: { width: image.width, height: image.height },
    rotation: 0,
    originalContent: {
      ...page.originalContent,
      assetUri: image.assetUri,
      previewUri: image.previewUri,
      width: image.width,
      height: image.height,
    },
    editableTextRegions: [],
    addedText: [],
    drawings: [],
  }));
}

/** Aspect ratios offered by the crop tool (width / height; null = free). */
export const CROP_ASPECTS: readonly { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: 'Original', value: -1 },
  { label: 'Square', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
];

/** Largest rect of `aspect` centred in `bounds` (aspect = width / height). */
export function fitAspectRect(
  bounds: { x: number; y: number; width: number; height: number },
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  let w = bounds.width;
  let h = w / aspect;
  if (h > bounds.height) {
    h = bounds.height;
    w = h * aspect;
  }
  return { x: bounds.x + (bounds.width - w) / 2, y: bounds.y + (bounds.height - h) / 2, width: w, height: h };
}

/** Integer crop rect clamped to the image (min 8 px). */
export function normalizeCropRect(
  rect: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(imageWidth - 8, Math.round(rect.x)));
  const y = Math.max(0, Math.min(imageHeight - 8, Math.round(rect.y)));
  const width = Math.max(8, Math.min(imageWidth - x, Math.round(rect.width)));
  const height = Math.max(8, Math.min(imageHeight - y, Math.round(rect.height)));
  return { x, y, width, height };
}

/** Plain text of all visible OCR text (Live Text "Copy All"). Lines in reading order. */
export function collectImageText(page: DocumentPage | undefined): string {
  if (!page) return '';
  const items = (page.editableTextRegions || [])
    .filter((r) => r.status !== 'deleted')
    .map((r) => ({ text: (r.status === 'modified' ? r.currentText : r.originalText) || '', b: r.bounds }))
    .filter((r) => r.text.trim().length > 0);
  items.sort((a, b) => {
    const sameLine = Math.abs(a.b.y - b.b.y) < Math.min(a.b.height, b.b.height) * 0.5;
    return sameLine ? a.b.x - b.b.x : a.b.y - b.b.y;
  });
  return items.map((i) => i.text.trim()).join('\n');
}
