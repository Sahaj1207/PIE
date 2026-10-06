import { NativeModules, Platform } from 'react-native';
import {
  PdfColorRgba,
  PdfDocumentHandle,
  PdfPageSize,
  PdfRawBounds,
  PdfRect,
  PdfRenderedPage,
  PdfRenderOptions,
  PdfReplacementPreservedProperties,
  PdfTextObject,
  PdfTextReplacementRequest,
  PdfTextReplacementResult,
  PdfTransformationMatrix,
  IPdfiumEngine,
  PdfBatchEditRequest,
  PdfMultiEditResult,
  IPdfDocumentEditor,
  PdfShareResult,
  PdfUserLocationCopy,
  PdfRenderedRegion,
} from './types';
import { normalizeRotation } from './pdfPageGeometry';
import {
  NATIVE_UNSUPPORTED_GLYPHS_PREFIX,
  unsupportedGlyphsErrorFromNative,
} from './pdfGlyphCoverage';
import {
  PdfCorruptedError,
  PdfEngineNotLinkedError,
  PdfFileNotFoundError,
  PdfPageOutOfRangeError,
  PdfPasswordRequiredError,
  PdfRenderError,
  PdfTextExtractionError,
  PdfTextReplacementError,
  PdfBatchEditError,
  PdfInvalidObjectIdError,
  PdfInvalidReplacementError,
  PdfFontLimitationError,
  PdfInvalidObjectPathError,
  PdfDocumentNotOpenError,
  PdfUnsupportedReplacementError,
  PdfSaveError,
  PdfSaveAsError,
  PdfSecurityUnsupportedError,
  PdfShareError,
  PdfOutputUnavailableError,
  PdfUnsupportedGlyphsError,
  AppError,
} from '../../errors';
import { PdfDocumentEditor } from './pdfDocumentEditor';
import {
  PdfDocumentOperation,
  PdfDocumentOperationsResult,
  runDocumentOperations,
} from './pdfDocumentOperations';

/**
 * Document URIs the platform share / save pickers may return. Android exposes only
 * content:// URIs. iOS uses file:// URLs: a shared PDF must be the sandboxed share copy
 * (Caches/pdf_exports), and a "Save a Copy" destination must lie outside the app's own
 * document store. App-private document paths are never accepted.
 */
export function isPlatformDocumentUri(uri: string, purpose: 'share' | 'save', os: string = Platform.OS): boolean {
  if (uri.startsWith('content://')) return true;
  if (os !== 'ios' || !uri.startsWith('file://')) return false;
  const decoded = (() => {
    try {
      return decodeURI(uri);
    } catch {
      return uri;
    }
  })();
  if (purpose === 'share') return decoded.includes('/Caches/pdf_exports/');
  return !decoded.includes('/Application Support/pie/');
}

function getNativeModule() {
  return NativeModules.PdfiumNativeModule;
}

export interface RawNativePdfFontDetails {
  baseFontName?: string | null;
  familyName?: string | null;
  isEmbedded?: boolean;
  isSubset?: boolean;
  weight?: number | null;
  flags?: number | null;
}

export interface RawNativePdfTextObject {
  id: string;
  pageIndex: number;
  objectIndex: number;
  objectPath?: number[];
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  pdfBounds: { left: number; bottom: number; right: number; top: number };
  fontSize?: number | null;
  fontName?: string | null;
  fontDetails?: RawNativePdfFontDetails | null;
  color?: string | null;
  colorRgba?: { r: number; g: number; b: number; a: number } | null;
  matrix?: { a: number; b: number; c: number; d: number; e: number; f: number } | null;
  isEditable?: boolean;
}

/**
 * Coordinate Normalization Helpers
 *
 * Converts between PDF user space (origin at bottom-left, Y pointing upward)
 * and document coordinate space (origin at top-left, Y pointing downward).
 */
export function pdfToDocumentRect(raw: PdfRawBounds, pageHeight: number): PdfRect {
  const left = Math.min(raw.left, raw.right);
  const right = Math.max(raw.left, raw.right);
  const bottom = Math.min(raw.bottom, raw.top);
  const top = Math.max(raw.bottom, raw.top);

  return {
    x: left,
    y: pageHeight - top,
    width: right - left,
    height: top - bottom,
  };
}

export function documentToPdfBounds(rect: PdfRect, pageHeight: number): PdfRawBounds {
  return {
    left: rect.x,
    bottom: pageHeight - (rect.y + rect.height),
    right: rect.x + rect.width,
    top: pageHeight - rect.y,
  };
}

