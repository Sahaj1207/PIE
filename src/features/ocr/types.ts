import { DocumentPoint, DocumentRect, DocumentSize } from '../../types/geometry';
import { TextRegion } from '../../types/document';

export type OcrExecutionState =
  | 'IDLE'
  | 'DETECTING'
  | 'READY'
  | 'EMPTY'
  | 'FAILED'
  | 'CANCELLED';

export interface RawBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawOcrWord {
  text: string;
  confidence?: number;
  boundingBox?: RawBoundingBox;
}

export interface RawOcrLine {
  text: string;
  confidence?: number;
  boundingBox?: RawBoundingBox;
  words?: RawOcrWord[];
}

export interface RawOcrBlock {
  text: string;
  boundingBox?: RawBoundingBox;
  lines?: RawOcrLine[];
}

export interface RawNativeOcrResult {
  fullText: string;
  imageWidth: number;
  imageHeight: number;
  blocks: RawOcrBlock[];
}

/** Canonical OCR Element (Word/Token) */
export interface OcrElement {
  readonly id: string;
  readonly text: string;
  readonly bounds: DocumentRect;
  readonly confidence?: number;
  readonly blockId: string;
  readonly lineId: string;
  readonly index: number;
}

/** Backward-compatibility alias */
export type OcrWord = OcrElement;

/** Canonical OCR Line */
export interface OcrLine {
  readonly id: string;
  readonly text: string;
  readonly bounds: DocumentRect;
  readonly confidence?: number;
  readonly blockId: string;
  readonly elements: OcrElement[];
  /** Backward-compatibility alias for words */
  readonly words: OcrElement[];
}

/** Canonical OCR Block (Paragraph / Section) */
export interface OcrBlock {
  readonly id: string;
  readonly text: string;
  readonly bounds: DocumentRect;
  readonly confidence?: number;
  readonly lines: OcrLine[];
}

/** Canonical OCR Document Model */
export interface OcrDocument {
  readonly documentId: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly fullText: string;
  readonly blocks: OcrBlock[];
  readonly recognizedAt: number;
  readonly version?: string;
}

/** Backward-compatibility representation for OcrResult */
export interface OcrResult {
  readonly fullText: string;
  readonly imageDimensions: DocumentSize;
  readonly blocks: OcrBlock[];
  readonly processedAt: number;
}

export interface OcrSelectionState {
  readonly documentId: string;
  readonly elementId: string;
  readonly text: string;
  readonly bounds: DocumentRect;
  readonly blockId: string;
  readonly lineId: string;
  readonly confidence?: number;
}

export interface OcrProcessingOptions {
  /** Optional language hint */
  readonly languageHints?: string[];
  /** Minimum confidence threshold between 0.0 and 1.0 */
  readonly confidenceThreshold?: number;
  /**
   * Upright pixel size of the image (the document's dimensions). Enables deterministic
   * preprocessing (see ocrPreprocessing.ts) and maps results into document coordinates.
   */
  readonly imageSize?: { readonly width: number; readonly height: number };
}

export interface IOcrEngine {
  /**
   * Recognizes text on-device from a local image asset URI and returns canonical OcrDocument.
   */
  recognizeOcrDocument(
    documentId: string,
    assetUri: string,
    options?: OcrProcessingOptions,
  ): Promise<OcrDocument>;

  /**
   * Recognizes text on-device from a local image asset URI (backwards-compatible OcrResult).
   */
  recognizeText(
    assetUri: string,
    options?: OcrProcessingOptions,
  ): Promise<OcrResult>;

  /**
   * Extracts editable text regions in document coordinates from an image.
   */
  extractTextRegions(
    assetUri: string,
    pageIndex: number,
    options?: OcrProcessingOptions,
  ): Promise<TextRegion[]>;
}
