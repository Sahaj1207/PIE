import { InMemoryDocumentStorage } from './InMemoryDocumentStorage';
import { IDocumentStorage } from './types';

/**
 * Shared offline-first document storage singleton.
 */
export const documentStorage: IDocumentStorage = new InMemoryDocumentStorage();
