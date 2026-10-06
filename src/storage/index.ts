import { InMemoryDocumentStorage } from './InMemoryDocumentStorage';
import { FileSystemDocumentStorage } from './FileSystemDocumentStorage';
import { IDocumentStorage } from './types';
import { getNativeFileStore } from './nativeFileStore';

/**
 * Selects the document storage implementation.
 *
 * - Native file store linked (Android): durable FileSystemDocumentStorage.
 * - Otherwise (Jest, platforms without the native module): InMemoryDocumentStorage,
 *   which does not survive an app restart.
 */
export function createDefaultDocumentStorage(): IDocumentStorage {
  const fileStore = getNativeFileStore();
  if (fileStore) {
    return new FileSystemDocumentStorage(fileStore);
  }
  return new InMemoryDocumentStorage();
}

/**
 * Shared offline-first document storage singleton.
 */
export const documentStorage: IDocumentStorage = createDefaultDocumentStorage();

/** True when documents persist across app restarts on this platform. */
export const isDurableDocumentStorage: boolean =
  documentStorage instanceof FileSystemDocumentStorage;
