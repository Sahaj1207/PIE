/**
 * In-memory index of PDF page renders (files live in the existing native render cache
 * directory and are deleted through PdfiumEngine.purgeRenderCache — no second storage).
 *
 * Keys contain everything that affects the rendered pixels:
 *   revision identity (native document handle + open file), page index, render scale,
 *   region (for zoom-detail renders) and render flags.
 * Every open / applied edit / undo / redo / save reopens the document with a NEW handle, so
 * a render of a previous revision can never be returned for the current one. Entries of
 * other revisions are dropped as soon as a new revision is shown (retainRevision).
 * Size is bounded by an entry count and a total pixel budget (LRU eviction).
 */

/** Rendering flags used by the native renderer (FPDF_ANNOT | reverse byte order). */
export const PDF_RENDER_FLAGS = 'annot';

export interface PdfRenderIdentity {
  readonly docHandle: number;
  readonly filePath: string;
}

export interface PdfRenderRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function renderRevisionKey(identity: PdfRenderIdentity): string {
  return `h${identity.docHandle}:${identity.filePath}`;
}

function scaleKey(scale: number): string {
  return Number(scale).toFixed(3);
}

export function pageRenderKey(identity: PdfRenderIdentity, pageIndex: number, scale: number): string {
  return `${renderRevisionKey(identity)}|p${pageIndex}|s${scaleKey(scale)}|full|f${PDF_RENDER_FLAGS}`;
}

export function regionRenderKey(
  identity: PdfRenderIdentity,
  pageIndex: number,
  scale: number,
  rect: PdfRenderRect,
): string {
  const r = [rect.x, rect.y, rect.width, rect.height].map((v) => Number(v).toFixed(2)).join(',');
  return `${renderRevisionKey(identity)}|p${pageIndex}|s${scaleKey(scale)}|r${r}|f${PDF_RENDER_FLAGS}`;
}

export interface CachedRender {
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
}

interface Entry<T extends CachedRender> {
  readonly revisionKey: string;
  readonly value: T;
  readonly pixels: number;
}

export interface PdfRenderCacheOptions {
  readonly maxEntries?: number;
  readonly maxPixels?: number;
}

export const DEFAULT_RENDER_CACHE_ENTRIES = 16;
export const DEFAULT_RENDER_CACHE_PIXELS = 48_000_000;

export class PdfRenderCache<T extends CachedRender = CachedRender> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly maxPixels: number;

  constructor(options: PdfRenderCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_RENDER_CACHE_ENTRIES);
    this.maxPixels = Math.max(1, options.maxPixels ?? DEFAULT_RENDER_CACHE_PIXELS);
  }

  get size(): number {
    return this.entries.size;
  }

  get totalPixels(): number {
    let total = 0;
    this.entries.forEach((e) => {
      total += e.pixels;
    });
    return total;
  }

  /** Returns the cached render (and marks it most recently used). */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Stores a render. Returns the file paths of evicted renders (to purge). The newest entry
   * is never evicted, even if it alone exceeds the pixel budget.
   */
  set(key: string, revisionKey: string, value: T): string[] {
    const previous = this.entries.get(key);
    this.entries.delete(key);
    const evicted: string[] = [];
    if (previous && previous.value.filePath !== value.filePath) evicted.push(previous.value.filePath);
    this.entries.set(key, { revisionKey, value, pixels: Math.max(0, value.width * value.height) });

    while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.totalPixels > this.maxPixels)) {
      const oldestKey = this.entries.keys().next().value as string;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      evicted.push(oldest.value.filePath);
    }
    return evicted;
  }

  /** Drops every render that does not belong to `revisionKey`; returns their file paths. */
  retainRevision(revisionKey: string): string[] {
    const dropped: string[] = [];
    for (const [key, entry] of [...this.entries]) {
      if (entry.revisionKey !== revisionKey) {
        this.entries.delete(key);
        dropped.push(entry.value.filePath);
      }
    }
    return dropped;
  }

  /** Removes everything; returns the file paths. */
  clear(): string[] {
    const paths = [...this.entries.values()].map((e) => e.value.filePath);
    this.entries.clear();
    return paths;
  }

  /** File paths still referenced by the cache (keep them when purging the render directory). */
  livePaths(): string[] {
    return [...this.entries.values()].map((e) => e.value.filePath);
  }
}
