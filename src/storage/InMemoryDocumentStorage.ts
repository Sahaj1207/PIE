import { Document } from '../types/document';
import { DocumentSummary } from '../features/documents/types';
import { EditorSessionState } from '../features/editor/types';
import { IDocumentStorage } from './types';

export class InMemoryDocumentStorage implements IDocumentStorage {
  private documents = new Map<string, Document>();
  private sessions = new Map<string, EditorSessionState>();

  async listDocuments(): Promise<DocumentSummary[]> {
    const list: DocumentSummary[] = [];
    for (const doc of this.documents.values()) {
      list.push({
        id: doc.id,
        metadata: doc.metadata,
      });
    }
    return list.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
  }

  async getDocument(id: string): Promise<Document | null> {
    const doc = this.documents.get(id);
    return doc ? JSON.parse(JSON.stringify(doc)) : null;
  }

  async saveDocument(document: Document): Promise<void> {
    this.documents.set(document.id, JSON.parse(JSON.stringify(document)));
  }

  async deleteDocument(id: string): Promise<void> {
    this.documents.delete(id);
    this.sessions.delete(id);
  }

  async saveEditorSession(state: EditorSessionState): Promise<void> {
    this.sessions.set(state.documentId, JSON.parse(JSON.stringify(state)));
  }

  async getEditorSession(
    documentId: string,
  ): Promise<EditorSessionState | null> {
    const session = this.sessions.get(documentId);
    return session ? JSON.parse(JSON.stringify(session)) : null;
  }
}
