import { Document } from '../types/document';
import { DocumentSummary } from '../features/documents/types';
import { EditorSessionState } from '../features/editor/types';

export interface IDocumentStorage {
  /**
   * Retrieves summary list of all locally stored documents.
   */
  listDocuments(): Promise<DocumentSummary[]>;

  /**
   * Loads full document model by ID.
   */
  getDocument(id: string): Promise<Document | null>;

  /**
   * Persists a document model locally.
   */
  saveDocument(document: Document): Promise<void>;

  /**
   * Deletes a document and its associated local assets.
   */
  deleteDocument(id: string): Promise<void>;

  /**
   * Saves ongoing editor session state for autosave and recovery.
   */
  saveEditorSession(state: EditorSessionState): Promise<void>;

  /**
   * Retrieves last autosaved editor session state.
   */
  getEditorSession(documentId: string): Promise<EditorSessionState | null>;
}
