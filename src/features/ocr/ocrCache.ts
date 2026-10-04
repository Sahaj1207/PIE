import { OcrDocument } from './types';

export class OcrCache {
  private cache = new Map<string, OcrDocument>();

  private buildKey(documentId: string, imageUri: string): string {
    return `${documentId}:${imageUri}`;
  }

  get(documentId: string, imageUri: string): OcrDocument | undefined {
    return this.cache.get(this.buildKey(documentId, imageUri));
  }

  set(documentId: string, imageUri: string, ocrDoc: OcrDocument): void {
    this.cache.set(this.buildKey(documentId, imageUri), ocrDoc);
  }

  has(documentId: string, imageUri: string): boolean {
    return this.cache.has(this.buildKey(documentId, imageUri));
  }

  /**
   * Invalidates all cached OCR entries for a specific document.
   */
  invalidate(documentId: string): void {
    const prefix = `${documentId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clears entire OCR cache.
   */
  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export const defaultOcrCache = new OcrCache();
