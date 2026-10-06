import { Image, NativeModules } from 'react-native';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { Document, DocumentPage } from '../../types/document';
import {
  ImageCancelledError,
  ImageDecodeError,
  ImageInvalidDimensionsError,
  ImageTooLargeError,
  ImageUnsupportedFormatError,
  ImageUriUnsupportedError,
  ImageWorkingCopyError,
  UnsupportedDocumentError,
} from '../../errors';
import { documentStorage } from '../../storage';
import { getDocumentDirectory, DOCUMENT_ASSETS_DIR } from '../../storage/documentFiles';
import { joinPath } from '../../storage/nativeFileStore';
import { ImageDocumentModel } from './types';
import { ImageDocumentSession } from './imageDocumentSession';

import { MAX_IMAGE_PIXELS, PREVIEW_MAX_DIMENSION } from './imageLimits';

export { MAX_IMAGE_PIXELS, PREVIEW_MAX_DIMENSION };

/** Result of the native durable import (EXIF-normalized working copy + preview). */
export interface NativeImageImportResult {
  readonly workingUri: string;
  readonly previewUri?: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType?: string;
  readonly exifOrientation?: number;
  readonly fileSizeBytes?: number;
}

/** Throws ImageTooLargeError when dimensions exceed the on-device pixel budget. */
export function assertImageWithinPixelBudget(
  width: number,
  height: number,
  maxPixels: number = MAX_IMAGE_PIXELS,
): void {
  if (width > 0 && height > 0 && width * height > maxPixels) {
    throw new ImageTooLargeError(
      `Image is too large to edit on this device (${width}x${height}, ${(
        (width * height) /
        1_000_000
      ).toFixed(1)} MP). The maximum supported size is ${(maxPixels / 1_000_000).toFixed(0)} MP.`,
    );
  }
}

/**
 * Imports the picked image into durable app storage via the native module:
 * copies the source (never modifying it), applies EXIF orientation so the working copy is
 * stored upright, enforces the pixel budget and generates a display preview.
 * Returns null when the native durable import is unavailable on this platform.
 */
export async function importImageIntoDocumentStorage(
  sourceUri: string,
  documentId: string,
): Promise<NativeImageImportResult | null> {
  const native = NativeModules.ImageProcessingModule;
  if (!native || typeof native.importImageDocument !== 'function') {
    return null;
  }
  const docDir = await getDocumentDirectory(documentId);
  if (!docDir) {
    return null;
  }

  let res: any;
  try {
    res = await native.importImageDocument(
      sourceUri,
      joinPath(docDir, DOCUMENT_ASSETS_DIR),
      MAX_IMAGE_PIXELS,
      PREVIEW_MAX_DIMENSION,
    );
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'IMAGE_TOO_LARGE') {
      throw new ImageTooLargeError(msg, err);
    }
    if (code === 'IMAGE_DECODE_FAILED') {
      throw new ImageDecodeError(msg, err);
    }
    throw new ImageWorkingCopyError(`Failed to import image into document storage: ${msg}`, err);
  }

  const width = Number(res?.width || 0);
  const height = Number(res?.height || 0);
  if (!res?.workingUri || width <= 0 || height <= 0) {
    throw new ImageWorkingCopyError('Native image import returned an invalid result.');
  }

  return {
    workingUri: String(res.workingUri),
    previewUri: res.previewUri ? String(res.previewUri) : undefined,
    width,
    height,
    mimeType: res.mimeType ? String(res.mimeType) : undefined,
    exifOrientation: Number(res.exifOrientation || 1),
    fileSizeBytes: res.fileSizeBytes ? Number(res.fileSizeBytes) : undefined,
  };
}

export interface PickedImageResult {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
  readonly fileSizeBytes?: number;
  readonly mimeType?: string;
  readonly orientation?: number;
}

export interface NormalizedUri {
  readonly scheme: 'content' | 'file' | 'raw';
  readonly path: string;
  readonly cleanUri: string;
}

/**
 * Normalizes an image URI into its scheme, filesystem path, and standard URI format.
 */
export function normalizeImageUri(uri: string): NormalizedUri {
  if (!uri || typeof uri !== 'string' || !uri.trim()) {
    throw new ImageUriUnsupportedError('Invalid or empty image URI provided.');
  }

  const trimmed = uri.trim();
  if (trimmed.startsWith('content://')) {
    return {
      scheme: 'content',
      path: trimmed,
      cleanUri: trimmed,
    };
  }

  if (trimmed.startsWith('file://')) {
    const rawPath = trimmed.substring(7);
    return {
      scheme: 'file',
      path: rawPath,
      cleanUri: trimmed,
    };
  }

  // Raw filesystem path
  const normalizedPath = trimmed.replace(/\\/g, '/');
  return {
    scheme: 'raw',
    path: normalizedPath,
    cleanUri: normalizedPath.startsWith('/') ? `file://${normalizedPath}` : normalizedPath,
  };
}

/**
 * Resolves intrinsic pixel dimensions of an image URI asynchronously.
 */
