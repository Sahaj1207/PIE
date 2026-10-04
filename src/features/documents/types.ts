import { DocumentMetadata } from '../../types/document';

export interface DocumentSummary {
  readonly id: string;
  readonly metadata: DocumentMetadata;
  readonly thumbnailUri?: string;
}

export interface DocumentImportResult {
  readonly documentId: string;
  readonly fileUri: string;
  readonly pageCount: number;
}
