/**
 * PDF document operations beyond text editing: page tools (rotate / delete / move / insert /
 * duplicate), markup (ink, signatures, shapes, highlight / underline / strike-out, images),
 * merge, images -> PDF, full-text search, page text and thumbnails.
 *
 * All page-changing operations go through PDFium (native pie_pdf_ops.h) from the open file
 * into a NEW file; the editor turns that file into an undoable revision. Coordinates are PDF
 * display-space points (top-left origin), the same space as extracted text bounds.
 */
import { NativeModules } from 'react-native';
import {
  PdfCreateError,
  PdfDocumentOperationError,
  PdfMergeError,
  PdfOutputUnavailableError,
  PdfPasswordRequiredError,
} from '../../errors';
import { PathCommand } from '../markup/inkPath';
import { PdfPageChars, parsePageChars } from './pdfCharSelection';

function native(): any {
  return NativeModules.PdfiumNativeModule;
}

export interface PdfRectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PdfDocumentOperation =
  | { readonly type: 'rotatePage'; readonly pageIndex: number; readonly quarterTurns: number }
  | { readonly type: 'deletePage'; readonly pageIndex: number }
  | { readonly type: 'movePage'; readonly pageIndex: number; readonly toIndex: number }
  | { readonly type: 'insertBlankPage'; readonly pageIndex: number; readonly width?: number; readonly height?: number }
  | { readonly type: 'duplicatePage'; readonly pageIndex: number }
  | {
      readonly type: 'addInk';
      readonly pageIndex: number;
      readonly strokes: readonly (readonly PathCommand[])[];
      readonly color: string;
      readonly width: number;
      readonly opacity?: number;
      /** 'Multiply' for highlighter pens. */
      readonly blendMode?: 'Multiply';
    }
  | {
      readonly type: 'addShape';
      readonly pageIndex: number;
      readonly shape: 'rect' | 'ellipse' | 'line' | 'arrow';
      /** For line/arrow: start (x, y), end (x + width, y + height). */
      readonly rect: PdfRectLike;
      readonly color: string;
      readonly width: number;
      readonly opacity?: number;
      readonly fillColor?: string;
      readonly fillOpacity?: number;
    }
  | {
      readonly type: 'addHighlight';
      readonly pageIndex: number;
      readonly style: 'highlight' | 'underline' | 'strikeout';
      readonly rects: readonly PdfRectLike[];
      readonly color: string;
      readonly opacity?: number;
    }
  | { readonly type: 'addImage'; readonly pageIndex: number; readonly imagePath: string; readonly rect: PdfRectLike }
  | {
      /** One upright line of standard-14 text; (x, y) = baseline start in display points. */
      readonly type: 'addText';
      readonly pageIndex: number;
      readonly text: string;
      readonly x: number;
      readonly y: number;
      readonly fontSize: number;
      readonly fontName?: string;
      readonly color?: string;
    };

export type PdfDocumentOperationKind = 'pages' | 'markup';

/** Page tools change the page structure; everything else is markup on a page. */
export function operationKind(op: PdfDocumentOperation): PdfDocumentOperationKind {
  return op.type.startsWith('add') ? 'markup' : 'pages';
}

export interface PdfDocumentOperationsResult {
  readonly outputPath: string;
  readonly pageCountBefore: number;
  readonly pageCountAfter: number;
  readonly verified: boolean;
  readonly sourceUnchanged: boolean;
}

/** Validates operations before they reach native code (clear errors, no partial work). */
export function validateDocumentOperations(ops: readonly PdfDocumentOperation[], pageCount: number): void {
  if (ops.length === 0) throw new PdfDocumentOperationError('No operation to apply.');
  let count = pageCount;
  for (const op of ops) {
    const idx = op.pageIndex;
    if (!Number.isInteger(idx) || idx < 0) throw new PdfDocumentOperationError('Invalid page.');
    switch (op.type) {
      case 'insertBlankPage':
        if (idx > count) throw new PdfDocumentOperationError('Invalid page position.');
        count += 1;
        break;
      case 'deletePage':
        if (idx >= count) throw new PdfDocumentOperationError('Invalid page.');
        if (count <= 1) throw new PdfDocumentOperationError('A PDF must keep at least one page.');
        count -= 1;
        break;
      case 'duplicatePage':
        if (idx >= count) throw new PdfDocumentOperationError('Invalid page.');
        count += 1;
        break;
      case 'movePage':
        if (idx >= count || !Number.isInteger(op.toIndex) || op.toIndex < 0 || op.toIndex >= count) {
          throw new PdfDocumentOperationError('Invalid page position.');
        }
        break;
      case 'addInk':
        if (idx >= count) throw new PdfDocumentOperationError('Invalid page.');
        if (!op.strokes.some((s) => s.length > 0)) throw new PdfDocumentOperationError('Nothing was drawn.');
        break;
      case 'addHighlight':
        if (idx >= count) throw new PdfDocumentOperationError('Invalid page.');
        if (!op.rects.some((r) => r.width > 0 && r.height > 0)) throw new PdfDocumentOperationError('Nothing to mark.');
        break;
      default:
        if (idx >= count) throw new PdfDocumentOperationError('Invalid page.');
    }
  }
}

