import { DocumentRect } from '../../types/geometry';
import { TextStyleSpec } from '../../types/document';
import {
  ImageBackgroundReconstructionFailedError,
  ImageInvalidDimensionsError,
  ImageStaleDocumentError,
  ImageTextFitFailedError,
  ImageTextSelectionInvalidError,
} from '../../errors';
import {
  IImageDocumentSession,
  ImageEditPatch,
  ImageTextReplacementRequest,
} from './types';
import { defaultReconstructionEngine } from './reconstructionEngine';
import {
  analyzeTextFitting,
  estimateTextStyle,
  resolveSystemFontFamily,
} from '../text/textFitting';

export class ImageEditingEngine {
  /**
   * Generates a preview patch for the given replacement request without committing to session.
   */
  async createPreviewPatch(
    session: IImageDocumentSession,
    request: ImageTextReplacementRequest,
  ): Promise<ImageEditPatch> {
    return this.buildPatch(session, request, 'preview');
  }

  /**
   * Generates and validates an applied replacement patch for the given request.
   */
  async createReplacementPatch(
    session: IImageDocumentSession,
    request: ImageTextReplacementRequest,
  ): Promise<ImageEditPatch> {
    return this.buildPatch(session, request, 'applied');
  }

  /**
   * Generates a deletion patch which reconstructs the background and clears text.
   */
  async createDeletePatch(
    session: IImageDocumentSession,
    elementId: string,
    bounds: DocumentRect,
    originalText: string = '',
  ): Promise<ImageEditPatch> {
    if (!elementId) {
      throw new ImageTextSelectionInvalidError('Cannot delete: element ID is missing.');
    }

    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new ImageInvalidDimensionsError('Cannot delete: invalid bounding box.');
    }

    const deleteRequest: ImageTextReplacementRequest = {
      documentId: session.model.documentId,
      elementId,
      originalText,
      replacementText: '',
      bounds,
      estimatedFontSize: Math.max(8, Math.round(bounds.height * 0.78)),
      estimatedTextColor: '#111827',
    };

    return this.buildPatch(session, deleteRequest, 'deleted');
  }

  private async buildPatch(
    session: IImageDocumentSession,
    request: ImageTextReplacementRequest,
    status: 'applied' | 'preview' | 'deleted',
  ): Promise<ImageEditPatch> {
    // 1. Verify session match
    if (request.documentId !== session.model.documentId) {
      throw new ImageStaleDocumentError(
        `Replacement request document (${request.documentId}) does not match session (${session.model.documentId})`,
      );
    }

    // 2. Validate target selection
    if (!request.elementId) {
      throw new ImageTextSelectionInvalidError('Replacement target element ID is missing.');
    }
    if (!request.bounds) {
      throw new ImageTextSelectionInvalidError('Replacement target bounds are missing.');
    }
    if (request.bounds.width <= 0 || request.bounds.height <= 0) {
      throw new ImageInvalidDimensionsError(
        `Invalid replacement target bounds: ${request.bounds.width}x${request.bounds.height}`,
      );
    }

    // 3. Analyze text fitting
    const fitAnalysis = analyzeTextFitting(
      request.bounds,
      request.originalText,
      request.replacementText,
      request.style,
    );

    if (fitAnalysis.state === 'UNSUPPORTED') {
      throw new ImageTextFitFailedError(
        'Replacement text fitting failed: target region is unsupported or degenerate.',
      );
    }

    // 4. Resolve typography styling
    const baseStyle = estimateTextStyle(request.bounds, {
      ocrConfidence: request.confidence,
      colorSample: request.estimatedTextColor,
      alignment: request.alignment,
    });

    const textStyle: TextStyleSpec = {
      fontFamily: resolveSystemFontFamily(request.style?.fontFamily || baseStyle.fontFamily),
      fontSize: fitAnalysis.fittedFontSize,
      color: request.style?.color || request.estimatedTextColor || baseStyle.color,
      fontWeight: request.style?.fontWeight || baseStyle.fontWeight,
      fontStyle: request.style?.fontStyle || baseStyle.fontStyle,
    };

    // 5. Reconstruct background for the target region
    let patchUri = '';
    let patchBounds = request.bounds;
    let estimatedBg = '#FFFFFF';
    let estimatedTextColor = '#111827';
    let confidence = 0.9;

    try {
      const reconResult = await defaultReconstructionEngine.reconstructBackground(
        session.model.sourceUri,
        request.bounds,
      );
      patchUri = reconResult.patchUri;
      patchBounds = reconResult.bounds;
      estimatedBg = reconResult.estimatedBackgroundColor || '#FFFFFF';
      estimatedTextColor = reconResult.estimatedTextColor || '#111827';
      confidence = reconResult.confidence ?? 0.9;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ImageBackgroundReconstructionFailedError(
        `Background reconstruction failed for region: ${msg}`,
      );
    }

    // Determine z-order deterministically
    const currentPatches = session.patches;
    const maxZ = currentPatches.length > 0 ? Math.max(...currentPatches.map((p) => p.zOrder)) : 0;
    const zOrder = maxZ + 1;

    const patch: ImageEditPatch = {
      patchId: `patch-${request.elementId}-${Date.now()}`,
      documentId: session.model.documentId,
      targetElementId: request.elementId,
      bounds: request.bounds,
      backgroundReconstruction: {
        patchUri,
        bounds: patchBounds,
        estimatedBackgroundColor: estimatedBg,
        estimatedTextColor,
        confidence,
      },
      replacementText: request.replacementText,
      textStyle,
      baselineY: fitAnalysis.baselineY,
      fittedFontSize: fitAnalysis.fittedFontSize,
      zOrder,
      status,
      createdAt: Date.now(),
    };

    return patch;
  }
}

/**
 * Domain-level undo/redo manager specifically for image patches.
 * Avoids storing full-resolution bitmap copies, preserving source immutability.
 */
export class ImagePatchHistoryManager {
  private past: ImageEditPatch[][] = [];
  private present: ImageEditPatch[] = [];
  private future: ImageEditPatch[][] = [];

  initialize(initialPatches: ImageEditPatch[] = []): void {
    this.past = [];
    this.present = [...initialPatches];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get currentPatches(): ImageEditPatch[] {
    return [...this.present];
  }

  applyPatch(patch: ImageEditPatch): ImageEditPatch[] {
    this.past.push([...this.present]);
    // Replace if targetElementId already patched, or append
    const existingIndex = this.present.findIndex(
      (p) => p.targetElementId === patch.targetElementId,
    );
    if (existingIndex >= 0) {
      const updated = [...this.present];
      updated[existingIndex] = patch;
      this.present = updated;
    } else {
      this.present = [...this.present, patch];
    }
    // Clear redo stack on any new edit
    this.future = [];
    return [...this.present];
  }

  undo(): ImageEditPatch[] | null {
    if (this.past.length === 0) return null;
    const previous = this.past.pop()!;
    this.future.unshift([...this.present]);
    this.present = previous;
    return [...this.present];
  }

  redo(): ImageEditPatch[] | null {
    if (this.future.length === 0) return null;
    const next = this.future.shift()!;
    this.past.push([...this.present]);
    this.present = next;
    return [...this.present];
  }

  clear(): void {
    this.past = [];
    this.present = [];
    this.future = [];
  }
}

export const defaultImageEditingEngine = new ImageEditingEngine();
