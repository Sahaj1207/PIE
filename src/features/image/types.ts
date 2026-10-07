import { DocumentRect, ViewportTransform } from '../../types/geometry';
import { TextStyleSpec } from '../../types/document';
import { NotImplementedError } from '../../errors';

export type ImageDirtyState = 'CLEAN' | 'DIRTY' | 'SAVING' | 'SAVE_FAILED';
export type ImageSessionState = 'IDLE' | 'LOADING' | 'READY' | 'CLOSED' | 'ERROR';

export type TextFitState =
  | 'PRESERVED'
  | 'SCALED_DOWN'
  | 'EXPANDED_WITHIN_SAFE_BOUNDS'
  | 'OVERFLOW'
  | 'UNSUPPORTED';

export interface TextFitAnalysis {
  readonly state: TextFitState;
  readonly fittedFontSize: number;
  readonly fittedBounds: DocumentRect;
  readonly baselineY: number;
  readonly scaleFactor: number;
  readonly isOverflow: boolean;
}

export interface ImageSourceMetadata {
  readonly fileName?: string;
  readonly fileSizeBytes?: number;
  readonly lastModified?: number;
  readonly originalFormat?: string;
  readonly exifOrientation?: number;
}

export interface ImageTextReplacementRequest {
  readonly documentId: string;
  readonly elementId: string;
  readonly originalText: string;
  readonly replacementText: string;
  readonly bounds: DocumentRect;
  readonly estimatedFontSize: number;
  readonly estimatedTextColor: string;
  readonly alignment?: 'left' | 'center' | 'right';
  readonly blockId?: string;
  readonly lineId?: string;
  readonly confidence?: number;
  readonly style?: Partial<TextStyleSpec>;
}

export interface ImageEditPatch {
  readonly patchId: string;
  readonly documentId: string;
  readonly targetElementId: string;
  readonly bounds: DocumentRect;
  readonly backgroundReconstruction: {
    readonly patchUri?: string;
    readonly bounds: DocumentRect;
    readonly estimatedBackgroundColor?: string;
    readonly estimatedTextColor?: string;
    readonly confidence?: number;
    readonly isGradient?: boolean;
  };
  readonly replacementText: string;
  readonly textStyle: TextStyleSpec;
  readonly baselineY: number;
  readonly fittedFontSize: number;
  readonly zOrder: number;
  readonly status: 'applied' | 'deleted' | 'preview';
  readonly createdAt: number;
}

export interface ImageDocumentModel {
  readonly documentId: string;
  readonly sourceUri: string;
  readonly workingUri: string;
  readonly mimeType: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly orientation: number;
  readonly sourceMetadata?: ImageSourceMetadata;
  readonly dirtyState: ImageDirtyState;
}

export interface IImageDocumentSession {
  readonly model: ImageDocumentModel;
  readonly sessionState: ImageSessionState;
  readonly viewportTransform: ViewportTransform;
  readonly patches: ImageEditPatch[];
  updateViewportTransform(transform: ViewportTransform): void;
  markDirty(dirty: boolean): void;
  isDirty(): boolean;
  getCanonicalDimensions(): { width: number; height: number };
  addPatch(patch: ImageEditPatch): void;
  removePatch(patchId: string): void;
  getPatch(patchId: string): ImageEditPatch | undefined;
  close(): void;
  isClosed(): boolean;
}

export interface ReconstructedPatchResult {
  readonly patchUri: string;
  readonly bounds: DocumentRect;
  readonly estimatedBackgroundColor?: string;
  readonly estimatedTextColor?: string;
  readonly confidence?: number;
  /** Bounding box of the detected text pixels inside the OCR box (image pixels), when found. */
  readonly inkBounds?: DocumentRect;
  /** Colour of the text stroke cores (anti-aliased edges excluded), when found. */
  readonly inkColor?: string;
}

export interface IBackgroundReconstructionEngine {
  /**
   * Reconstructs the background pixels where text was removed,
   * using local texture synthesis / inpainting.
   */
  reconstructBackground(
    imageUri: string,
    region: DocumentRect,
  ): Promise<ReconstructedPatchResult>;
}

export class UnconfiguredBackgroundReconstructionEngine
  implements IBackgroundReconstructionEngine
{
  async reconstructBackground(): Promise<ReconstructedPatchResult> {
    throw new NotImplementedError('Background Reconstruction Engine');
  }
}
