/**
 * Domain error hierarchy for PDF & Image Editor.
 *
 * Provides typed, actionable error categories across document loading,
 * parsing, OCR, rendering, storage, and export.
 */

export type AppErrorCode =
  | 'UNSUPPORTED_DOCUMENT'
  | 'CORRUPTED_DOCUMENT'
  | 'UNSUPPORTED_PDF_FEATURE'
  | 'OCR_PROCESSING_FAILED'
  | 'BACKGROUND_RECONSTRUCTION_FAILED'
  | 'EXPORT_FAILED'
  | 'INSUFFICIENT_STORAGE'
  | 'PERMISSION_DENIED'
  | 'NOT_IMPLEMENTED'
  | 'PDF_FILE_NOT_FOUND'
  | 'PDF_CORRUPTED'
  | 'PDF_PASSWORD_REQUIRED'
  | 'PDF_PAGE_OUT_OF_RANGE'
  | 'PDF_RENDER_FAILED'
  | 'PDF_TEXT_EXTRACTION_FAILED'
  | 'PDF_ENGINE_NOT_LINKED'
  | 'PDF_TEXT_REPLACEMENT_FAILED'
  | 'PDF_INVALID_OBJECT_ID'
  | 'PDF_DELETED_OBJECT_EDIT'
  | 'PDF_BATCH_EDIT_FAILED'
  | 'PDF_INVALID_REPLACEMENT'
  | 'PDF_UNSUPPORTED_FORMATTING'
  | 'PDF_INVALID_FORMATTING'
  | 'PDF_REOPEN_VERIFICATION_FAILED'
  | 'PDF_STALE_SELECTION'
  | 'PDF_DOCUMENT_CLOSED'
  | 'PDF_CONCURRENT_SAVE'
  | 'PDF_VALIDATION_FAILED'
  | 'PDF_SOURCE_UNAVAILABLE'
  | 'PDF_WORKING_COPY_FAILED'
  | 'PDF_SAVE_AS_FAILED'
  | 'IMAGE_IMPORT_FAILED'
  | 'IMAGE_CANCELLED'
  | 'IMAGE_UNSUPPORTED_FORMAT'
  | 'IMAGE_INVALID_DIMENSIONS'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_URI_UNSUPPORTED'
  | 'IMAGE_WORKING_COPY_FAILED'
  | 'IMAGE_DOCUMENT_CLOSED'
  | 'IMAGE_STALE_DOCUMENT'
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'OCR_EMPTY_RESULT'
  | 'OCR_INVALID_RESULT'
  | 'OCR_INVALID_BOUNDS'
  | 'OCR_STALE_DOCUMENT'
  | 'OCR_CANCELLED'
  | 'OCR_IMAGE_READ_FAILED'
  | 'OCR_UNSUPPORTED_IMAGE'
  | 'IMAGE_TEXT_SELECTION_INVALID'
  | 'IMAGE_TEXT_REPLACEMENT_FAILED'
  | 'IMAGE_BACKGROUND_RECONSTRUCTION_FAILED'
  | 'IMAGE_TEXT_FIT_FAILED'
  | 'IMAGE_UNSUPPORTED_FONT'
  | 'IMAGE_TEXT_OVERFLOW'
  | 'IMAGE_STALE_SELECTION'
  | 'IMAGE_PATCH_FAILED'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_SAVE_FAILED'
  | 'IMAGE_EXPORT_UNAVAILABLE'
  | 'IMAGE_RECONSTRUCTION_UNAVAILABLE'
  | 'PDF_SECURITY_UNSUPPORTED'
  | 'PDF_UNSUPPORTED_GLYPHS'
  | 'PDF_SHARE_FAILED'
  | 'PDF_OUTPUT_UNAVAILABLE'
  | 'PDF_OUTPUT_NOT_VERIFIED'
  | 'DOCUMENT_BUSY'
  | 'DOCUMENT_STORAGE_FAILED'
  | 'DOCUMENT_STORAGE_CORRUPTED'
  | 'DOCUMENT_ASSET_MISSING'
  | 'PDF_DOCUMENT_OPERATION_FAILED'
  | 'PDF_MERGE_FAILED'
  | 'PDF_CREATE_FAILED'
  | 'IMAGE_TRANSFORM_FAILED';

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnsupportedDocumentError extends AppError {
  readonly code: AppErrorCode = 'UNSUPPORTED_DOCUMENT';
}