export function getImageDimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => {
        if (!width || !height || width <= 0 || height <= 0) {
          reject(new ImageInvalidDimensionsError(`Invalid image dimensions returned: ${width}x${height}`));
        } else {
          resolve({ width, height });
        }
      },
      error => reject(error),
    );
  });
}

/**
 * Validates that an image URI or MIME type is an allowed format (JPEG, PNG, WebP).
 */
export function isSupportedImageFormat(fileName?: string, type?: string): boolean {
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

  if (type && allowedMimeTypes.includes(type.toLowerCase())) {
    return true;
  }

  if (fileName) {
    const lower = fileName.toLowerCase();
    return allowedExtensions.some(ext => lower.endsWith(ext));
  }

  return true;
}

/**
 * Validates image format and throws typed error if unsupported.
 */
export function validateImageFormat(fileName?: string, type?: string): void {
  if (!isSupportedImageFormat(fileName, type)) {
    throw new ImageUnsupportedFormatError(
      `Unsupported image format (${type || fileName || 'unknown'}). Please select a JPEG, PNG, or WebP image.`,
    );
  }
}

/**
 * Resolves a local file:// URI from an image URI (resolving content:// via native module if needed).
 */
export async function resolveImageFileUri(uri: string): Promise<string> {
  const normalized = normalizeImageUri(uri);

  if (normalized.scheme === 'file') {
    return normalized.cleanUri;
  }

  if (normalized.scheme === 'raw') {
    return normalized.cleanUri;
  }

  // Scheme is content://: resolve via native module to get a local cache file
  if (NativeModules.ImageProcessingModule?.resolveLocalImageUri) {
    try {
      const resolved = await NativeModules.ImageProcessingModule.resolveLocalImageUri(uri);
      if (resolved && typeof resolved === 'string') {
        return resolved.startsWith('file://') ? resolved : `file://${resolved}`;
      }
    } catch (e) {
      console.warn('Could not resolve content URI via ImageProcessingModule, using raw URI:', e);
    }
  }

  return uri;
}

/**
 * Creates an editable working copy of the source image to ensure source immutability.
 */
export async function createImageWorkingCopy(sourceUri: string, documentId: string): Promise<string> {
  const resolved = await resolveImageFileUri(sourceUri);

  // If native module supports explicit copy/clone, use it; otherwise use resolved local file
  if (NativeModules.ImageProcessingModule?.createWorkingCopy) {
    try {
      const working = await NativeModules.ImageProcessingModule.createWorkingCopy(resolved, documentId);
      if (working) return working;
    } catch {
      // Fallback to resolved
    }
  }

  return resolved;
}

/**
 * Prompts user to pick a photo from device photo library.
 */
export async function pickImageFromLibrary(): Promise<PickedImageResult | null> {
  const response = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: 1,
    includeBase64: false,
  });

  if (response.didCancel || !response.assets || response.assets.length === 0) {
    return null;
  }

  const asset = response.assets[0];
  if (!asset.uri) {
    throw new UnsupportedDocumentError('Selected image does not have a valid file URI.');
  }

  validateImageFormat(asset.fileName, asset.type);

  const resolvedUri = await resolveImageFileUri(asset.uri);

  let width = asset.width;
  let height = asset.height;

  if (!width || !height || width <= 0 || height <= 0) {
    try {
      const dims = await getImageDimensions(resolvedUri);
      width = dims.width;
      height = dims.height;
    } catch {
      width = 1200;
      height = 1600;
    }
  }

  return {
    uri: resolvedUri,
    width,
    height,
    fileName: asset.fileName || 'Imported Image',
    fileSizeBytes: asset.fileSize,
    mimeType: asset.type || 'image/jpeg',
    orientation: 1,
  };
}

/**
 * Takes a photo with the system camera (no camera permission is requested by the app; the
 * system camera app captures the photo). Returns null when cancelled.
 */
export async function takePhotoWithCamera(): Promise<PickedImageResult | null> {
  const response = await launchCamera({
    mediaType: 'photo',
    includeBase64: false,
    saveToPhotos: false,
    cameraType: 'back',
  });
  if (response.didCancel || !response.assets || response.assets.length === 0) {
    if (response.errorCode && response.errorCode !== 'camera_unavailable') {
      throw new UnsupportedDocumentError(response.errorMessage || 'The camera could not be opened.');
    }
    if (response.errorCode === 'camera_unavailable') {
      throw new UnsupportedDocumentError('No camera is available on this device.');
    }
    return null;
  }
  const asset = response.assets[0];
  if (!asset.uri) {
    throw new UnsupportedDocumentError('The photo does not have a valid file URI.');
  }
  const resolvedUri = await resolveImageFileUri(asset.uri);
  let width = asset.width;
  let height = asset.height;
  if (!width || !height || width <= 0 || height <= 0) {
    const dims = await getImageDimensions(resolvedUri).catch(() => ({ width: 1200, height: 1600 }));
    width = dims.width;
    height = dims.height;
  }
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    uri: resolvedUri,
    width,
    height,
    fileName: `Photo ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.jpg`,
    fileSizeBytes: asset.fileSize,
    mimeType: asset.type || 'image/jpeg',
    orientation: 1,
  };
}

