import { NativeModules } from 'react-native';
import { Document } from '../../types/document';
import { ExportError, ImageExportUnavailableError } from '../../errors';
import { buildImageRenderPlan } from '../image/imageRenderPlan';
import { defaultTextMeasurer } from '../image/textMeasurement';
import { TextMeasurer } from '../text/textLayout';

// `process` is not guaranteed by the React Native type config (see HomeScreen).
declare const process: any;
import {
  ExportFormat,
  ExportOptions,
  ExportResult,
  IExportEngine,
} from './types';

/** Upper bound of decoded pixels the native exporter accepts before refusing (OOM guard). */
export const MAX_EXPORT_PIXELS = 50_000_000;

/** Simulated native results are only permitted inside the Jest test environment. */
function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test';
}

function sanitizeDisplayName(name?: string): string {
  const base = (name || 'PIE_Export')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base.length > 0 ? base.substring(0, 80) : 'PIE_Export';
}

export class ImageExportEngine implements IExportEngine {
  private isExporting: boolean = false;

  /** @param measureText text measurer for the render plan; must match the canvas's. */
  constructor(private readonly measureText: TextMeasurer = defaultTextMeasurer) {}

  async exportDocument(
    document: Document,
    options: ExportOptions = { format: 'png' },
  ): Promise<ExportResult> {
    if (!document) {
      throw new ExportError('Document is required for export');
    }

    if (this.isExporting) {
      throw new ExportError('An export operation is already in progress');
    }

    if (document.metadata.kind !== 'image') {
      throw new ExportError(
        `Document of kind '${document.metadata.kind}' is not supported for image export in this phase`,
      );
    }

    if (!document.pages || document.pages.length === 0) {
      throw new ExportError('Document has no pages to export');
    }

    const safeOptions = options || { format: 'png' };
    const pageIndex = safeOptions.pageIndices?.[0] ?? 0;
    const page = document.pages[pageIndex] || document.pages[0];

    // Always export from the full-resolution working image, never the display preview.
    const sourceImageUri = page.originalContent.assetUri;
    if (!sourceImageUri) {
      throw new ExportError('Source image asset URI is missing');
    }

    const format = (safeOptions.format || 'png').toLowerCase();
    if (format !== 'png' && format !== 'jpeg') {
      throw new ExportError(
        `Unsupported export format '${options.format}'. Only 'png' and 'jpeg' are supported.`,
      );
    }

    const quality =
      options.quality !== undefined
        ? Math.max(1, Math.min(100, Math.round(options.quality)))
        : format === 'png'
        ? 100
        : 95;

    const destination = safeOptions.destination === 'gallery' ? 'gallery' : 'file';
    const displayName = sanitizeDisplayName(safeOptions.displayName || document.metadata.title);

    this.isExporting = true;
    try {
      // Same composition plan the on-screen canvas renders (WYSIWYG export), built with the
      // same text measurer, so line breaks and line positions are identical.
      const plan = buildImageRenderPlan(page, { measureText: this.measureText });

      const patches = plan.patches.map((p) => ({
        patchUri: p.patchUri,
        bounds: p.bounds,
      }));

      const textElements = plan.textElements.map((t) => ({
        text: t.text,
        bounds: t.bounds,
        fittedFontSize: t.fittedFontSize,
        baselineY: t.baselineY,
        drawX: t.drawX,
        color: t.color,
        fontWeight: t.fontWeight,
        fontStyle: t.fontStyle,
        fontFamily: t.fontFamily,
        // Lines exactly as planned (document coordinates); the exporter draws them as-is.
        lines: t.lines.map((l) => ({ text: l.text, x: l.x, baselineY: l.baselineY })),
      }));

      const imageProcessingModule = NativeModules.ImageProcessingModule;
      if (imageProcessingModule && imageProcessingModule.exportImagePage) {
        try {
          const result = await imageProcessingModule.exportImagePage({
            sourceImageUri,
            format,
            quality,
            patches,
            textElements,
            drawings: plan.drawings.map((d) => ({
              commands: d.commands,
              color: d.color,
              width: d.width,
              opacity: d.opacity,
              multiply: d.multiply,
            })),
            destination,
            displayName,
            maxPixels: MAX_EXPORT_PIXELS,
          });

          return {
            destinationUri: result.destinationUri,
            format: result.format === 'png' ? 'png' : 'jpeg',
            fileSizeBytes: result.fileSizeBytes,
            galleryUri: typeof result.galleryUri === 'string' ? result.galleryUri : undefined,
            savedToGallery: result.savedToGallery === true,
            width: typeof result.width === 'number' ? result.width : undefined,
            height: typeof result.height === 'number' ? result.height : undefined,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new ExportError(`Native export failed: ${msg}`, err);
        }
      }

      if (!isTestEnvironment()) {
        throw new ImageExportUnavailableError(
          'Image export is not available on this platform: the native image exporter is not linked.',
        );
      }

      // Simulated result for the Jest test environment only.
      return {
        destinationUri: `file:///simulated/exports/export_${Date.now()}.${format === 'png' ? 'png' : 'jpg'}`,
        format: format === 'png' ? 'png' : 'jpeg',
        fileSizeBytes: 1048576, // 1MB simulated size
        savedToGallery: false,
      };
    } finally {
      this.isExporting = false;
    }
  }

  async shareExportedFile(
    destinationUri: string,
    format: ExportFormat,
    title: string = 'Share Exported Image',
  ): Promise<boolean> {
    if (!destinationUri) {
      throw new ExportError('File destination URI is required to share');
    }

    const mimeType =
      format === 'png'
        ? 'image/png'
        : format === 'jpeg'
        ? 'image/jpeg'
        : 'application/pdf';
    const imageProcessingModule = NativeModules.ImageProcessingModule;

    if (imageProcessingModule && imageProcessingModule.shareFile) {
      try {
        return await imageProcessingModule.shareFile(destinationUri, mimeType, title);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ExportError(`Failed to share exported file: ${msg}`, err);
      }
    }

    if (!isTestEnvironment()) {
      throw new ImageExportUnavailableError(
        'Sharing is not available on this platform: the native share bridge is not linked.',
      );
    }
    return true;
  }
}

export const defaultExportEngine = new ImageExportEngine();
