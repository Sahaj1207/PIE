/**
 * In-memory registry of documents that are currently in use (open in an editor, saving,
 * exporting, closing or being deleted). Library deletion consults it so a document is never
 * deleted underneath an active operation. Nothing here is persisted.
 */

export type DocumentActivityReason = 'open' | 'saving' | 'exporting' | 'deleting';

export interface DocumentActivityRegistry {
  /** Marks `documentId` as in use; the returned function releases this mark (idempotent). */
  markActive(documentId: string, reason: DocumentActivityReason): () => void;
  isActive(documentId: string): boolean;
  hasAnyActive(): boolean;
  reasons(documentId: string): DocumentActivityReason[];
}

export function createDocumentActivityRegistry(): DocumentActivityRegistry {
  // documentId -> active marks (a document may be held by several operations at once)
  const marks = new Map<string, Map<number, DocumentActivityReason>>();
  let nextToken = 1;

  return {
    markActive(documentId, reason) {
      const token = nextToken++;
      let entry = marks.get(documentId);
      if (!entry) {
        entry = new Map();
        marks.set(documentId, entry);
      }
      entry.set(token, reason);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = marks.get(documentId);
        if (!current) return;
        current.delete(token);
        if (current.size === 0) marks.delete(documentId);
      };
    },
    isActive(documentId) {
      return (marks.get(documentId)?.size ?? 0) > 0;
    },
    hasAnyActive() {
      return marks.size > 0;
    },
    reasons(documentId) {
      return [...(marks.get(documentId)?.values() ?? [])];
    },
  };
}

/** Shared app-wide registry. */
export const documentActivity: DocumentActivityRegistry = createDocumentActivityRegistry();