/** Picks several photos (images -> PDF). Returns their URIs in selection order. */
export async function pickImagesFromLibrary(limit = 50): Promise<string[]> {
  const response = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: limit,
    includeBase64: false,
  });
  if (response.didCancel || !response.assets) return [];
  return response.assets.map((a) => a.uri).filter((u): u is string => typeof u === 'string' && u.length > 0);
}

/**
 * Prompts user to pick an image from device files / downloads / storage using SAF.
 */
export async function pickImageFromFiles(): Promise<PickedImageResult | null> {
  if (NativeModules.ImageProcessingModule?.pickImageDocument) {
    try {
      const res = await NativeModules.ImageProcessingModule.pickImageDocument();
      if (!res || !res.uri) {
        return null;
      }
      return {
        uri: String(res.uri),
        width: Number(res.width || 0),
        height: Number(res.height || 0),
        fileName: String(res.fileName || 'Imported Image'),
        fileSizeBytes: res.fileSize ? Number(res.fileSize) : undefined,
        mimeType: 'image/jpeg',
        orientation: 1,
      };
    } catch (e) {
      console.warn('pickImageDocument failed, falling back to library:', e);
    }
  }
  return pickImageFromLibrary();
}

/**
 * Creates an image-backed Document and establishes its canonical document session.
 */
export type ImageDocumentWithSession = Document & { session?: ImageDocumentSession };

export function createImageSessionFromDocument(document: Document): ImageDocumentSession {
  const page = document.pages[0];
  const intrinsicWidth = page?.dimensions.width || 1200;
  const intrinsicHeight = page?.dimensions.height || 1600;

  return new ImageDocumentSession({
    documentId: document.id,
    sourceUri: document.metadata.sourceUri,
    workingUri: page?.originalContent?.assetUri || document.metadata.sourceUri,
    mimeType: 'image/jpeg',
    intrinsicWidth,
    intrinsicHeight,
    orientation: 1,
    sourceMetadata: {
      fileName: document.metadata.title,
      fileSizeBytes: document.metadata.fileSizeBytes,
      lastModified: document.metadata.updatedAt,
      exifOrientation: page?.originalContent?.sourceOrientation,
    },
    initialDirtyState: 'CLEAN',
  });
}

export async function createDocumentFromPickedImage(
  image: PickedImageResult,
): Promise<ImageDocumentWithSession> {
  let width = image.width;
  let height = image.height;

  if (!width || !height || width <= 0 || height <= 0) {
    try {
      const dims = await getImageDimensions(image.uri);
      width = dims.width;
      height = dims.height;
    } catch {
      width = width || 1200;
      height = height || 1600;
    }
  }

  const docId = `doc-${Date.now()}`;
  const now = Date.now();

  // Preferred path: durable, EXIF-normalized working copy + display preview inside the
  // document's own storage directory. The picked source file is only read, never modified.
  const durable = await importImageIntoDocumentStorage(image.uri, docId);

  let workingUri: string;
  let previewUri: string | undefined;
  let orientation: number;
  let sourceOrientation: number | undefined;
  let mimeType = image.mimeType || 'image/jpeg';

  if (durable) {
    workingUri = durable.workingUri;
    previewUri = durable.previewUri;
    width = durable.width;
    height = durable.height;
    // The working copy is stored upright; the original EXIF value is kept as metadata.
    orientation = 1;
    sourceOrientation = durable.exifOrientation;
    mimeType = durable.mimeType || mimeType;
  } else {
    assertImageWithinPixelBudget(width, height);
    // Legacy path: working copy resolved as before (platforms without durable import).
    workingUri = await createImageWorkingCopy(image.uri, docId);
    orientation = image.orientation || 1;
  }

  const session = new ImageDocumentSession({
    documentId: docId,
    sourceUri: image.uri,
    workingUri,
    mimeType,
    intrinsicWidth: width,
    intrinsicHeight: height,
    orientation,
    sourceMetadata: {
      fileName: image.fileName,
      fileSizeBytes: image.fileSizeBytes,
      lastModified: now,
      originalFormat: image.mimeType,
      exifOrientation: sourceOrientation,
    },
    initialDirtyState: 'CLEAN',
  });

  const page: DocumentPage = {
    id: `page-${docId}-0`,
    pageIndex: 0,
    dimensions: {
      width,
      height,
    },
    rotation: 0,
    originalContent: {
      pageIndex: 0,
      assetUri: workingUri,
      width,
      height,
      ...(previewUri ? { previewUri } : {}),
      ...(sourceOrientation !== undefined ? { sourceOrientation } : {}),
    },
    editableTextRegions: [],
    addedText: [],
  };

  const document: Document = {
    id: docId,
    metadata: {
      id: docId,
      title: image.fileName,
      kind: 'image',
      sourceUri: image.uri,
      pageCount: 1,
      createdAt: now,
      updatedAt: now,
      fileSizeBytes: image.fileSizeBytes,
    },
    pages: [page],
  };

  await documentStorage.saveDocument(document);
  const result: ImageDocumentWithSession = Object.assign(document, { session });
  return result;
}