export function documentToScreenRect(
  rect: PdfRect,
  scaleX: number,
  scaleY: number,
): PdfRect {
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

export function screenToDocumentPoint(
  screenX: number,
  screenY: number,
  scaleX: number,
  scaleY: number,
): { x: number; y: number } {
  const sx = scaleX === 0 ? 1 : scaleX;
  const sy = scaleY === 0 ? 1 : scaleY;
  return {
    x: screenX / sx,
    y: screenY / sy,
  };
}

/**
 * Deterministic hit-testing for PDF vector text objects.
 * When bounding boxes overlap, prefers the smallest / highest-specificity matching
 * text object rather than arbitrarily selecting the first object encountered.
 */
export function hitTestTextObjects(
  objects: readonly PdfTextObject[],
  point: { x: number; y: number },
  padding = 4,
): PdfTextObject | null {
  const area = (o: PdfTextObject) => Math.max(0, o.bounds.width) * Math.max(0, o.bounds.height);
  const depth = (o: PdfTextObject) => (o.objectPath ? o.objectPath.length : 1);
  const centerDistance = (o: PdfTextObject) =>
    (point.x - (o.bounds.x + o.bounds.width / 2)) ** 2 + (point.y - (o.bounds.y + o.bounds.height / 2)) ** 2;
  const edgeDistance = (o: PdfTextObject) => {
    const { x, y, width, height } = o.bounds;
    const dx = Math.max(x - point.x, 0, point.x - (x + width));
    const dy = Math.max(y - point.y, 0, point.y - (y + height));
    return Math.sqrt(dx * dx + dy * dy);
  };
  /** Tap lies within the object's vertical extent (same text line). */
  const onSameLine = (o: PdfTextObject) => point.y >= o.bounds.y && point.y <= o.bounds.y + o.bounds.height;

  // Tier 1: objects that contain the point.
  //  - Nested boxes (one lies essentially inside the other: a word inside a paragraph box, or
  //    identical boxes from Form XObjects): smallest area (most specific), then deepest nesting.
  //  - Partially overlapping neighbours (adjacent lines / table cells whose ascender-descender
  //    boxes overlap): the text whose centre line is nearer the finger, so a tap on a line edge
  //    never jumps to the neighbouring line just because it is smaller.
  const containing = objects.filter((o) => edgeDistance(o) === 0);
  if (containing.length > 0) {
    const overlapArea = (a: PdfTextObject, b: PdfTextObject) => {
      const w = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x);
      const h = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - Math.max(a.bounds.y, b.bounds.y);
      return w > 0 && h > 0 ? w * h : 0;
    };
    const nested = (a: PdfTextObject, b: PdfTextObject) => {
      const overlap = overlapArea(a, b);
      const smaller = Math.min(area(a), area(b));
      return smaller <= 0 || overlap >= smaller * 0.9;
    };
    /** Vertical distance from the tap to the box's centre line, in units of its height. */
    const centreOffset = (o: PdfTextObject) =>
      Math.abs(point.y - (o.bounds.y + o.bounds.height / 2)) / Math.max(1, o.bounds.height);
    const better = (a: PdfTextObject, b: PdfTextObject): boolean => {
      if (!nested(a, b)) {
        const delta = centreOffset(a) - centreOffset(b);
        if (Math.abs(delta) > 0.05) return delta < 0;
      }
      const areaDelta = area(a) - area(b);
      if (Math.abs(areaDelta) > 0.01) return areaDelta < 0;
      if (depth(a) !== depth(b)) return depth(a) > depth(b);
      return centerDistance(a) < centerDistance(b);
    };
    return containing.reduce((best, candidate) => (better(candidate, best) ? candidate : best));
  }

  // Tier 2: forgiving touch target — the NEAREST object (edge distance) within `padding`.
  // A neighbouring line is never preferred just because it is smaller; ties favour the
  // object on the tapped line, then the more specific one.
  const nearby = objects
    .map((o) => ({ o, d: edgeDistance(o) }))
    .filter((c) => c.d <= padding);
  if (nearby.length === 0) return null;
  nearby.sort((a, b) => {
    if (Math.abs(a.d - b.d) > 0.5) return a.d - b.d;
    const lineA = onSameLine(a.o) ? 0 : 1;
    const lineB = onSameLine(b.o) ? 0 : 1;
    if (lineA !== lineB) return lineA - lineB;
    const areaDelta = area(a.o) - area(b.o);
    if (Math.abs(areaDelta) > 0.01) return areaDelta;
    return depth(b.o) - depth(a.o);
  });
  return nearby[0].o;
}

/** Finger-sized PDF tap tolerance (screen points), converted per zoom by pdfTapToleranceDocPoints. */
export const PDF_TAP_TOLERANCE_PT = 20;

/**
 * Tap tolerance in PDF document points for the current on-screen scale (fit scale x zoom):
 * a constant finger-sized target on screen at every zoom level.
 */
export function pdfTapToleranceDocPoints(baseScale: number, zoom: number): number {
  const screenPerDoc = (baseScale > 0 ? baseScale : 1) * (zoom > 0 ? zoom : 1);
  return PDF_TAP_TOLERANCE_PT / screenPerDoc;
}

/**
 * Maps a native `{ success: false, errorCode, errorMessage }` response to a typed error.
 * The C++ bridge returns these as resolved JSON strings (not promise rejections).
 */
export function nativeFailureToError(errorCode: string, errorMessage: string): Error {
  const msg = errorMessage || `Native PDF operation failed (${errorCode || 'UNKNOWN'})`;
  if (errorCode === 'UNSUPPORTED_GLYPHS') {
    return (
      unsupportedGlyphsErrorFromNative(msg) ??
      new PdfUnsupportedGlyphsError(msg.replace(NATIVE_UNSUPPORTED_GLYPHS_PREFIX, ''))
    );
  }
  switch (errorCode) {
    case 'PDF_FILE_NOT_FOUND':
      return new PdfFileNotFoundError(msg);
    case 'PDF_PAGE_OUT_OF_RANGE':
    case 'PDF_PAGE_LOAD_FAILED':
      return new PdfPageOutOfRangeError(msg);
    case 'PDF_OPEN_FAILED':
    case 'REOPEN_FAILED':
    case 'REOPEN_PAGE_FAILED':
      return new PdfCorruptedError(msg);
    case 'PDF_SAVE_FAILED':
    case 'OUTPUT_FILE_CREATE_FAILED':
    case 'GENERATE_CONTENT_FAILED':
      return new PdfSaveError(msg);
    case 'EMPTY_REPLACEMENT':
      return new PdfInvalidReplacementError(msg);
    case 'NOT_A_TEXT_OBJECT':
      return new PdfUnsupportedReplacementError(msg);
    case 'PDF_OBJECT_OUT_OF_RANGE':
    case 'PDF_OBJECT_NULL':
      return new PdfInvalidObjectIdError(msg);
    case 'TEXT_REPLACE_FAILED':
      return new PdfTextReplacementError(msg);
    default:
      return new PdfBatchEditError(msg);
  }
}

function toCommandType(value: unknown): 'replace' | 'delete' | 'insert' {
  return value === 'delete' || value === 'insert' ? value : 'replace';
}

