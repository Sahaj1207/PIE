import { Image, NativeModules } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { Document, DocumentPage } from '../../types/document';
import {
  ImageCancelledError,
  ImageInvalidDimensionsError,
  ImageUnsupportedFormatError,
  ImageUriUnsupportedError,
  UnsupportedDocumentError,
} from '../../errors';
import { documentStorage } from '../../storage';
import { ImageDocumentModel } from './types';
import { ImageDocumentSession } from './imageDocumentSession';

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

  // Create working copy to ensure source immutability
  const workingUri = await createImageWorkingCopy(image.uri, docId);

  const session = new ImageDocumentSession({
    documentId: docId,
    sourceUri: image.uri,
    workingUri,
    mimeType: image.mimeType || 'image/jpeg',
    intrinsicWidth: width,
    intrinsicHeight: height,
    orientation: image.orientation || 1,
    sourceMetadata: {
      fileName: image.fileName,
      fileSizeBytes: image.fileSizeBytes,
      lastModified: now,
      originalFormat: image.mimeType,
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
