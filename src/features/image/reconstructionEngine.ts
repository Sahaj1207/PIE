import { NativeModules } from 'react-native';
import { DocumentRect } from '../../types/geometry';
import {
  BackgroundReconstructionError,
  ImageReconstructionUnavailableError,
} from '../../errors';
import {
  IBackgroundReconstructionEngine,
  ReconstructedPatchResult,
} from './types';

const { ImageProcessingModule } = NativeModules;

// Same local declaration as HomeScreen: `process` is not guaranteed by the RN type config.
declare const process: any;

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * Validates a native reconstruction result. A patch without a file or with empty bounds
 * would let an edit "succeed" without replacing any pixels, so it is rejected.
 */
function toVerifiedPatchResult(result: any): ReconstructedPatchResult {
  const patchUri = typeof result?.patchUri === 'string' ? result.patchUri.trim() : '';
  const b = result?.bounds;
  const bounds = {
    x: Number(b?.x),
    y: Number(b?.y),
    width: Number(b?.width),
    height: Number(b?.height),
  };
  if (!patchUri) {
    throw new BackgroundReconstructionError(
      'Native background reconstruction returned no patch image.',
    );
  }
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !(bounds.width > 0) ||
    !(bounds.height > 0)
  ) {
    throw new BackgroundReconstructionError(
      'Native background reconstruction returned invalid patch bounds.',
    );
  }
  return {
    patchUri,
    bounds,
    estimatedBackgroundColor: result.estimatedBackgroundColor,
    estimatedTextColor: result.estimatedTextColor,
    confidence: result.confidence ?? 0.9,
    ...optionalInk(result),
  };
}

/** Optional ink measurements; dropped unless well-formed. */
function optionalInk(result: any): Pick<ReconstructedPatchResult, 'inkBounds' | 'inkColor'> {
  const out: { inkBounds?: DocumentRect; inkColor?: string } = {};
  const i = result?.inkBounds;
  if (i && [i.x, i.y, i.width, i.height].every((v) => Number.isFinite(Number(v))) && Number(i.width) > 0 && Number(i.height) > 0) {
    out.inkBounds = { x: Number(i.x), y: Number(i.y), width: Number(i.width), height: Number(i.height) };
  }
  if (typeof result?.inkColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(result.inkColor)) out.inkColor = result.inkColor;
  return out;
}

export class LocalBackgroundReconstructionEngine
  implements IBackgroundReconstructionEngine
{
  /**
   * @param options.outputDir Optional app-private directory for the generated patch PNG.
   *   When omitted the native default (cache) is used, preserving prior behavior.
   */
  async reconstructBackground(
    imageUri: string,
    region: DocumentRect,
    options?: { readonly outputDir?: string | null },
  ): Promise<ReconstructedPatchResult> {
    if (!imageUri) {
      throw new BackgroundReconstructionError(
        'Image URI is required for background reconstruction',
      );
    }

    if (region.width <= 0 || region.height <= 0) {
      throw new BackgroundReconstructionError(
        'Invalid bounding box dimensions for background reconstruction',
      );
    }

    const imageProcessingModule = NativeModules.ImageProcessingModule;
    if (imageProcessingModule && imageProcessingModule.reconstructBackground) {
      try {
        const outputDir = options?.outputDir;
        const result =
          outputDir && typeof imageProcessingModule.reconstructBackgroundToDirectory === 'function'
            ? await imageProcessingModule.reconstructBackgroundToDirectory(
                imageUri,
                region.x,
                region.y,
                region.width,
                region.height,
                outputDir,
              )
            : await imageProcessingModule.reconstructBackground(
                imageUri,
                region.x,
                region.y,
                region.width,
                region.height,
              );

        return toVerifiedPatchResult(result);
      } catch (err: unknown) {
        if (err instanceof BackgroundReconstructionError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new BackgroundReconstructionError(
          `Native background reconstruction failed: ${msg}`,
          err,
        );
      }
    }

    if (!isTestEnvironment()) {
      throw new ImageReconstructionUnavailableError(
        'Background reconstruction is not available on this platform: the native image processor is not linked.',
      );
    }

    // Simulated result for the Jest test environment only (never in the app).
    return {
      patchUri: '',
      bounds: {
        x: Math.max(0, region.x - 4),
        y: Math.max(0, region.y - 4),
        width: region.width + 8,
        height: region.height + 8,
      },
      estimatedBackgroundColor: '#FFFFFF',
      estimatedTextColor: '#111827',
      confidence: 0.85,
    };
  }
}

export const defaultReconstructionEngine = new LocalBackgroundReconstructionEngine();
