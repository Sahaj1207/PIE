import { Document, DocumentPage } from '../../types/document';
import { NotImplementedError } from '../../errors';

export interface PdfTransformationMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface PdfColorRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfRawBounds {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

export interface PdfTextObject {
  /** Stable object identifier for the current opened document */
  readonly id: string;
  readonly pageIndex: number;
  readonly objectIndex: number;
  /**
   * Page-object ancestry from the page root to this text object. A top-level
   * object has one entry; nested Form XObject text has one entry per level.
   */
  readonly objectPath?: readonly number[];
  /** Real vector text extracted from PDF */
  readonly text: string;
  /** Bounding box normalized to top-left document coordinate system */
  readonly bounds: PdfRect;
  /** Raw PDF coordinates (origin at bottom-left, Y increasing upward) */
  readonly pdfBounds: PdfRawBounds;
  /** Typographic font size in points, or null if unavailable */
  readonly fontSize: number | null;
  /** PostScript / Base font name, or null if unavailable */
  readonly fontName: string | null;
  /** Fill/text color in hex format (#RRGGBB), or null if unavailable */
  readonly color: string | null;
  /** Fill/text color in RGBA components, or null if unavailable */
  readonly colorRgba: PdfColorRgba | null;
  /** 2D transformation matrix, or null if unavailable */
  readonly matrix: PdfTransformationMatrix | null;
  /** Detailed font metadata (embedding, subset status, weight, flags) */
  readonly fontDetails?: PdfFontDetails | null;
  /** Whether this object is an editable vector text object */
  readonly isEditable: boolean;
}

/**
 * Explicit selection state for Phase 3 PDF document interaction.
 */
export interface PdfSelectionState {
  readonly selectedPageIndex: number;
  readonly selectedObjectId: string;
  readonly selectedObjectPath: readonly number[];
  readonly selectedBounds: PdfRect;
  readonly selectedText?: string;
}

export function createPdfSelectionState(
  obj: PdfTextObject,
  fallbackPageIndex = 0,
): PdfSelectionState {
  return {
    selectedPageIndex: typeof obj.pageIndex === 'number' ? obj.pageIndex : fallbackPageIndex,
    selectedObjectId: obj.id,
    selectedObjectPath:
      obj.objectPath && obj.objectPath.length > 0 ? obj.objectPath : [obj.objectIndex],
    selectedBounds: { ...obj.bounds },
    selectedText: obj.text,
  };
}

export type PdfCommandType = 'replace' | 'delete' | 'insert';

export interface PdfTextFormatOptions {
  readonly fontFamily?: 'Helvetica' | 'Times-Roman' | 'Courier' | string;
  readonly fontSize?: number;
  readonly isBold?: boolean;
  readonly isItalic?: boolean;
  readonly color?: string;
  readonly opacity?: number;
}

export type PdfTextFittingState = 'PRESERVED' | 'SCALED_DOWN' | 'UNSUPPORTED' | 'OVERFLOW';

export interface PdfFormattingOriginal {
  readonly fontFamily: string | null;
  readonly fontSize: number | null;
  readonly fontWeight: number | null;
  readonly isItalic: boolean | null;
  readonly color: string | null;
  readonly colorRgba: PdfColorRgba | null;
  readonly bounds: PdfRect;
  readonly matrix: PdfTransformationMatrix | null;
  readonly baseline?: number;
  readonly isEmbedded?: boolean;
  readonly isSubset?: boolean;
}

export interface PdfFormattingPersisted {
  readonly fontFamily: string | null;
  readonly fontSize: number | null;
  readonly fontWeight: number | null;
  readonly isItalic: boolean | null;
  readonly color: string | null;
  readonly colorRgba: PdfColorRgba | null;
  readonly bounds: PdfRect;
  readonly matrix: PdfTransformationMatrix | null;
  readonly baseline?: number;
}

export interface PdfFormattingModel {
  readonly objectId: string;
  readonly original: PdfFormattingOriginal;
  readonly requested: PdfTextFormatOptions;
  readonly persisted?: PdfFormattingPersisted;
  readonly unsupported: readonly string[];
}

export function buildPdfFormattingModel(
  target: PdfTextObject,
  requested?: PdfTextFormatOptions,
  persisted?: PdfTextObject,
): PdfFormattingModel {
  const unsupported: string[] = [];

  const lowerFont = (target.fontName || '').toLowerCase();
  const isItalic =
    lowerFont.includes('italic') || lowerFont.includes('oblique');
  const fontWeight = target.fontDetails?.weight ?? (lowerFont.includes('bold') ? 700 : 400);

  const isNested = Boolean(target.objectPath && target.objectPath.length > 1);
  const isSubsetOrEmbedded = Boolean(
    target.fontDetails?.isSubset || target.fontDetails?.isEmbedded,
  );

  if (requested) {
    if (
      requested.fontFamily !== undefined &&
      requested.fontFamily !== target.fontName &&
      requested.fontFamily !== target.fontDetails?.familyName
    ) {
      if (isNested) {
        unsupported.push(
          'Font family substitution is unsupported on nested Form XObject text objects.',
        );
      } else if (isSubsetOrEmbedded) {
        unsupported.push(
          `Font family substitution on embedded subset font "${target.fontName}" is unsupported to preserve glyph outlines.`,
        );
      }
    }

    if (
      (requested.isBold !== undefined && requested.isBold !== (fontWeight >= 700)) ||
      (requested.isItalic !== undefined && requested.isItalic !== isItalic)
    ) {
      if (isNested) {
        unsupported.push(
          'Bold/Italic style change is unsupported on nested Form XObject text objects.',
        );
      } else if (isSubsetOrEmbedded) {
        unsupported.push(
          `Bold/Italic style change on embedded subset font "${target.fontName}" is unsupported to preserve font fidelity.`,
        );
      }
    }
  }

  const baseline = target.pdfBounds ? target.pdfBounds.bottom : undefined;

  return {
    objectId: target.id,
    original: {
      fontFamily: target.fontName,
      fontSize: target.fontSize,
      fontWeight,
      isItalic,
      color: target.color,
      colorRgba: target.colorRgba,
      bounds: { ...target.bounds },
      matrix: target.matrix ? { ...target.matrix } : null,
      baseline,
      isEmbedded: target.fontDetails?.isEmbedded,
      isSubset: target.fontDetails?.isSubset,
    },
    requested: requested ? { ...requested } : {},
    persisted: persisted
      ? {
          fontFamily: persisted.fontName,
          fontSize: persisted.fontSize,
          fontWeight:
            persisted.fontDetails?.weight ??
            ((persisted.fontName || '').toLowerCase().includes('bold') ? 700 : 400),
          isItalic:
            (persisted.fontName || '').toLowerCase().includes('italic') ||
            (persisted.fontName || '').toLowerCase().includes('oblique'),
          color: persisted.color,
          colorRgba: persisted.colorRgba,
          bounds: { ...persisted.bounds },
          matrix: persisted.matrix ? { ...persisted.matrix } : null,
          baseline: persisted.pdfBounds ? persisted.pdfBounds.bottom : undefined,
        }
      : undefined,
    unsupported,
  };
}

export interface PdfReplaceCommand {
  readonly type: 'replace';
  readonly objectId: string;
  readonly pageIndex: number;
  readonly objectIndex: number;
  readonly objectPath?: readonly number[];
  readonly originalText?: string;
  readonly newText: string;
  readonly format?: PdfTextFormatOptions;
  /** Shift the text that follows on the same line by the width change (native reflow). */
  readonly reflow?: boolean;
}

export interface PdfDeleteCommand {
  readonly type: 'delete';
  readonly objectId: string;
  readonly pageIndex: number;
  readonly objectIndex: number;
  readonly objectPath?: readonly number[];
  readonly originalText?: string;
  /** Close up the line after removing the object (native reflow). */
  readonly reflow?: boolean;
}

export interface PdfInsertCommand {
  readonly type: 'insert';
  readonly objectId: string;
  readonly pageIndex: number;
  readonly text: string;
  readonly x: number; // PDF user-space coordinate (X)
  readonly y: number; // PDF user-space coordinate (Y, from bottom)
  readonly bounds: PdfRect; // Normalized document-space bounding box
  readonly fontSize: number;
  readonly fontName?: string;
  readonly color?: string;
}

export type PdfTextEditCommand = PdfReplaceCommand | PdfDeleteCommand | PdfInsertCommand;

export interface PdfBatchEditRequest {
  readonly inputPdfPath: string;
  readonly outputPdfPath: string;
  readonly commands: readonly PdfTextEditCommand[];
}

export interface PdfCommandResult {
  readonly type: 'replace' | 'delete' | 'insert';
  readonly objectId: string;
  readonly pageIndex: number;
  readonly objectIndex: number;
  readonly status: 'applied' | 'failed';
  readonly originalText?: string;
  readonly newText?: string;
  readonly fontReused?: boolean;
  readonly fontStrategy?: string;
  readonly error?: string;
  readonly unsupportedFormatting?: readonly string[];
  /**
   * Native reopen check of THIS edit: the edited object holds exactly the requested text and
   * exact occurrence counts on the page match (duplicate-safe), or the deleted text occurs
   * one fewer time than before.
   */
  readonly verifiedInReopened?: boolean;
  /** Native reason when verifiedInReopened is false. */
  readonly verificationError?: string;
}

/** Result of a successful Save As to a user-chosen location. */
export interface PdfUserLocationCopy {
  /** content:// URI of the written document (owned by the chosen provider). */
  readonly uri: string;
  readonly displayName: string;
  readonly sizeBytes: number;
}

/** Result of handing a PDF to the system share sheet. */
export interface PdfShareResult {
  /** FileProvider content:// URI that was shared (never a filesystem path). */
  readonly contentUri: string;
  readonly displayName: string;
}

export interface PdfMultiEditVerification {
  readonly allReplacementsVerified: boolean;
  readonly allDeletionsVerified: boolean;
  readonly allInsertionsVerified?: boolean;
  readonly verifiedReplacements: readonly string[];
  readonly missingReplacements: readonly string[];
  readonly residualDeletions: readonly string[];
}

export interface PdfMultiEditResult {
  readonly outputPath: string;
  readonly totalCommands: number;
  readonly appliedCommands: number;
  readonly pageCountBefore: number;
  readonly pageCountAfter: number;
  readonly sourceUnchanged: boolean;
  readonly sourceChecksumBefore: string;
  readonly sourceChecksumAfter: string;
  readonly commands: readonly PdfCommandResult[];
  readonly reopenedVerification: PdfMultiEditVerification;
  readonly limitations: readonly string[];
}

export type PdfEditorHistoryAction =
  | {
      readonly type: 'insert';
      readonly insertedObject: PdfTextObject;
      readonly command: PdfInsertCommand;
    }
  | {
      readonly type: 'delete';
      readonly targetObject: PdfTextObject;
      readonly wasInserted: boolean;
      readonly previousPendingCommand?: PdfTextEditCommand;
    }
  | {
      readonly type: 'replace';
      readonly objectId: string;
      readonly wasInserted: boolean;
      readonly previousText: string;
      readonly previousFormat?: PdfTextFormatOptions;
      readonly newText: string;
      readonly newFormat?: PdfTextFormatOptions;
      readonly previousPendingCommand?: PdfTextEditCommand;
    }
  | PdfRevisionHistoryAction;

/**
 * Snapshot of the pending-command model folded into an applied revision, so undoing the
 * revision restores exactly the queued (not yet applied) state that existed before it.
 */
export interface PdfPendingStateSnapshot {
  readonly pendingEdits: readonly PdfTextEditCommand[];
  readonly deletedObjectIds: readonly string[];
  readonly insertedObjects: readonly PdfTextObject[];
  readonly undoActions: readonly PdfEditorHistoryAction[];
}

/**
 * An edit applied natively to a new working-copy file (working-copy model).
 * Undo reopens `beforePath`; redo reopens `afterPath`. Both files are immutable once
 * written, so undo/redo reverse the actual PDF content rather than only in-memory state.
 */
export interface PdfRevisionHistoryAction {
  readonly type: 'revision';
  /** Text edits, page tools ('pages') or markup drawn on a page ('markup'). */
  readonly operation: 'replace' | 'delete' | 'insert' | 'pages' | 'markup';
  readonly objectId: string;
  readonly pageIndex: number;
  readonly beforePath: string;
  readonly afterPath: string;
  readonly foldedPending?: PdfPendingStateSnapshot;
}

export interface IPdfDocumentEditor {
  open(filePath: string): Promise<void>;
  getPageCount(): number;
  getPageSize(pageIndex: number): Promise<PdfPageSize>;
  getTextObjects(pageIndex: number): Promise<PdfTextObject[]>;
  replaceText(objectId: string, newText: string, format?: PdfTextFormatOptions): void;
  applyExistingTextReplacement?(
    objectId: string,
    newText: string,
    workingCopyPath: string,
    format?: PdfTextFormatOptions,
  ): Promise<{
    result: PdfMultiEditResult;
    reconciledObject: PdfTextObject;
  }>;
  deleteText(objectId: string): void;
  applyExistingTextDeletion?(
    objectId: string,
    workingCopyPath: string,
  ): Promise<{
    result: PdfMultiEditResult;
  }>;
  insertText(
    pageIndex: number,
    text: string,
    position: { x: number; y: number },
    format?: PdfTextFormatOptions,
  ): PdfTextObject;
  applyNewTextInsertion?(
    pageIndex: number,
    text: string,
    position: { x: number; y: number },
    workingCopyPath: string,
    format?: PdfTextFormatOptions,
  ): Promise<{
    result: PdfMultiEditResult;
    insertedObject: PdfTextObject;
  }>;
  getPendingEdits(): readonly PdfTextEditCommand[];
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * Undo/redo are asynchronous because reversing an applied (working-copy) edit reopens a
   * different PDF revision. Reversing a queued edit completes synchronously before the
   * returned promise is created.
   */
  undo(): Promise<void>;
  redo(): Promise<void>;
  clearHistory(): void;
  saveEdits(outputPath: string): Promise<PdfMultiEditResult>;
  saveDocument(outputPath?: string): Promise<{
    outputPath: string;
    result: PdfMultiEditResult;
    verified: boolean;
  }>;
  saveDocumentAs(outputPath: string): Promise<{
    outputPath: string;
    result: PdfMultiEditResult;
    verified: boolean;
  }>;
  discardWorkingChanges(): Promise<void>;
  verifyPdfOutput?(outputPath: string): Promise<boolean>;
  getSaveState(): PdfSaveState;
  isDirty(): boolean;
  getSourceFilePath(): string | null;
  getCurrentFilePath(): string | null;
  close(): Promise<void>;
}

export type PdfSaveState = 'CLEAN' | 'DIRTY' | 'SAVING' | 'SAVE_FAILED';

export interface PdfFontDetails {
  readonly baseFontName: string | null;
  readonly familyName: string | null;
  readonly isEmbedded: boolean;
  readonly isSubset: boolean;
  readonly weight: number | null;
  readonly flags: number | null;
}

/**
 * Affine map from PDF user space (points, origin at the box's lower-left, Y up) to the
 * DISPLAYED page (points, origin top-left, Y down) exactly as PDFium renders it, i.e. with
 * the page's /Rotate and crop-box origin applied. u = a*x + c*y + e, v = b*x + d*y + f.
 */
export interface PdfDisplayMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export type PdfPageRotation = 0 | 90 | 180 | 270;

export interface PdfPageSize {
  readonly pageIndex: number;
  /** Displayed (rendered) width in points (rotation already applied). */
  readonly width: number;
  /** Displayed (rendered) height in points (rotation already applied). */
  readonly height: number;
  /** Page /Rotate (clockwise) when known; absent = 0. */
  readonly rotation?: PdfPageRotation;
  /** User -> display mapping from PDFium when known; absent = unrotated, origin (0,0). */
  readonly displayMatrix?: PdfDisplayMatrix;
}

export interface PdfDocumentHandle {
  readonly docHandle: number;
  readonly pageCount: number;
  readonly filePath: string;
  /** Size of the opened file when the platform reports it (revision storage cap). */
  readonly fileSizeBytes?: number;
}

export interface PdfRenderOptions {
  readonly scale?: number;
}

/** A display-space region of a page rendered at high resolution (zoom detail). */
export interface PdfRenderedRegion {
  readonly filePath: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly pageIndex: number;
  /** Region in display points (top-left origin). */
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface PdfRenderedPage {
  readonly filePath: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly scale: number;
  readonly pageIndex: number;
}

export interface IPdfiumEngine {
  openDocument(filePath: string, password?: string): Promise<PdfDocumentHandle>;
  closeDocument(docHandle: number): Promise<boolean>;
  getPageCount(docHandle: number): Promise<number>;
  getPageSize(docHandle: number, pageIndex: number): Promise<PdfPageSize>;
  renderPage(
    docHandle: number,
    pageIndex: number,
    options?: PdfRenderOptions,
  ): Promise<PdfRenderedPage>;
  getTextObjects(docHandle: number, pageIndex: number): Promise<PdfTextObject[]>;
  /** Renders a display-space region of a page at `scale` px/pt (zoom detail). */
  renderPageRegion?(
    docHandle: number,
    pageIndex: number,
    scale: number,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<PdfRenderedRegion>;
  extractAssetPdf(assetName: string): Promise<string>;
  pickPdfDocument?(): Promise<{ filePath: string; fileName: string; fileSize: number } | null>;
  replaceTextObject(
    request: PdfTextReplacementRequest,
  ): Promise<PdfTextReplacementResult>;
  /**
   * Applies a NON-EMPTY batch of edit commands. An empty `commands` array is rejected;
   * writing an unchanged document is the separate copyDocument() operation.
   */
  applyBatchEdits(request: PdfBatchEditRequest): Promise<PdfMultiEditResult>;
  /**
   * Writes a verified copy of `inputPdfPath` to `outputPdfPath` (no edit commands).
   * Used by Save when all edits are already applied to the working copy.
   * Required: Save never falls back to an empty applyBatchEdits() batch.
   */
  copyDocument(inputPdfPath: string, outputPdfPath: string): Promise<PdfMultiEditResult>;
  /** Atomically moves `fromPath` over `toPath` (used to finish a save onto the open file). */
  replaceFile?(fromPath: string, toPath: string): Promise<void>;
  /** Deletes cached page renders except the given file paths. */
  purgeRenderCache?(keepFilePaths: readonly string[]): Promise<number>;
  /** Deletes obsolete picker/content-URI import copies except the given file paths. */
  purgeImportCache?(keepFilePaths?: readonly string[]): Promise<number>;
  /**
   * Save As: the user picks filename + destination (Android ACTION_CREATE_DOCUMENT); the
   * verified app-private PDF at `sourcePath` is copied there and read back for
   * verification. Resolves null when the user cancels.
   */
  saveCopyToUserLocation?(sourcePath: string, suggestedFileName: string): Promise<PdfUserLocationCopy | null>;
  /** Shares the verified app-private PDF through the system share sheet (content:// URI). */
  sharePdfFile?(sourcePath: string, displayName: string, chooserTitle: string): Promise<PdfShareResult>;
  /** Deletes share copies older than maxAgeMs (0 = all). */
  purgeExportCache?(maxAgeMs?: number): Promise<number>;
  /**
   * Page tools / markup (pie_pdf_ops): applies `operations` from `inputPdfPath` into the NEW
   * file `outputPdfPath`, verified by reopening. The input is never modified.
   */
  applyDocumentOperations?(
    inputPdfPath: string,
    outputPdfPath: string,
    operations: readonly import('./pdfDocumentOperations').PdfDocumentOperation[],
  ): Promise<import('./pdfDocumentOperations').PdfDocumentOperationsResult>;
  createEditor(filePath?: string): IPdfDocumentEditor;
}

export interface PdfTextReplacementRequest {
  readonly inputPdfPath: string;
  readonly outputPdfPath: string;
  readonly pageIndex: number;
  readonly objectIndex: number;
  readonly objectId?: string;
  readonly objectPath?: readonly number[];
  readonly replacementText: string;
  readonly format?: PdfTextFormatOptions;
}

export interface PdfReplacementPreservedProperties {
  readonly bounds: PdfRect;
  readonly pdfBounds: PdfRawBounds;
  readonly fontSize: number | null;
  readonly fontName: string | null;
  readonly color: string | null;
  readonly colorRgba: PdfColorRgba | null;
  readonly matrix: PdfTransformationMatrix | null;
  readonly fontResourceReused?: boolean;
  readonly fontStrategy?: string;
}

export interface PdfTextReplacementResult {
  readonly outputPath: string;
  readonly pageIndex: number;
  readonly objectIndex: number;
  readonly oldText: string;
  readonly newText: string;
  readonly replacementFound: boolean;
  readonly oldTextStillPresent: boolean;
  readonly pageCountBefore: number;
  readonly pageCountAfter: number;
  readonly sourceUnchanged: boolean;
  readonly sourceChecksumBefore: string;
  readonly sourceChecksumAfter: string;
  readonly fontReused: boolean;
  readonly fontStrategy: string;
  readonly originalFont?: PdfFontDetails | null;
  readonly reopenedFont?: PdfFontDetails | null;
  readonly preservedProperties: PdfReplacementPreservedProperties;
  readonly limitations: readonly string[];
}

// Retain legacy interfaces for backward-compatibility with earlier types
export interface PdfPageRenderOptions {
  readonly scale?: number;
}

export interface PdfPageRenderResult {
  readonly pageIndex: number;
  readonly rasterUri: string;
  readonly width: number;
  readonly height: number;
}

export interface IPdfEngine {
  openDocument(fileUri: string): Promise<Document>;
  renderPage(
    fileUri: string,
    pageIndex: number,
    options?: PdfPageRenderOptions,
  ): Promise<PdfPageRenderResult>;
  extractPageElements(
    fileUri: string,
    pageIndex: number,
  ): Promise<DocumentPage>;
}

export class UnconfiguredPdfEngine implements IPdfEngine {
  async openDocument(): Promise<Document> {
    throw new NotImplementedError('PDF Engine');
  }

  async renderPage(): Promise<PdfPageRenderResult> {
    throw new NotImplementedError('PDF Page Renderer');
  }

  async extractPageElements(): Promise<DocumentPage> {
    throw new NotImplementedError('PDF Page Element Extractor');
  }
}
