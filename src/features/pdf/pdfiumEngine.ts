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
} from './types';
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
} from '../../errors';
import { PdfDocumentEditor } from './pdfDocumentEditor';

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
  const candidates: PdfTextObject[] = [];

  for (const obj of objects) {
    const { x, y, width, height } = obj.bounds;
    if (
      point.x >= x - padding &&
      point.x <= x + width + padding &&
      point.y >= y - padding &&
      point.y <= y + height + padding
    ) {
      candidates.push(obj);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  // Overlapping bounding boxes: choose smallest area / deepest nesting / nearest center
  candidates.sort((a, b) => {
    const areaA = Math.max(0, a.bounds.width) * Math.max(0, a.bounds.height);
    const areaB = Math.max(0, b.bounds.width) * Math.max(0, b.bounds.height);
    if (Math.abs(areaA - areaB) > 0.01) {
      return areaA - areaB; // Smaller area wins (higher specificity)
    }

    const depthA = a.objectPath ? a.objectPath.length : 1;
    const depthB = b.objectPath ? b.objectPath.length : 1;
    if (depthA !== depthB) {
      return depthB - depthA; // Deeper hierarchy (Form XObject) wins
    }

    const centerAx = a.bounds.x + a.bounds.width / 2;
    const centerAy = a.bounds.y + a.bounds.height / 2;
    const distA = (point.x - centerAx) ** 2 + (point.y - centerAy) ** 2;

    const centerBx = b.bounds.x + b.bounds.width / 2;
    const centerBy = b.bounds.y + b.bounds.height / 2;
    const distB = (point.x - centerBx) ** 2 + (point.y - centerBy) ** 2;

    return distA - distB;
  });

  return candidates[0];
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
      return {
        pageIndex: Number(result.pageIndex),
        width: Number(result.width),
        height: Number(result.height),
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

      return {
        outputPath: String(parsed.outputPath),
        pageIndex: Number(parsed.pageIndex),
        objectIndex: Number(parsed.objectIndex),
        oldText: String(parsed.oldText),
        newText: String(parsed.newText),
        replacementFound: Boolean(parsed.replacementFound),
        oldTextStillPresent: Boolean(parsed.oldTextStillPresent),
        pageCountBefore: Number(parsed.pageCountBefore),
        pageCountAfter: Number(parsed.pageCountAfter),
        sourceUnchanged: Boolean(parsed.sourceUnchanged),
        sourceChecksumBefore: String(parsed.sourceChecksumBefore),
        sourceChecksumAfter: String(parsed.sourceChecksumAfter),
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
      throw new PdfBatchEditError('No edit commands provided for batch execution');
    }

    try {
      const editsJson = JSON.stringify(request.commands);
      const jsonStr: string = await getNativeModule().applyBatchEdits(
        request.inputPdfPath,
        request.outputPdfPath,
        editsJson,
      );
      const parsed = JSON.parse(jsonStr || '{}');

      return {
        outputPath: String(parsed.outputPath ?? request.outputPdfPath),
        totalCommands: Number(parsed.totalCommands ?? request.commands.length),
        appliedCommands: Number(parsed.appliedCommands ?? 0),
        pageCountBefore: Number(parsed.pageCountBefore ?? 0),
        pageCountAfter: Number(parsed.pageCountAfter ?? 0),
        sourceUnchanged: Boolean(parsed.sourceUnchanged),
        sourceChecksumBefore: String(parsed.sourceChecksumBefore ?? ''),
        sourceChecksumAfter: String(parsed.sourceChecksumAfter ?? ''),
        commands: Array.isArray(parsed.commands)
          ? parsed.commands.map((c: any) => ({
              type: c.type as 'replace' | 'delete',
              objectId: String(c.objectId),
              pageIndex: Number(c.pageIndex),
              objectIndex: Number(c.objectIndex),
              status: c.status as 'applied' | 'failed',
              originalText: c.originalText ? String(c.originalText) : undefined,
              newText: c.newText ? String(c.newText) : undefined,
              fontReused: c.fontReused !== undefined ? Boolean(c.fontReused) : undefined,
              fontStrategy: c.fontStrategy ? String(c.fontStrategy) : undefined,
              error: c.error ? String(c.error) : undefined,
            }))
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
        limitations: Array.isArray(parsed.limitations)
          ? parsed.limitations.map(String)
          : [],
      };
    } catch (err: unknown) {
      throw mapNativeError(err, 'Failed to apply batch edits to PDF');
    }
  }

  createEditor(filePath?: string): IPdfDocumentEditor {
    return new PdfDocumentEditor(this, filePath);
  }
}

export const defaultPdfiumEngine = new PdfiumEngine();
