import { ViewportTransform } from '../../types/geometry';
import {
  ImageDirtyState,
  ImageDocumentModel,
  ImageEditPatch,
  ImageSessionState,
  ImageSourceMetadata,
  IImageDocumentSession,
} from './types';
import {
  ImageDocumentClosedError,
  ImageInvalidDimensionsError,
  ImageStaleDocumentError,
} from '../../errors';
import { DEFAULT_IMAGE_SCALE } from './imageViewportMath';

export interface CreateImageSessionOptions {
  readonly documentId: string;
  readonly sourceUri: string;
  readonly workingUri?: string;
  readonly mimeType?: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly orientation?: number;
  readonly sourceMetadata?: ImageSourceMetadata;
  readonly initialDirtyState?: ImageDirtyState;
}

export class ImageDocumentSession implements IImageDocumentSession {
  private _model: ImageDocumentModel;
  private _sessionState: ImageSessionState = 'READY';
  private _viewportTransform: ViewportTransform;
  private _patches: ImageEditPatch[] = [];

  constructor(options: CreateImageSessionOptions) {
    const {
      documentId,
      sourceUri,
      workingUri = sourceUri,
      mimeType = 'image/jpeg',
      intrinsicWidth,
      intrinsicHeight,
      orientation = 1,
      sourceMetadata,
      initialDirtyState = 'CLEAN',
    } = options;

    if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
      throw new ImageInvalidDimensionsError(
        `Invalid image dimensions: ${intrinsicWidth}x${intrinsicHeight}. Dimensions must be positive numbers.`,
      );
    }

    this._model = {
      documentId,
      sourceUri,
      workingUri,
      mimeType,
      intrinsicWidth,
      intrinsicHeight,
      orientation,
      sourceMetadata,
      dirtyState: initialDirtyState,
    };

    this._viewportTransform = {
      scale: DEFAULT_IMAGE_SCALE,
      translateX: 0,
      translateY: 0,
    };
  }

  get model(): ImageDocumentModel {
    this.ensureNotClosed();
    return this._model;
  }

  get sessionState(): ImageSessionState {
    return this._sessionState;
  }

  get viewportTransform(): ViewportTransform {
    this.ensureNotClosed();
    return this._viewportTransform;
  }

  get patches(): ImageEditPatch[] {
    this.ensureNotClosed();
    return [...this._patches];
  }

  /**
   * Updates viewport zoom and pan.
   * Crucial Requirement: Viewport changes are NOT document edits and must NOT mark the document dirty.
   */
  updateViewportTransform(transform: ViewportTransform): void {
    this.ensureNotClosed();
    this._viewportTransform = {
      scale: transform.scale,
      translateX: transform.translateX,
      translateY: transform.translateY,
    };
  }

  /**
   * Updates document dirty state.
   */
  markDirty(dirty: boolean): void {
    this.ensureNotClosed();
    this._model = {
      ...this._model,
      dirtyState: dirty ? 'DIRTY' : 'CLEAN',
    };
  }

  setDirtyState(state: ImageDirtyState): void {
    this.ensureNotClosed();
    this._model = {
      ...this._model,
      dirtyState: state,
    };
  }

  isDirty(): boolean {
    if (this._sessionState === 'CLOSED') return false;
    return this._model.dirtyState === 'DIRTY';
  }

  /**
   * Adds or updates an image edit patch.
   * Automatically marks the document DIRTY.
   */
  addPatch(patch: ImageEditPatch): void {
    this.ensureNotClosed();
    if (patch.documentId !== this._model.documentId) {
      throw new ImageStaleDocumentError(
        `Patch document ID (${patch.documentId}) does not match session document ID (${this._model.documentId})`,
      );
    }

    // Replace if same patchId exists, otherwise append
    const existingIndex = this._patches.findIndex((p) => p.patchId === patch.patchId);
    if (existingIndex >= 0) {
      this._patches[existingIndex] = patch;
    } else {
      this._patches.push(patch);
    }

    // Applying an edit patch marks document DIRTY
    if (patch.status !== 'preview') {
      this._model = {
        ...this._model,
        dirtyState: 'DIRTY',
      };
    }
  }

  /**
   * Removes an edit patch by ID.
   * If all patches are removed, returns to CLEAN state.
   */
  removePatch(patchId: string): void {
    this.ensureNotClosed();
    const prevLen = this._patches.length;
    this._patches = this._patches.filter((p) => p.patchId !== patchId);
    if (this._patches.length !== prevLen) {
      if (this._patches.length === 0) {
        this._model = {
          ...this._model,
          dirtyState: 'CLEAN',
        };
      } else {
        this._model = {
          ...this._model,
          dirtyState: 'DIRTY',
        };
      }
    }
  }

  getPatch(patchId: string): ImageEditPatch | undefined {
    this.ensureNotClosed();
    return this._patches.find((p) => p.patchId === patchId);
  }

  getPatchesForElement(elementId: string): ImageEditPatch[] {
    this.ensureNotClosed();
    return this._patches.filter((p) => p.targetElementId === elementId);
  }

  clearPatches(): void {
    this.ensureNotClosed();
    this._patches = [];
    this._model = {
      ...this._model,
      dirtyState: 'CLEAN',
    };
  }

  /**
   * Resolves canonical dimensions in display/document coordinate space.
   * If EXIF orientation indicates 90 or 270 degree rotation (EXIF 6 or 8),
   * width and height are transposed so coordinate mapping aligns with the displayed image.
   */
  getCanonicalDimensions(): { width: number; height: number } {
    this.ensureNotClosed();
    const { intrinsicWidth, intrinsicHeight, orientation } = this._model;
    if (orientation === 6 || orientation === 8) {
      return { width: intrinsicHeight, height: intrinsicWidth };
    }
    return { width: intrinsicWidth, height: intrinsicHeight };
  }

  setWorkingUri(uri: string): void {
    this.ensureNotClosed();
    this._model = {
      ...this._model,
      workingUri: uri,
    };
  }

  /**
   * Releases session and cleans up resources. Idempotent.
   */
  close(): void {
    if (this._sessionState === 'CLOSED') {
      return;
    }
    this._sessionState = 'CLOSED';
  }

  isClosed(): boolean {
    return this._sessionState === 'CLOSED';
  }

  private ensureNotClosed(): void {
    if (this._sessionState === 'CLOSED') {
      throw new ImageDocumentClosedError('Image document session has been closed.');
    }
  }
}
