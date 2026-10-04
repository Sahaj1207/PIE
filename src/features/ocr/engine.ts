import { NativeModules, Platform } from 'react-native';
import { TextRegion } from '../../types/document';
import {
  OcrFailedError,
  OcrImageReadError,
  OcrProcessingError,
  OcrUnavailableError,
} from '../../errors';
import {
  IOcrEngine,
  OcrDocument,
  OcrProcessingOptions,
  OcrResult,
  RawNativeOcrResult,
} from './types';
import {
  normalizeRawNativeOcrResult,
  normalizeToOcrDocument,
  ocrResultToTextRegions,
} from './normalization';
import { defaultOcrCache } from './ocrCache';

export class OnDeviceOcrEngine implements IOcrEngine {
  private getNativeModule() {
    return NativeModules.OcrNativeModule;
  }

  /**
   * Recognizes text on-device from a local image asset URI and returns canonical OcrDocument.
   * Utilizes local caching to avoid redundant native ML Kit / Vision processing.
   */
  async recognizeOcrDocument(
    documentId: string,
    assetUri: string,
    _options?: OcrProcessingOptions,
  ): Promise<OcrDocument> {
    if (!assetUri || !assetUri.trim()) {
      throw new OcrImageReadError('Asset URI cannot be empty');
    }

    // Check cache first
    const cached = defaultOcrCache.get(documentId, assetUri);
    if (cached) {
      return cached;
    }

    const nativeMod = this.getNativeModule();
    if (!nativeMod) {
      throw new OcrUnavailableError(
        `OcrNativeModule is not linked on platform: ${Platform.OS}. Verify native project configuration.`,
      );
    }

    try {
      const rawResult: RawNativeOcrResult = await nativeMod.recognizeText(assetUri);
      const ocrDocument = normalizeToOcrDocument(rawResult, documentId);

      // Cache result
      defaultOcrCache.set(documentId, assetUri, ocrDocument);
      return ocrDocument;
    } catch (err: unknown) {
      if (err instanceof OcrUnavailableError || err instanceof OcrImageReadError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new OcrFailedError(`On-device OCR failed: ${message}`, err);
    }
  }

  /**
   * Backwards-compatible recognizeText returning OcrResult.
   */
  async recognizeText(
    assetUri: string,
    options?: OcrProcessingOptions,
  ): Promise<OcrResult> {
    if (!assetUri || !assetUri.trim()) {
      throw new OcrProcessingError('Asset URI cannot be empty');
    }

    const nativeMod = this.getNativeModule();
    if (!nativeMod) {
      throw new OcrProcessingError(
        `OcrNativeModule is not linked on platform: ${Platform.OS}. Verify native project configuration.`,
      );
    }

    try {
      const rawResult: RawNativeOcrResult = await nativeMod.recognizeText(assetUri);
      return normalizeRawNativeOcrResult(rawResult);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OcrProcessingError(`On-device OCR failed: ${message}`, err);
    }
  }

  async extractTextRegions(
    assetUri: string,
    pageIndex = 0,
    options?: OcrProcessingOptions,
  ): Promise<TextRegion[]> {
    const ocrResult = await this.recognizeText(assetUri, options);
    return ocrResultToTextRegions(ocrResult, pageIndex);
  }
}

export const defaultOcrEngine = new OnDeviceOcrEngine();
