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
}

export interface ExportResult {
  readonly destinationUri: string;
  readonly format: ExportFormat;
  readonly fileSizeBytes: number;
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