export function expectedPageCount(ops: readonly PdfDocumentOperation[], pageCount: number): number {
  return ops.reduce((n, op) => {
    if (op.type === 'insertBlankPage' || op.type === 'duplicatePage') return n + 1;
    if (op.type === 'deletePage') return n - 1;
    return n;
  }, pageCount);
}

function parseNativeJson(raw: unknown, ErrorType: new (m: string, c?: unknown) => Error, fallback: string): any {
  let parsed: any;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new ErrorType(`${fallback}: invalid native response`, err);
  }
  if (!parsed || parsed.success !== true) {
    const code = parsed?.errorCode as string | undefined;
    const message = (parsed?.errorMessage as string | undefined) || fallback;
    if (code === 'PDF_PASSWORD_REQUIRED') throw new PdfPasswordRequiredError(message);
    throw new ErrorType(message);
  }
  return parsed;
}

/** Runs operations from `inputPath` into the new file `outputPath` (native, verified). */
export async function runDocumentOperations(
  inputPath: string,
  outputPath: string,
  ops: readonly PdfDocumentOperation[],
): Promise<PdfDocumentOperationsResult> {
  const mod = native();
  if (!mod || typeof mod.applyDocumentOperations !== 'function') {
    throw new PdfOutputUnavailableError('Page tools are not available on this platform.');
  }
  if (!inputPath || !outputPath || inputPath === outputPath) {
    throw new PdfDocumentOperationError('Invalid input or output file.');
  }
  let raw: unknown;
  try {
    raw = await mod.applyDocumentOperations(inputPath, outputPath, JSON.stringify({ operations: ops }));
  } catch (err: unknown) {
    throw new PdfDocumentOperationError(err instanceof Error ? err.message : String(err), err);
  }
  const parsed = parseNativeJson(raw, PdfDocumentOperationError, 'The change could not be applied');
  if (parsed.verified !== true || parsed.sourceUnchanged !== true) {
    throw new PdfDocumentOperationError('The changed PDF could not be verified.');
  }
  return {
    outputPath: String(parsed.outputPath ?? outputPath),
    pageCountBefore: Number(parsed.pageCountBefore ?? 0),
    pageCountAfter: Number(parsed.pageCountAfter ?? 0),
    verified: true,
    sourceUnchanged: true,
  };
}

export async function mergePdfFiles(inputPaths: readonly string[], outputPath: string): Promise<{ pageCount: number }> {
  const mod = native();
  if (!mod || typeof mod.mergeDocuments !== 'function') {
    throw new PdfOutputUnavailableError('Merging PDFs is not available on this platform.');
  }
  if (inputPaths.length < 2) throw new PdfMergeError('Choose at least two PDFs to merge.');
  let raw: unknown;
  try {
    raw = await mod.mergeDocuments([...inputPaths], outputPath);
  } catch (err: unknown) {
    throw new PdfMergeError(err instanceof Error ? err.message : String(err), err);
  }
  const parsed = parseNativeJson(raw, PdfMergeError, 'The PDFs could not be merged');
  return { pageCount: Number(parsed.pageCount ?? 0) };
}

export type ImagePdfPageSize = 'fit' | 'a4' | 'letter';

export async function createPdfFromImageFiles(
  imageUris: readonly string[],
  outputPath: string,
  pageSize: ImagePdfPageSize = 'fit',
  margin = 0,
): Promise<{ pageCount: number }> {
  const mod = native();
  if (!mod || typeof mod.createPdfFromImages !== 'function') {
    throw new PdfOutputUnavailableError('Creating PDFs is not available on this platform.');
  }
  if (imageUris.length === 0) throw new PdfCreateError('Choose at least one image.');
  let raw: unknown;
  try {
    raw = await mod.createPdfFromImages([...imageUris], outputPath, pageSize, margin);
  } catch (err: unknown) {
    throw new PdfCreateError(err instanceof Error ? err.message : String(err), err);
  }
  const parsed = parseNativeJson(raw, PdfCreateError, 'The PDF could not be created');
  return { pageCount: Number(parsed.pageCount ?? 0) };
}