export class CorruptedDocumentError extends AppError {
  readonly code: AppErrorCode = 'CORRUPTED_DOCUMENT';
}

export class UnsupportedPdfFeatureError extends AppError {
  readonly code: AppErrorCode = 'UNSUPPORTED_PDF_FEATURE';
}

export class OcrProcessingError extends AppError {
  readonly code: AppErrorCode = 'OCR_PROCESSING_FAILED';
}

export class BackgroundReconstructionError extends AppError {
  readonly code: AppErrorCode = 'BACKGROUND_RECONSTRUCTION_FAILED';
}

export class ExportError extends AppError {
  readonly code: AppErrorCode = 'EXPORT_FAILED';
}

export class InsufficientStorageError extends AppError {
  readonly code: AppErrorCode = 'INSUFFICIENT_STORAGE';
}

export class PermissionError extends AppError {
  readonly code: AppErrorCode = 'PERMISSION_DENIED';
}

export class NotImplementedError extends AppError {
  readonly code: AppErrorCode = 'NOT_IMPLEMENTED';

  constructor(featureName: string) {
    super(`${featureName} is not yet implemented in this foundation phase.`);
  }
}

export class PdfFileNotFoundError extends AppError {
  readonly code: AppErrorCode = 'PDF_FILE_NOT_FOUND';
}

export const PdfNotFoundError = PdfFileNotFoundError;
export type PdfNotFoundError = PdfFileNotFoundError;

export class PdfCorruptedError extends AppError {
  readonly code: AppErrorCode = 'PDF_CORRUPTED';
}

export class PdfPasswordRequiredError extends AppError {
  readonly code: AppErrorCode = 'PDF_PASSWORD_REQUIRED';
}

export class PdfPageOutOfRangeError extends AppError {
  readonly code: AppErrorCode = 'PDF_PAGE_OUT_OF_RANGE';
}

export class PdfRenderError extends AppError {
  readonly code: AppErrorCode = 'PDF_RENDER_FAILED';
}

export class PdfTextExtractionError extends AppError {
  readonly code: AppErrorCode = 'PDF_TEXT_EXTRACTION_FAILED';
}

export class PdfEngineNotLinkedError extends AppError {
  readonly code: AppErrorCode = 'PDF_ENGINE_NOT_LINKED';
}

export class PdfTextReplacementError extends AppError {
  readonly code: AppErrorCode = 'PDF_TEXT_REPLACEMENT_FAILED';
}

export class PdfInvalidObjectIdError extends AppError {
  readonly code: AppErrorCode = 'PDF_INVALID_OBJECT_ID';
}

export class PdfDeletedObjectEditError extends AppError {
  readonly code: AppErrorCode = 'PDF_DELETED_OBJECT_EDIT';
}

export class PdfBatchEditError extends AppError {
  readonly code: AppErrorCode = 'PDF_BATCH_EDIT_FAILED';
}

export class PdfInvalidReplacementError extends PdfTextReplacementError {
  readonly code: AppErrorCode = 'PDF_INVALID_REPLACEMENT';
}

export class PdfFontLimitationError extends PdfTextReplacementError {
  readonly code: AppErrorCode = 'PDF_TEXT_REPLACEMENT_FAILED';
}

/**
 * The requested text contains characters the PDF font cannot draw (missing glyphs, CJK in
 * a Latin font, emoji, control characters). The edit is refused instead of producing
 * missing or silently substituted glyphs. `characters` lists the offending characters.
 */
export class PdfUnsupportedGlyphsError extends PdfFontLimitationError {
  readonly code: AppErrorCode = 'PDF_UNSUPPORTED_GLYPHS';
  readonly characters: readonly string[];

  constructor(message: string, characters: readonly string[] = [], cause?: unknown) {
    super(message, cause);
    this.characters = characters;
  }
}