/**
 * Canonical normalization of a native batch-edit response into PdfMultiEditResult.
 *
 * Accepts the REAL shape emitted by pdfium_bridge.cpp (nativeApplyBatchEditsJson):
 *   { success, inputPath, outputPath, commandsApplied, sourceUnchanged,
 *     sourceShaBefore, sourceShaAfter, pageCountBefore, pageCountAfter,
 *     commandResults: [{ type, objectId, pageIndex, objectIndex, originalText, newText,
 *                        applied, verifiedInReopened, fontStrategy, fontReused, error }] }
 * and the legacy TS shape ({ commands: [{ status }], reopenedVerification, limitations })
 * used by earlier test fixtures.
 *
 * Throws a typed error when the native layer reports `success: false`. A command is only
 * ever 'applied' when the native layer says so; unknown/absent status is never success.
 */
export function normalizeNativeBatchResult(
  raw: unknown,
  request: { readonly outputPdfPath: string; readonly commandCount: number },
): PdfMultiEditResult {
  if (!raw || typeof raw !== 'object') {
    throw new PdfBatchEditError('Native batch edit returned an empty or invalid response.');
  }
  const parsed = raw as Record<string, any>;

  if (parsed.success === false) {
    throw nativeFailureToError(String(parsed.errorCode ?? ''), String(parsed.errorMessage ?? ''));
  }

  const isNativeShape = Array.isArray(parsed.commandResults);

  if (isNativeShape) {
    const commands = (parsed.commandResults as any[]).map((c) => {
      const applied = c?.applied === true;
      const error = typeof c?.error === 'string' && c.error.length > 0 ? c.error : undefined;
      return {
        type: toCommandType(c?.type),
        objectId: String(c?.objectId ?? ''),
        pageIndex: Number(c?.pageIndex ?? 0),
        objectIndex: Number(c?.objectIndex ?? 0),
        status: (applied ? 'applied' : 'failed') as 'applied' | 'failed',
        originalText: c?.originalText ? String(c.originalText) : undefined,
        newText: c?.newText ? String(c.newText) : undefined,
        fontReused: c?.fontReused !== undefined ? Boolean(c.fontReused) : undefined,
        fontStrategy: c?.fontStrategy ? String(c.fontStrategy) : undefined,
        error: applied ? undefined : error ?? 'Native command was not applied.',
        verifiedInReopened: c?.verifiedInReopened === true,
        verificationError:
          typeof c?.verificationError === 'string' && c.verificationError.length > 0
            ? c.verificationError
            : undefined,
      };
    });

    const appliedEdits = commands.filter((c) => c.status === 'applied');
    const appliedWrites = appliedEdits.filter((c) => c.type === 'replace' || c.type === 'insert');
    const appliedDeletes = appliedEdits.filter((c) => c.type === 'delete');
    const appliedInserts = appliedEdits.filter((c) => c.type === 'insert');

    return {
      outputPath: String(parsed.outputPath ?? request.outputPdfPath),
      totalCommands: commands.length,
      appliedCommands: appliedEdits.length,
      pageCountBefore: Number(parsed.pageCountBefore ?? 0),
      pageCountAfter: Number(parsed.pageCountAfter ?? 0),
      sourceUnchanged: parsed.sourceUnchanged === true,
      sourceChecksumBefore: String(parsed.sourceShaBefore ?? parsed.sourceChecksumBefore ?? ''),
      sourceChecksumAfter: String(parsed.sourceShaAfter ?? parsed.sourceChecksumAfter ?? ''),
      commands,
      reopenedVerification: {
        allReplacementsVerified: appliedWrites.every((c) => c.verifiedInReopened),
        allDeletionsVerified: appliedDeletes.every((c) => c.verifiedInReopened),
        allInsertionsVerified: appliedInserts.every((c) => c.verifiedInReopened),
        verifiedReplacements: appliedWrites
          .filter((c) => c.verifiedInReopened)
          .map((c) => c.newText ?? ''),
        missingReplacements: appliedWrites.filter((c) => !c.verifiedInReopened).map((c) => c.objectId),
        residualDeletions: appliedDeletes.filter((c) => !c.verifiedInReopened).map((c) => c.objectId),
      },
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations.map(String) : [],
    };
  }

  // Legacy TS-shaped response (pre-Phase-11 fixtures).
  return {
    outputPath: String(parsed.outputPath ?? request.outputPdfPath),
    totalCommands: Number(parsed.totalCommands ?? request.commandCount),
    appliedCommands: Number(parsed.appliedCommands ?? 0),
    pageCountBefore: Number(parsed.pageCountBefore ?? 0),
    pageCountAfter: Number(parsed.pageCountAfter ?? 0),
    sourceUnchanged: Boolean(parsed.sourceUnchanged),
    sourceChecksumBefore: String(parsed.sourceChecksumBefore ?? parsed.sourceShaBefore ?? ''),
    sourceChecksumAfter: String(parsed.sourceChecksumAfter ?? parsed.sourceShaAfter ?? ''),
    commands: Array.isArray(parsed.commands)
      ? parsed.commands.map((c: any) => {
          const applied = c?.status === 'applied';
          return {
            type: toCommandType(c?.type),
            objectId: String(c?.objectId),
            pageIndex: Number(c?.pageIndex),
            objectIndex: Number(c?.objectIndex),
            status: (applied ? 'applied' : 'failed') as 'applied' | 'failed',
            originalText: c?.originalText ? String(c.originalText) : undefined,
            newText: c?.newText ? String(c.newText) : undefined,
            fontReused: c?.fontReused !== undefined ? Boolean(c.fontReused) : undefined,
            fontStrategy: c?.fontStrategy ? String(c.fontStrategy) : undefined,
            error: c?.error
              ? String(c.error)
              : applied
              ? undefined
              : 'Native command was not applied.',
          };
        })
      : [],
    reopenedVerification: {
      allReplacementsVerified: Boolean(parsed.reopenedVerification?.allReplacementsVerified),
      allDeletionsVerified: Boolean(parsed.reopenedVerification?.allDeletionsVerified),
      verifiedReplacements: Array.isArray(parsed.reopenedVerification?.verifiedReplacements)
        ? parsed.reopenedVerification.verifiedReplacements.map(String)
        : [],
      missingReplacements: Array.isArray(parsed.reopenedVerification?.missingReplacements)
        ? parsed.reopenedVerification.missingReplacements.map(String)
        : [],
      residualDeletions: Array.isArray(parsed.reopenedVerification?.residualDeletions)
        ? parsed.reopenedVerification.residualDeletions.map(String)
        : [],
    },
    limitations: Array.isArray(parsed.limitations) ? parsed.limitations.map(String) : [],
  };
}

