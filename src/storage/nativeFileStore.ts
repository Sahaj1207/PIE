import { NativeModules } from 'react-native';

/**
 * Minimal on-device file store contract backing durable document persistence.
 *
 * All paths are absolute filesystem paths (no `file://` scheme). Destination paths
 * must live inside the app-private root returned by getRootPath(); the native
 * implementation (PieFileStoreModule) rejects writes/deletes outside that root.
 */
export interface IFileStore {
  getRootPath(): Promise<string>;
  /** Writes UTF-8 text via temp file + rename so readers never observe a partial file. */
  writeFileAtomic(path: string, contents: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Copies a file (source may be outside the root, e.g. a cache file). */
  copyFile(fromPath: string, toPath: string): Promise<void>;
  /** Deletes a file or directory recursively. Missing paths are not an error. */
  deletePath(path: string): Promise<void>;
  /** Lists entry names of a directory. Missing directories yield an empty list. */
  listDirectory(path: string): Promise<string[]>;
  makeDirectory(path: string): Promise<void>;
}

/**
 * Returns the native project-owned file store when linked, or null (e.g. Jest, iOS
 * until its native counterpart exists). Callers must handle null explicitly.
 */
export function getNativeFileStore(): IFileStore | null {
  const mod = NativeModules.PieFileStoreModule;
  if (
    !mod ||
    typeof mod.getRootPath !== 'function' ||
    typeof mod.writeFileAtomic !== 'function' ||
    typeof mod.readFile !== 'function'
  ) {
    return null;
  }
  return mod as IFileStore;
}

/** Strips a `file://` scheme, returning a plain absolute path. */
export function toFilePath(uriOrPath: string): string {
  return uriOrPath.startsWith('file://') ? uriOrPath.substring(7) : uriOrPath;
}

/** Converts an absolute path to a `file://` URI (idempotent). */
export function toFileUri(pathOrUri: string): string {
  if (pathOrUri.startsWith('file://') || pathOrUri.startsWith('content://')) {
    return pathOrUri;
  }
  return `file://${pathOrUri}`;
}

/** Joins path segments with single separators. */
export function joinPath(...segments: string[]): string {
  return segments
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .join('/');
}

/** Returns the final path segment. */
export function baseName(path: string): string {
  const clean = toFilePath(path).replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.substring(idx + 1) : clean;
}

/** True when `path` is `dir` itself or nested inside it. */
export function isPathInside(path: string, dir: string): boolean {
  const p = toFilePath(path);
  const d = toFilePath(dir).replace(/\/+$/, '');
  return p === d || p.startsWith(`${d}/`);
}