/** Converts an image (photo, signature render) into a JPEG that PDFium can embed. */
export async function prepareImageForPdf(imageUri: string): Promise<{ path: string; width: number; height: number }> {
  const mod = native();
  if (!mod || typeof mod.prepareImageForPdf !== 'function') {
    throw new PdfOutputUnavailableError('Adding images is not available on this platform.');
  }
  const r = await mod.prepareImageForPdf(imageUri);
  return { path: String(r.path), width: Number(r.width), height: Number(r.height) };
}

export async function pickPdfFiles(): Promise<{ filePath: string; fileName: string }[]> {
  const mod = native();
  if (!mod || typeof mod.pickPdfDocuments !== 'function') return [];
  const list = (await mod.pickPdfDocuments()) as any[];
  return (list || []).map((p) => ({ filePath: String(p.filePath), fileName: String(p.fileName) }));
}

// ---------------------------------------------------------------------------
// Search & text
// ---------------------------------------------------------------------------

export interface PdfSearchResult {
  readonly pageIndex: number;
  readonly charIndex: number;
  readonly snippet: string;
  readonly matchStart: number;
  readonly matchLength: number;
  readonly rects: readonly PdfRectLike[];
}

export interface PdfSearchResponse {
  readonly results: readonly PdfSearchResult[];
  readonly truncated: boolean;
}

export const PDF_SEARCH_MAX_RESULTS = 500;

/** Normalizes the native search JSON (defensive: malformed entries are dropped). */
export function parseSearchResponse(raw: unknown): PdfSearchResponse {
  let parsed: any;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { results: [], truncated: false };
  }
  const results: PdfSearchResult[] = [];
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    if (!Number.isInteger(r?.pageIndex) || r.pageIndex < 0) continue;
    const rects: PdfRectLike[] = (Array.isArray(r.rects) ? r.rects : [])
      .map((x: any) => ({ x: Number(x.x), y: Number(x.y), width: Number(x.width), height: Number(x.height) }))
      .filter((x: PdfRectLike) => [x.x, x.y, x.width, x.height].every(Number.isFinite) && x.width >= 0 && x.height >= 0);
    results.push({
      pageIndex: r.pageIndex,
      charIndex: Number(r.charIndex) || 0,
      snippet: typeof r.snippet === 'string' ? r.snippet.replace(/\s+/g, ' ') : '',
      matchStart: Math.max(0, Number(r.matchStart) || 0),
      matchLength: Math.max(0, Number(r.matchLength) || 0),
      rects,
    });
  }
  return { results, truncated: parsed?.truncated === true };
}

export async function searchPdf(docHandle: number, query: string): Promise<PdfSearchResponse> {
  const q = query.trim();
  const mod = native();
  if (!q || !mod || typeof mod.searchText !== 'function') return { results: [], truncated: false };
  return parseSearchResponse(await mod.searchText(docHandle, q, PDF_SEARCH_MAX_RESULTS));
}

/** Characters of a page for character-level selection; null when unavailable. */
export async function getPdfPageChars(docHandle: number, pageIndex: number): Promise<PdfPageChars | null> {
  const mod = native();
  if (!mod || typeof mod.getPageChars !== 'function') return null;
  try {
    return parsePageChars(await mod.getPageChars(docHandle, pageIndex));
  } catch {
    return null;
  }
}

export async function getPdfPageText(docHandle: number, pageIndex: number): Promise<string> {
  const mod = native();
  if (!mod || typeof mod.getPageText !== 'function') return '';
  try {
    const parsed = JSON.parse(await mod.getPageText(docHandle, pageIndex));
    return typeof parsed?.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

export interface PdfThumbnail {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly pageIndex: number;
}

export async function renderPdfThumbnail(docHandle: number, pageIndex: number, maxPixels = 240): Promise<PdfThumbnail | null> {
  const mod = native();
  if (!mod || typeof mod.renderThumbnail !== 'function') return null;
  try {
    const r = await mod.renderThumbnail(docHandle, pageIndex, maxPixels);
    return { uri: String(r.uri), width: Number(r.width), height: Number(r.height), pageIndex };
  } catch {
    return null;
  }
}

export async function purgePdfThumbnails(): Promise<void> {
  const mod = native();
  if (mod && typeof mod.purgeThumbnailCache === 'function') {
    await mod.purgeThumbnailCache().catch(() => 0);
  }
}

/** Renders page 1 of a PDF file into `outputPath` (library thumbnail). */
export async function renderPdfFileThumbnail(
  pdfPath: string,
  outputPath: string,
  maxPixels = 480,
): Promise<{ uri: string; pageCount: number } | null> {
  const mod = native();
  if (!mod || typeof mod.renderFileThumbnail !== 'function') return null;
  try {
    const r = await mod.renderFileThumbnail(pdfPath, outputPath, maxPixels);
    return { uri: String(r.uri), pageCount: Number(r.pageCount) || 0 };
  } catch {
    return null;
  }
}