export class PdfInvalidObjectPathError extends PdfInvalidObjectIdError {
  readonly code: AppErrorCode = 'PDF_INVALID_OBJECT_ID';
}

export class PdfDocumentNotOpenError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_FILE_NOT_FOUND';
}

export class PdfUnsupportedReplacementError extends PdfTextReplacementError {
  readonly code: AppErrorCode = 'PDF_INVALID_REPLACEMENT';
}

export class PdfTextDeletionError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_BATCH_EDIT_FAILED';
}

export class PdfNonDeletableObjectError extends PdfTextDeletionError {
  readonly code: AppErrorCode = 'PDF_INVALID_OBJECT_ID';
}

export class PdfTextInsertionError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_BATCH_EDIT_FAILED';
}

export class PdfInvalidPlacementError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_BATCH_EDIT_FAILED';
}

export class PdfSaveError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_BATCH_EDIT_FAILED';
}

export class PdfUnsupportedFormattingError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_UNSUPPORTED_FORMATTING';
}

export class PdfInvalidFormattingError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_INVALID_FORMATTING';
}

export class PdfInvalidFontError extends PdfInvalidFormattingError {}

export class PdfInvalidColorError extends PdfInvalidFormattingError {}

export class PdfInvalidFontSizeError extends PdfInvalidFormattingError {}

export class PdfStaleSelectionError extends PdfInvalidObjectIdError {
  readonly code: AppErrorCode = 'PDF_STALE_SELECTION';
}

export class PdfReopenVerificationError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_REOPEN_VERIFICATION_FAILED';
}

export class PdfNativeFormattingError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_BATCH_EDIT_FAILED';
}

export class PdfDocumentClosedError extends PdfDocumentNotOpenError {
  readonly code: AppErrorCode = 'PDF_DOCUMENT_CLOSED';
}

export class PdfConcurrentSaveError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_CONCURRENT_SAVE';
}

export class PdfValidationFailureError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_VALIDATION_FAILED';
}

export class PdfSourceUnavailableError extends PdfFileNotFoundError {
  readonly code: AppErrorCode = 'PDF_SOURCE_UNAVAILABLE';
}

export class PdfWorkingCopyError extends PdfBatchEditError {
  readonly code: AppErrorCode = 'PDF_WORKING_COPY_FAILED';
}

/** The PDF uses an encryption/security handler PDFium cannot open. Never bypassed. */
export class PdfSecurityUnsupportedError extends AppError {
  readonly code: AppErrorCode = 'PDF_SECURITY_UNSUPPORTED';
}

/** Sharing a verified PDF through the system share sheet failed. */
export class PdfShareError extends AppError {
  readonly code: AppErrorCode = 'PDF_SHARE_FAILED';
}

/** Save As / Share are not available on this platform (native output bridge missing). */
export class PdfOutputUnavailableError extends AppError {
  readonly code: AppErrorCode = 'PDF_OUTPUT_UNAVAILABLE';
}

/** Save As / Share refused: there is no saved, reopen-verified PDF to expose. */
export class PdfOutputNotVerifiedError extends AppError {
  readonly code: AppErrorCode = 'PDF_OUTPUT_NOT_VERIFIED';
}

export class PdfSaveAsError extends PdfSaveError {
  readonly code: AppErrorCode = 'PDF_SAVE_AS_FAILED';
}

export class ImageImportError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_IMPORT_FAILED';
}

export class ImageCancelledError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_CANCELLED';
}

export class ImageUnsupportedFormatError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_UNSUPPORTED_FORMAT';
}

export class ImageInvalidDimensionsError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_INVALID_DIMENSIONS';
}

export class ImageReadError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_READ_FAILED';
}

export class ImageDecodeError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_DECODE_FAILED';
}

export class ImageUriUnsupportedError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_URI_UNSUPPORTED';
}

export class ImageWorkingCopyError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_WORKING_COPY_FAILED';
}

export class ImageDocumentClosedError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_DOCUMENT_CLOSED';
}

export class ImageStaleDocumentError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_STALE_DOCUMENT';
}