function mapNativeError(err: unknown, defaultMessage: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code || '';

  if (
    code === 'PDF_DOC_NOT_OPEN' ||
    message.toLowerCase().includes('document not open') ||
    message.toLowerCase().includes('document is not open') ||
    message.toLowerCase().includes('no pdf document is currently open')
  ) {
    return new PdfDocumentNotOpenError(message, err);
  }
  if (code === 'PDF_FILE_NOT_FOUND' || message.includes('not found') || message.includes('File not found')) {
    return new PdfFileNotFoundError(message, err);
  }
  if (code === 'PDF_FORMAT_CORRUPT' || message.includes('Corrupted') || message.includes('format')) {
    return new PdfCorruptedError(message, err);
  }
  if (code === 'PDF_PASSWORD_REQUIRED' || message.includes('Password required')) {
    return new PdfPasswordRequiredError(message, err);
  }
  if (code === 'PDF_SECURITY_UNSUPPORTED' || message.includes('Unsupported security scheme')) {
    return new PdfSecurityUnsupportedError(message, err);
  }
  if (code === 'PDF_PAGE_NOT_FOUND' || code === 'PDF_PAGE_ERROR' || message.includes('out of range')) {
    return new PdfPageOutOfRangeError(message, err);
  }
  if (code === 'PDF_RENDER_FAILED' || message.includes('rendering failed')) {
    return new PdfRenderError(message, err);
  }
  if (code === 'PDF_TEXT_EXTRACTION_ERROR' || message.includes('extract text')) {
    return new PdfTextExtractionError(message, err);
  }
  if (
    code === 'PDF_INVALID_OBJECT_PATH' ||
    message.toLowerCase().includes('object locator path') ||
    message.toLowerCase().includes('invalid object path') ||
    message.toLowerCase().includes('path could not be resolved')
  ) {
    return new PdfInvalidObjectPathError(message, err);
  }
  if (
    code === 'PDF_FONT_LIMITATION' ||
    message.toLowerCase().includes('font limitation') ||
    message.toLowerCase().includes('glyph') ||
    message.toLowerCase().includes('original font')
  ) {
    return new PdfFontLimitationError(message, err);
  }
  if (
    code === 'PDF_UNSUPPORTED_REPLACEMENT' ||
    message.toLowerCase().includes('unsupported replacement') ||
    message.toLowerCase().includes('not an editable vector text')
  ) {
    return new PdfUnsupportedReplacementError(message, err);
  }
  if (
    code === 'PDF_EMPTY_REPLACEMENT' ||
    message.toLowerCase().includes('replacement text cannot be empty') ||
    message.toLowerCase().includes('empty replacement')
  ) {
    return new PdfInvalidReplacementError(message, err);
  }
  if (
    code === 'PDF_INVALID_OBJECT_ID' ||
    message.toLowerCase().includes('unknown text object id') ||
    message.toLowerCase().includes('unknown object id') ||
    message.toLowerCase().includes('object no longer exists')
  ) {
    return new PdfInvalidObjectIdError(message, err);
  }
  if (
    code === 'PDF_TEXT_REPLACEMENT_ERROR' ||
    code === 'PDF_REPLACEMENT_ERROR' ||
    message.includes('replacement failed') ||
    message.includes('replace text') ||
    message.includes('Target object is not a text object') ||
    message.includes('Object index out of bounds')
  ) {
    return new PdfTextReplacementError(message, err);
  }
  if (code === 'PDF_BATCH_EDIT_ERROR' || message.includes('batch edit')) {
    return new PdfBatchEditError(message, err);
  }

  return new Error(`${defaultMessage}: ${message}`);
}

export class PdfiumEngine implements IPdfiumEngine {
  private ensureNativeModule() {
    if (!getNativeModule()) {
      throw new PdfEngineNotLinkedError(
        `PdfiumNativeModule is not linked on platform: ${Platform.OS}. Ensure native CMake and JNI modules are compiled.`,
      );
    }
  }

  async openDocument(filePath: string, password?: string): Promise<PdfDocumentHandle> {
    this.ensureNativeModule();
    if (!filePath || filePath.trim().length === 0) {
      throw new PdfFileNotFoundError('File path cannot be empty');
    }

    try {
      const result = await getNativeModule().openDocument(filePath, password ?? null);
      return {
        docHandle: Number(result.docHandle),
        pageCount: Number(result.pageCount),
        filePath: String(result.filePath),
        ...(typeof result.fileSizeBytes === 'number' && result.fileSizeBytes >= 0
          ? { fileSizeBytes: Number(result.fileSizeBytes) }
          : {}),
      };
    } catch (err: unknown) {
      throw mapNativeError(err, 'Failed to open PDF document');
    }
  }

  async closeDocument(docHandle: number): Promise<boolean> {
    this.ensureNativeModule();
    try {
      const ok = await getNativeModule().closeDocument(docHandle);
      return Boolean(ok);
    } catch (err: unknown) {
      throw mapNativeError(err, 'Failed to close PDF document');
    }
  }

