import { DocumentRect, DocumentSize } from './geometry';

export type DocumentKind = 'pdf' | 'image';

export type TextRegionStatus = 'detected' | 'modified' | 'deleted';

export interface TextStyleSpec {
  /** Font family name or descriptor if detected/known */
  readonly fontFamily?: string;
  /** Font size in document points */
  readonly fontSize: number;
  /** Font weight: 'normal' | 'bold' | '100'...'900' */
  readonly fontWeight?: string;
  /** Font style: 'normal' | 'italic' */
  readonly fontStyle?: 'normal' | 'italic';
  /** Hex color or RGBA string */
  readonly color: string;
  /** Text alignment */
  readonly alignment?: 'left' | 'center' | 'right' | 'justify';
  /** Letter spacing */
  readonly letterSpacing?: number;
  /** Line height in document points */
  readonly lineHeight?: number;
}

export interface TextRegion {
  /** Unique ID of the text region */
  readonly id: string;
  /** Page index (0-indexed) */
  readonly pageIndex: number;
  /** Bounding box in document coordinates */
  readonly bounds: DocumentRect;
  readonly originalBounds?: DocumentRect;
  /** Original text detected by OCR / extracted from PDF */
  readonly originalText: string;
  /** Current text after user edits */
  readonly currentText: string;
  /** Status of the region */
  readonly status: TextRegionStatus;
  /** Associated text styling */
  readonly style: TextStyleSpec;
  /** OCR detection confidence (0.0 to 1.0) if applicable */
  readonly confidence?: number;
  /** Local URI of the reconstructed background patch image, if text was modified/removed */
  readonly reconstructedPatchUri?: string;
  /** Bounding box in document coordinates for the reconstructed patch (including any padding) */
  readonly reconstructedPatchBounds?: DocumentRect;
  /**
   * Set when a persisted document is reopened and the reconstructed patch file for this
   * region can no longer be found. The edit status is preserved; the patch must be regenerated.
   */
  readonly patchUnavailable?: boolean;
}

export interface AddedTextElement {
  /** Unique ID */
  readonly id: string;
  /** Page index (0-indexed) */
  readonly pageIndex: number;
  /** Bounding box in document coordinates */
  readonly bounds: DocumentRect;
  /** Text content; explicit newlines are preserved as separate lines. */
  readonly text: string;
  /** Text style (font family, size, weight, style, color, alignment, line height). */
  readonly style: TextStyleSpec;
  /**
   * Optional wrap width in document pixels. When set, lines longer than this wrap at
   * whitespace (deterministically, via the shared text layout). Unset = only explicit
   * newlines break lines.
   */
  readonly wrapWidth?: number;
}

/**
 * Markup drawn on an image page (pen, highlighter, shapes, signatures). Path commands are in
 * document (image pixel) coordinates: ['M',x,y] ['L',x,y] ['Q',cx,cy,x,y] ['C',...] ['Z'].
 * Drawn above all other layers by both the canvas and the exporter.
 */
export interface ImageDrawing {
  readonly id: string;
  readonly pageIndex: number;
  readonly kind: 'ink' | 'highlighter' | 'shape' | 'signature';
  readonly commands: readonly (readonly (string | number)[])[];
  readonly color: string;
  /** Stroke width in document pixels. */
  readonly width: number;
  readonly opacity: number;
}

export interface OriginalContentRef {
  readonly pageIndex: number;
  /** URI of the original page image / cached raster */
  readonly assetUri?: string;
  /** Native width of original content */
  readonly width: number;
  /** Native height of original content */
  readonly height: number;
  /** Dots per inch / resolution */
  readonly dpi?: number;
  /**
   * Optional downsampled display proxy of the working image (same aspect ratio).
   * Used only for on-screen rendering; editing, OCR and export use assetUri at full resolution.
   */
  readonly previewUri?: string;
  /**
   * EXIF orientation of the imported source file. The working copy at assetUri is always
   * stored upright (orientation 1), so width/height above are already display-oriented.
   */
  readonly sourceOrientation?: number;
}

export interface DocumentPage {
  /** Unique ID */
  readonly id: string;
  /** Page index (0-indexed) */
  readonly pageIndex: number;
  /** Page dimensions in document coordinates (points) */
  readonly dimensions: DocumentSize;
  /** Clockwise rotation in degrees (0, 90, 180, 270) */
  readonly rotation: number;
  /** Reference to original underlying raster/content */
  readonly originalContent: OriginalContentRef;
  /** Editable text regions (detected or modified) */
  readonly editableTextRegions: TextRegion[];
  /** New text elements added by user */
  readonly addedText: AddedTextElement[];
  /** Markup drawings (optional; absent in documents saved before markup existed). */
  readonly drawings?: ImageDrawing[];
}

export interface DocumentMetadata {
  readonly id: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly sourceUri: string;
  readonly pageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fileSizeBytes?: number;
}

export interface Document {
  readonly id: string;
  readonly metadata: DocumentMetadata;
  readonly pages: DocumentPage[];
}