export class OcrUnavailableError extends AppError {
  readonly code: AppErrorCode = 'OCR_UNAVAILABLE';
}

export class OcrFailedError extends AppError {
  readonly code: AppErrorCode = 'OCR_FAILED';
}

export class OcrEmptyResultError extends AppError {
  readonly code: AppErrorCode = 'OCR_EMPTY_RESULT';
}

export class OcrInvalidResultError extends AppError {
  readonly code: AppErrorCode = 'OCR_INVALID_RESULT';
}

export class OcrInvalidBoundsError extends AppError {
  readonly code: AppErrorCode = 'OCR_INVALID_BOUNDS';
}

export class OcrStaleDocumentError extends AppError {
  readonly code: AppErrorCode = 'OCR_STALE_DOCUMENT';
}

export class OcrCancelledError extends AppError {
  readonly code: AppErrorCode = 'OCR_CANCELLED';
}

export class OcrImageReadError extends AppError {
  readonly code: AppErrorCode = 'OCR_IMAGE_READ_FAILED';
}

export class OcrUnsupportedImageError extends AppError {
  readonly code: AppErrorCode = 'OCR_UNSUPPORTED_IMAGE';
}

export class ImageTextSelectionInvalidError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_TEXT_SELECTION_INVALID';
}

export class ImageTextReplacementFailedError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_TEXT_REPLACEMENT_FAILED';
}

export class ImageBackgroundReconstructionFailedError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_BACKGROUND_RECONSTRUCTION_FAILED';
}

export class ImageTextFitFailedError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_TEXT_FIT_FAILED';
}

export class ImageUnsupportedFontError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_UNSUPPORTED_FONT';
}

export class ImageTextOverflowError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_TEXT_OVERFLOW';
}

export class ImageStaleSelectionError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_STALE_SELECTION';
}

export class ImagePatchFailedError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_PATCH_FAILED';
}

/** Image exceeds the on-device pixel budget for safe decoding, editing and export. */
export class ImageTooLargeError extends ImageInvalidDimensionsError {
  readonly code: AppErrorCode = 'IMAGE_TOO_LARGE';
}

export class ImageSaveError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_SAVE_FAILED';
}

/** Native export pipeline is not linked on this platform (never simulated outside tests). */
export class ImageExportUnavailableError extends ExportError {
  readonly code: AppErrorCode = 'IMAGE_EXPORT_UNAVAILABLE';
}

/**
 * Native background reconstruction is not linked on this platform. Never replaced by a
 * simulated patch outside tests: an edit must not report success without real pixels.
 */
export class ImageReconstructionUnavailableError extends BackgroundReconstructionError {
  readonly code: AppErrorCode = 'IMAGE_RECONSTRUCTION_UNAVAILABLE';
}

export class DocumentStorageError extends AppError {
  readonly code: AppErrorCode = 'DOCUMENT_STORAGE_FAILED';
}

/** The document is open, saving or otherwise in use and cannot be deleted right now. */
export class DocumentBusyError extends DocumentStorageError {
  readonly code: AppErrorCode = 'DOCUMENT_BUSY';
}

export class DocumentStorageCorruptedError extends DocumentStorageError {
  readonly code: AppErrorCode = 'DOCUMENT_STORAGE_CORRUPTED';
}

export class DocumentAssetMissingError extends DocumentStorageError {
  readonly code: AppErrorCode = 'DOCUMENT_ASSET_MISSING';
}

/** A page tool / markup operation (rotate, delete, move, insert, ink, shapes...) failed. */
export class PdfDocumentOperationError extends AppError {
  readonly code: AppErrorCode = 'PDF_DOCUMENT_OPERATION_FAILED';
}

export class PdfMergeError extends AppError {
  readonly code: AppErrorCode = 'PDF_MERGE_FAILED';
}

/** Creating a new PDF (from images) failed. */
export class PdfCreateError extends AppError {
  readonly code: AppErrorCode = 'PDF_CREATE_FAILED';
}

/** Rotating / flipping / cropping an image document failed. */
export class ImageTransformError extends AppError {
  readonly code: AppErrorCode = 'IMAGE_TRANSFORM_FAILED';
}