  async getPageCount(docHandle: number): Promise<number> {
    this.ensureNativeModule();
    try {
      const count = await getNativeModule().getPageCount(docHandle);
      return Number(count);
    } catch (err: unknown) {
      throw mapNativeError(err, 'Failed to get page count');
    }
  }

  async getPageSize(docHandle: number, pageIndex: number): Promise<PdfPageSize> {
    this.ensureNativeModule();
    if (pageIndex < 0) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} cannot be negative`);
    }

    try {
      const result = await getNativeModule().getPageSize(docHandle, pageIndex);
      const m = result.displayMatrix;
      const hasMatrix =
        m && ['a', 'b', 'c', 'd', 'e', 'f'].every((k) => Number.isFinite(Number(m[k])));
      return {
        pageIndex: Number(result.pageIndex),
        width: Number(result.width),
        height: Number(result.height),
        // Phase 15: rotation / user->display mapping as PDFium renders the page (when known)
        ...(result.rotation !== undefined && result.rotation !== null
          ? { rotation: normalizeRotation(result.rotation) }
          : {}),
        ...(hasMatrix
          ? {
              displayMatrix: {
                a: Number(m.a),
                b: Number(m.b),
                c: Number(m.c),
                d: Number(m.d),
                e: Number(m.e),
                f: Number(m.f),
              },
            }
          : {}),
      };
    } catch (err: unknown) {
      throw mapNativeError(err, `Failed to get page size for page ${pageIndex}`);
    }
  }

  async renderPage(
    docHandle: number,
    pageIndex: number,
    options?: PdfRenderOptions,
  ): Promise<PdfRenderedPage> {
    this.ensureNativeModule();
    if (pageIndex < 0) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} cannot be negative`);
    }

    const scale = options?.scale ?? 1.5;
    try {
      const result = await getNativeModule().renderPage(docHandle, pageIndex, scale);
      return {
        filePath: String(result.filePath),
        uri: String(result.uri),
        width: Number(result.width),
        height: Number(result.height),
        pageWidth: Number(result.pageWidth),
        pageHeight: Number(result.pageHeight),
        scale: Number(result.scale),
        pageIndex: Number(result.pageIndex),
      };
    } catch (err: unknown) {
      throw mapNativeError(err, `Failed to render page ${pageIndex}`);
    }
  }

  /**
   * Renders a display-space region of a page at `scale` pixels per point (zoom detail).
   * Same PDFium page transform as renderPage, so it lines up with the full-page render.
   */
  async renderPageRegion(
    docHandle: number,
    pageIndex: number,
    scale: number,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<PdfRenderedRegion> {
    this.ensureNativeModule();
    const native = getNativeModule();
    if (typeof native.renderPageRegion !== 'function') {
      throw new PdfRenderError('Region rendering is not available on this platform.');
    }
    if (pageIndex < 0) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} cannot be negative`);
    }
    if (!(scale > 0) || !(rect.width > 0) || !(rect.height > 0)) {
      throw new PdfRenderError('Invalid region render request.');
    }
    try {
      const result = await native.renderPageRegion(docHandle, pageIndex, scale, rect.x, rect.y, rect.width, rect.height);
      return {
        filePath: String(result.filePath),
        uri: String(result.uri),
        width: Number(result.width),
        height: Number(result.height),
        scale: Number(result.scale),
        pageIndex: Number(result.pageIndex),
        rect: {
          x: Number(result.left),
          y: Number(result.top),
          width: Number(result.regionWidth),
          height: Number(result.regionHeight),
        },
      };
    } catch (err: unknown) {
      throw mapNativeError(err, `Failed to render a region of page ${pageIndex}`);
    }
  }

  async getTextObjects(docHandle: number, pageIndex: number): Promise<PdfTextObject[]> {
    this.ensureNativeModule();
    if (pageIndex < 0) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} cannot be negative`);
    }

    try {
      const jsonStr: string = await getNativeModule().getTextObjects(docHandle, pageIndex);
      const parsed: RawNativePdfTextObject[] = JSON.parse(jsonStr || '[]');

      return parsed.map((raw) => ({
        id: raw.id,
        pageIndex: raw.pageIndex,
        objectIndex: raw.objectIndex,
        objectPath: Array.isArray(raw.objectPath)
          ? raw.objectPath.map(Number)
          : undefined,
        text: raw.text,
        bounds: {
          x: raw.bounds.x,
          y: raw.bounds.y,
          width: raw.bounds.width,
          height: raw.bounds.height,
        },
        pdfBounds: {
          left: raw.pdfBounds.left,
          bottom: raw.pdfBounds.bottom,
          right: raw.pdfBounds.right,
          top: raw.pdfBounds.top,
        },
        fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : null,
        fontName: typeof raw.fontName === 'string' && raw.fontName.length > 0 ? raw.fontName : null,
        fontDetails: raw.fontDetails
          ? {
              baseFontName: raw.fontDetails.baseFontName ?? null,
              familyName: raw.fontDetails.familyName ?? null,
              isEmbedded: Boolean(raw.fontDetails.isEmbedded),
              isSubset: Boolean(raw.fontDetails.isSubset),
              weight: typeof raw.fontDetails.weight === 'number' ? raw.fontDetails.weight : null,
              flags: typeof raw.fontDetails.flags === 'number' ? raw.fontDetails.flags : null,
            }
          : null,
        color: typeof raw.color === 'string' && raw.color.length > 0 ? raw.color : null,
        colorRgba: raw.colorRgba
          ? {
              r: raw.colorRgba.r,
              g: raw.colorRgba.g,
              b: raw.colorRgba.b,
              a: raw.colorRgba.a,
            }
          : null,
        matrix: raw.matrix
          ? {
              a: raw.matrix.a,
              b: raw.matrix.b,
              c: raw.matrix.c,
              d: raw.matrix.d,
              e: raw.matrix.e,
              f: raw.matrix.f,
            }
          : null,
        isEditable: raw.isEditable !== undefined ? Boolean(raw.isEditable) : true,
      }));
    } catch (err: unknown) {
      throw mapNativeError(err, `Failed to extract text objects for page ${pageIndex}`);
    }
  }

  async pickPdfDocument(): Promise<{ filePath: string; fileName: string; fileSize: number } | null> {
    this.ensureNativeModule();
    try {
      const res = await getNativeModule().pickPdfDocument();
      if (!res) return null;
      return {
        filePath: String(res.filePath),
        fileName: String(res.fileName || 'Document.pdf'),
        fileSize: Number(res.fileSize || 0),
      };
    } catch (err: unknown) {
      throw mapNativeError(err, 'Failed to pick PDF document');
    }
  }

  async extractAssetPdf(assetName: string): Promise<string> {
    this.ensureNativeModule();
    try {
      const path = await getNativeModule().extractAssetPdf(assetName);
      return String(path);
    } catch (err: unknown) {
      throw mapNativeError(err, `Failed to extract bundled PDF asset ${assetName}`);
    }
  }

  async replaceTextObject(
    request: PdfTextReplacementRequest,
  ): Promise<PdfTextReplacementResult> {
    this.ensureNativeModule();

    if (!request.inputPdfPath || request.inputPdfPath.trim().length === 0) {
      throw new PdfFileNotFoundError('Input PDF path cannot be empty');
    }
    if (!request.outputPdfPath || request.outputPdfPath.trim().length === 0) {
      throw new PdfTextReplacementError('Output PDF path cannot be empty');
    }
    if (request.inputPdfPath.trim() === request.outputPdfPath.trim()) {
      throw new PdfTextReplacementError('Output path must be separate from input path to ensure source immutability');
    }
    if (typeof request.pageIndex !== 'number' || request.pageIndex < 0) {
      throw new PdfPageOutOfRangeError(`Page index ${request.pageIndex} cannot be negative`);
    }
    if (typeof request.objectIndex !== 'number' || request.objectIndex < 0) {
      throw new PdfTextReplacementError(`Object index ${request.objectIndex} cannot be negative`);
    }
        if (typeof request.replacementText !== 'string' || request.replacementText.trim().length === 0) {
      throw new PdfInvalidReplacementError('Replacement text cannot be empty');
    }

    if (request.objectPath && request.objectPath.length > 1) {
      const batchResult = await this.applyBatchEdits({
        inputPdfPath: request.inputPdfPath,
        outputPdfPath: request.outputPdfPath,
        commands: [
          {
            type: 'replace',
            objectId: request.objectId || `p${request.pageIndex}_o${request.objectIndex}`,
            pageIndex: request.pageIndex,
            objectIndex: request.objectIndex,
            objectPath: request.objectPath,
            originalText: undefined,
            newText: request.replacementText,
            format: request.format,
          },
        ],
      });

      const cmdResult = batchResult.commands[0];
      if (cmdResult && cmdResult.status === 'failed') {
        const errMsg = cmdResult.error || 'Replacement failed on nested object';
        if (errMsg.toLowerCase().includes('font') || errMsg.toLowerCase().includes('glyph')) {
          throw new PdfFontLimitationError(errMsg);
        }
        if (errMsg.toLowerCase().includes('path') || errMsg.toLowerCase().includes('locator')) {
          throw new PdfInvalidObjectPathError(errMsg);
        }
        throw new PdfTextReplacementError(errMsg);
      }

      return {
        outputPath: batchResult.outputPath,
        pageIndex: request.pageIndex,
        objectIndex: request.objectIndex,
        oldText: cmdResult?.originalText ?? '',
        newText: request.replacementText,
        replacementFound: Boolean(batchResult.reopenedVerification.verifiedReplacements.length > 0 || cmdResult?.status === 'applied'),
        oldTextStillPresent: false,
        pageCountBefore: batchResult.pageCountBefore,
        pageCountAfter: batchResult.pageCountAfter,
        sourceUnchanged: batchResult.sourceUnchanged,
        sourceChecksumBefore: batchResult.sourceChecksumBefore,
        sourceChecksumAfter: batchResult.sourceChecksumAfter,
        fontReused: Boolean(cmdResult?.fontReused),
        fontStrategy: cmdResult?.fontStrategy ?? 'REUSED_ORIGINAL',
        preservedProperties: {
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          pdfBounds: { left: 0, bottom: 0, right: 0, top: 0 },
          fontSize: null,
          fontName: null,
          fontResourceReused: Boolean(cmdResult?.fontReused),
          fontStrategy: cmdResult?.fontStrategy ?? '',
          color: null,
          colorRgba: null,
          matrix: null,
        },
        limitations: batchResult.limitations,
      };
    }

try {
      const jsonStr: string = await getNativeModule().replaceTextObject(
        request.inputPdfPath,
        request.outputPdfPath,
        request.pageIndex,
        request.objectIndex,
        request.replacementText,
      );

      const parsed = JSON.parse(jsonStr);

      // Native failures are returned as resolved { success: false } JSON.
      if (parsed && parsed.success === false) {
        throw nativeFailureToError(String(parsed.errorCode ?? ''), String(parsed.errorMessage ?? ''));
      }

      return {
        outputPath: String(parsed.outputPath),
        pageIndex: Number(parsed.pageIndex),
        objectIndex: Number(parsed.objectIndex),
        oldText: String(parsed.oldText),
        newText: String(parsed.newText ?? parsed.replacementText),
        // Real native keys: replacementFoundInReopened / oldTextStillPresentInReopened /
        // sourceFileUnchanged / sourceShaBefore / sourceShaAfter.
        replacementFound: Boolean(parsed.replacementFound ?? parsed.replacementFoundInReopened),
        oldTextStillPresent: Boolean(parsed.oldTextStillPresent ?? parsed.oldTextStillPresentInReopened),
        pageCountBefore: Number(parsed.pageCountBefore),
        pageCountAfter: Number(parsed.pageCountAfter),
        sourceUnchanged: Boolean(parsed.sourceUnchanged ?? parsed.sourceFileUnchanged),
        sourceChecksumBefore: String(parsed.sourceChecksumBefore ?? parsed.sourceShaBefore),
        sourceChecksumAfter: String(parsed.sourceChecksumAfter ?? parsed.sourceShaAfter),
        fontReused: Boolean(parsed.fontReused),
        fontStrategy: String(parsed.fontStrategy ?? 'UNKNOWN'),
        originalFont: parsed.originalFont
          ? {
              baseFontName: parsed.originalFont.baseFontName ?? null,
              familyName: parsed.originalFont.familyName ?? null,
              isEmbedded: Boolean(parsed.originalFont.isEmbedded),
              isSubset: Boolean(parsed.originalFont.isSubset),
              weight: typeof parsed.originalFont.weight === 'number' ? parsed.originalFont.weight : null,
              flags: typeof parsed.originalFont.flags === 'number' ? parsed.originalFont.flags : null,
            }
          : null,
        reopenedFont: parsed.reopenedFont
          ? {
              baseFontName: parsed.reopenedFont.baseFontName ?? null,
              familyName: parsed.reopenedFont.familyName ?? null,
              isEmbedded: Boolean(parsed.reopenedFont.isEmbedded),
              isSubset: Boolean(parsed.reopenedFont.isSubset),
              weight: typeof parsed.reopenedFont.weight === 'number' ? parsed.reopenedFont.weight : null,
              flags: typeof parsed.reopenedFont.flags === 'number' ? parsed.reopenedFont.flags : null,
            }
          : null,
        preservedProperties: {
          bounds: {
            x: Number(parsed.preservedProperties?.bounds?.x ?? 0),
            y: Number(parsed.preservedProperties?.bounds?.y ?? 0),
            width: Number(parsed.preservedProperties?.bounds?.width ?? 0),
            height: Number(parsed.preservedProperties?.bounds?.height ?? 0),
          },
          pdfBounds: {
            left: Number(parsed.preservedProperties?.pdfBounds?.left ?? 0),
            bottom: Number(parsed.preservedProperties?.pdfBounds?.bottom ?? 0),
            right: Number(parsed.preservedProperties?.pdfBounds?.right ?? 0),
            top: Number(parsed.preservedProperties?.pdfBounds?.top ?? 0),
          },
          fontSize:
            typeof parsed.preservedProperties?.fontSize === 'number'
              ? parsed.preservedProperties.fontSize
              : null,
          fontName:
            typeof parsed.preservedProperties?.fontName === 'string' &&
            parsed.preservedProperties.fontName.length > 0
              ? parsed.preservedProperties.fontName
              : null,
          fontResourceReused: Boolean(parsed.preservedProperties?.fontResourceReused),
          fontStrategy: String(
            parsed.preservedProperties?.fontStrategy ?? parsed.fontStrategy ?? '',
          ),
          color:
            typeof parsed.preservedProperties?.color === 'string' &&
            parsed.preservedProperties.color.length > 0
              ? parsed.preservedProperties.color
              : null,
          colorRgba: parsed.preservedProperties?.colorRgba
            ? {
                r: Number(parsed.preservedProperties.colorRgba.r),
                g: Number(parsed.preservedProperties.colorRgba.g),
                b: Number(parsed.preservedProperties.colorRgba.b),
                a: Number(parsed.preservedProperties.colorRgba.a),
              }
            : null,
          matrix: parsed.preservedProperties?.matrix
            ? {
                a: Number(parsed.preservedProperties.matrix.a),
                b: Number(parsed.preservedProperties.matrix.b),
                c: Number(parsed.preservedProperties.matrix.c),
                d: Number(parsed.preservedProperties.matrix.d),
                e: Number(parsed.preservedProperties.matrix.e),
                f: Number(parsed.preservedProperties.matrix.f),
              }
            : null,
        },
        limitations: Array.isArray(parsed.limitations)
          ? parsed.limitations.map(String)
          : [],
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw mapNativeError(err, 'Failed to replace text object in PDF');
    }
  }

  async applyBatchEdits(request: PdfBatchEditRequest): Promise<PdfMultiEditResult> {
    this.ensureNativeModule();
    if (!request.inputPdfPath || request.inputPdfPath.trim().length === 0) {
      throw new PdfFileNotFoundError('Input PDF path cannot be empty');
    }
    if (!request.outputPdfPath || request.outputPdfPath.trim().length === 0) {
      throw new PdfBatchEditError('Output PDF path cannot be empty');
    }
    if (request.inputPdfPath === request.outputPdfPath) {
      throw new PdfBatchEditError('Input and output paths must be different to preserve source immutability');
    }
    if (!request.commands || request.commands.length === 0) {
      // An edit batch must contain edits. Copying an unchanged/already-applied document
      // is the explicit copyDocument() operation.
      throw new PdfBatchEditError('No edit commands provided for batch execution');
    }

    return this.runNativeBatch(
      request.inputPdfPath,
      request.outputPdfPath,
      JSON.stringify(request.commands),
      request.commands.length,
      'Failed to apply batch edits to PDF',
    );
  }

  /**
   * Writes a verified copy of the input document (native batch with zero commands:
   * load, FPDF_SaveAsCopy, source checksum check and reopen validation).
   *
   * This is the ONLY path that sends an empty command list to the native layer; the
   * public applyBatchEdits() rejects empty batches.
   */
  async copyDocument(inputPdfPath: string, outputPdfPath: string): Promise<PdfMultiEditResult> {
    this.ensureNativeModule();
    if (!inputPdfPath || inputPdfPath.trim().length === 0) {
      throw new PdfFileNotFoundError('Input PDF path cannot be empty');
    }
    if (!outputPdfPath || outputPdfPath.trim().length === 0) {
      throw new PdfSaveError('Output PDF path cannot be empty');
    }
    if (inputPdfPath.trim() === outputPdfPath.trim()) {
      throw new PdfSaveError('Input and output paths must be different to preserve source immutability');
    }
    return this.runNativeBatch(inputPdfPath, outputPdfPath, '[]', 0, 'Failed to save PDF copy');
  }

  async replaceFile(fromPath: string, toPath: string): Promise<void> {
    this.ensureNativeModule();
    const native = getNativeModule();
    if (typeof native.moveFile !== 'function') {
      throw new PdfSaveError('Native file replacement is not available on this platform.');
    }
    try {
      await native.moveFile(fromPath, toPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PdfSaveError(`Failed to move saved PDF into place: ${msg}`, err);
    }
  }

  async purgeRenderCache(keepFilePaths: readonly string[]): Promise<number> {
    const native = getNativeModule();
    if (!native || typeof native.purgeRenderCache !== 'function') {
      return 0;
    }
    try {
      return Number(await native.purgeRenderCache([...keepFilePaths]));
    } catch {
      return 0;
    }
  }

  /**
   * Deletes temporary picker/content-URI import copies (cacheDir/picked_pdfs and
   * cacheDir/resolved_pdfs) except the given paths. Imported PDFs are copied into durable
   * document storage first, so these cache copies are obsolete. Never throws.
   */
  async purgeImportCache(keepFilePaths: readonly string[] = []): Promise<number> {
    const native = getNativeModule();
    if (!native || typeof native.purgeImportCache !== 'function') {
      return 0;
    }
    try {
      return Number(await native.purgeImportCache([...keepFilePaths]));
    } catch {
      return 0;
    }
  }

  /**
   * Save As through the platform document picker. `sourcePath` must be the verified,
   * app-private PDF (see pdfOutputService); it is only read. Resolves null on cancel.
   */
  async saveCopyToUserLocation(
    sourcePath: string,
    suggestedFileName: string,
  ): Promise<PdfUserLocationCopy | null> {
    const native = getNativeModule();
    if (!native || typeof native.saveCopyToUserLocation !== 'function') {
      throw new PdfOutputUnavailableError('Save As is not available on this platform.');
    }
    if (!sourcePath || !sourcePath.trim()) {
      throw new PdfSaveAsError('There is no saved PDF to write.');
    }
    let raw: any;
    try {
      raw = await native.saveCopyToUserLocation(sourcePath, suggestedFileName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PdfSaveAsError(msg || 'The PDF could not be saved to the chosen location.', err);
    }
    if (raw === null || raw === undefined) {
      return null;
    }
    const uri = typeof raw.uri === 'string' ? raw.uri : '';
    if (!isPlatformDocumentUri(uri, 'save')) {
      throw new PdfSaveAsError('The chosen location did not return a valid document.');
    }
    return {
      uri,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
      sizeBytes: Number(raw.sizeBytes ?? 0),
    };
  }

  /**
   * Shares the verified, app-private PDF at `sourcePath` with the system share sheet.
   * Only a FileProvider content:// URI is ever exposed; anything else is rejected.
   */
  async sharePdfFile(sourcePath: string, displayName: string, chooserTitle: string): Promise<PdfShareResult> {
    const native = getNativeModule();
    if (!native || typeof native.sharePdf !== 'function') {
      throw new PdfOutputUnavailableError('Sharing PDFs is not available on this platform.');
    }
    if (!sourcePath || !sourcePath.trim()) {
      throw new PdfShareError('There is no saved PDF to share.');
    }
    let raw: any;
    try {
      raw = await native.sharePdf(sourcePath, displayName, chooserTitle);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PdfShareError(msg || 'The PDF could not be shared.', err);
    }
    const contentUri = typeof raw?.contentUri === 'string' ? raw.contentUri : '';
    if (!isPlatformDocumentUri(contentUri, 'share')) {
      throw new PdfShareError('The PDF was not shared through a secure content URI.');
    }
    return {
      contentUri,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : displayName,
    };
  }

  /** Deletes share copies older than maxAgeMs (0 = all). Never throws. */
  async purgeExportCache(maxAgeMs: number = 0): Promise<number> {
    const native = getNativeModule();
    if (!native || typeof native.purgeExportCache !== 'function') {
      return 0;
    }
    try {
      return Number(await native.purgeExportCache(maxAgeMs));
    } catch {
      return 0;
    }
  }

  private async runNativeBatch(
    inputPdfPath: string,
    outputPdfPath: string,
    editsJson: string,
    commandCount: number,
    defaultMessage: string,
  ): Promise<PdfMultiEditResult> {
    let jsonStr: string;
    try {
      jsonStr = await getNativeModule().applyBatchEdits(inputPdfPath, outputPdfPath, editsJson);
    } catch (err: unknown) {
      throw mapNativeError(err, defaultMessage);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr || '{}');
    } catch (err: unknown) {
      throw new PdfBatchEditError(`${defaultMessage}: native response is not valid JSON`, err);
    }

    try {
      return normalizeNativeBatchResult(parsed, { outputPdfPath, commandCount });
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw mapNativeError(err, defaultMessage);
    }
  }

  async applyDocumentOperations(
    inputPdfPath: string,
    outputPdfPath: string,
    operations: readonly PdfDocumentOperation[],
  ): Promise<PdfDocumentOperationsResult> {
    return runDocumentOperations(inputPdfPath, outputPdfPath, operations);
  }

  createEditor(filePath?: string): IPdfDocumentEditor {
    return new PdfDocumentEditor(this, filePath);
  }
}

export const defaultPdfiumEngine = new PdfiumEngine();
