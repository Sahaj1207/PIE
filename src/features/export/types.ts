import { Document } from '../../types/document';
import { NotImplementedError } from '../../errors';

export type ExportFormat = 'pdf' | 'png' | 'jpeg';

export interface ExportOptions {
  readonly format: ExportFormat;
  /** Quality level 1-100 for raster export */
  readonly quality?: number;
  /** Target resolution DPI for raster export (default: 300) */
  readonly targetDpi?: number;
  /** Specific pages to export (default: all) */
  readonly pageIndices?: number[];
  /**
   * Where the exported file should become visible.
   * - 'file' (default): app-private export file only (suitable for Share).
   * - 'gallery': additionally publish to the device photo library (Android 10+:
   *   MediaStore Pictures/PIE). On platforms without gallery support the export
   *   still succeeds and `savedToGallery` is false.
   */
  readonly destination?: ExportDestination;
  /** Base file name (without extension) for the exported image. */
  readonly displayName?: string;
}

export type ExportDestination = 'file' | 'gallery';

export interface ExportResult {
  readonly destinationUri: string;
  readonly format: ExportFormat;
  readonly fileSizeBytes: number;
  /** content:// URI of the photo library entry when published to the gallery. */
  readonly galleryUri?: string;
  /** True only when the image was actually written to the photo library. */
  readonly savedToGallery?: boolean;
  readonly width?: number;
  readonly height?: number;
}

export interface IExportEngine {
  /**
   * Exports an edited document into high-fidelity PDF or raster image format.
   */
  exportDocument(
    document: Document,
    options: ExportOptions,
  ): Promise<ExportResult>;
}

export class UnconfiguredExportEngine implements IExportEngine {
  async exportDocument(): Promise<ExportResult> {
    throw new NotImplementedError('Export Engine');
  }
}
