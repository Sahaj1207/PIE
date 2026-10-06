import {
  IPdfDocumentEditor,
  IPdfiumEngine,
  PdfBatchEditRequest,
  PdfDocumentHandle,
  PdfEditorHistoryAction,
  PdfInsertCommand,
  PdfMultiEditResult,
  PdfPageSize,
  PdfPendingStateSnapshot,
  PdfRevisionHistoryAction,
  PdfTextEditCommand,
  PdfTextFormatOptions,
  PdfTextObject,
  PdfSaveState,
} from './types';
import {
  PdfDocumentClosedError,
  PdfConcurrentSaveError,
  PdfValidationFailureError,
  PdfSourceUnavailableError,
  PdfWorkingCopyError,
  PdfSaveAsError,
  PdfUnsupportedFormattingError,
  PdfInvalidFormattingError,
  PdfInvalidFontError,
  PdfInvalidColorError,
  PdfInvalidFontSizeError,
  PdfStaleSelectionError,
  PdfReopenVerificationError,
  PdfNativeFormattingError,
  PdfCorruptedError,
  PdfSaveError,
  PdfBatchEditError,
  PdfDeletedObjectEditError,
  PdfInvalidObjectIdError,
  PdfInvalidReplacementError,
  PdfPageOutOfRangeError,
  PdfDocumentNotOpenError,
  PdfInvalidObjectPathError,
  PdfFontLimitationError,
  PdfTextReplacementError,
  PdfUnsupportedReplacementError,
  PdfTextDeletionError,
  PdfNonDeletableObjectError,
  PdfTextInsertionError,
  PdfInvalidPlacementError,
  PdfDocumentOperationError,
  PdfOutputUnavailableError,
} from '../../errors';
import {
  PdfDocumentOperation,
  PdfDocumentOperationsResult,
  expectedPageCount,
  operationKind,
  validateDocumentOperations,
} from './pdfDocumentOperations';
import { PdfReplaceCommand, PdfDeleteCommand } from './types';
import { standardFontFamily } from './pdfTextBox';

import { placeInsertedText } from './pdfPageGeometry';
import {
  assertInsertableText,
  assertReplaceableText,
  unsupportedGlyphsErrorFromNative,
} from './pdfGlyphCoverage';

/** Limits for applied-edit revision files kept for undo (Phase 15 storage safety). */
export interface PdfRevisionLimits {
  /** Maximum applied-edit revisions kept in the undo history (>= 1). */
  readonly maxRevisions: number;
  /** Maximum total bytes of revision files referenced by history (source/clean excluded). */
  readonly maxBytes: number;
}

export const DEFAULT_REVISION_LIMITS: PdfRevisionLimits = {
  maxRevisions: 20,
  maxBytes: 512 * 1024 * 1024,
};

export function resolveStandardFontName(format?: PdfTextFormatOptions): string {
  // UI names ("sans-serif" / "serif" / "monospace") and PDF names map to the standard families
  const family = standardFontFamily(format?.fontFamily ?? 'Helvetica');
  const isBold = Boolean(format?.isBold);
  const isItalic = Boolean(format?.isItalic);

  if (family.toLowerCase().includes('times')) {
    if (isBold && isItalic) return 'Times-BoldItalic';
    if (isBold) return 'Times-Bold';
    if (isItalic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (family.toLowerCase().includes('courier')) {
    if (isBold && isItalic) return 'Courier-BoldOblique';
    if (isBold) return 'Courier-Bold';
    if (isItalic) return 'Courier-Oblique';
    return 'Courier';
  }
  // Default to Helvetica
  if (isBold && isItalic) return 'Helvetica-BoldOblique';
  if (isBold) return 'Helvetica-Bold';
  if (isItalic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/**
 * Identity fingerprint of an extracted text object: text, page-object path and rounded
 * bounds. Native object IDs are positional (`p<page>_path<i>`), so after a deletion the
 * next object can inherit the deleted object's ID; the fingerprint tells them apart.
 */
export function pdfObjectFingerprint(obj: PdfTextObject): string {
  const path = (obj.objectPath && obj.objectPath.length > 0 ? obj.objectPath : [obj.objectIndex]).join('/');
  const b = obj.bounds;
  return `${obj.text}|${obj.pageIndex}|${path}|${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
}

/**
 * Single PDF editing domain object.
 *
 * Two complementary ways of editing share ONE history and ONE dirty model:
 * - Queued edits (replaceText / deleteText / insertText): kept as pending commands and
 *   written by saveDocument() in one native batch.
 * - Applied edits (applyExistingTextReplacement / applyExistingTextDeletion /
 *   applyNewTextInsertion): applied natively into a new working-copy file, which becomes
 *   the open document. Each applied edit is a 'revision' history entry; undo/redo reopen
 *   the revision's before/after files, so the actual PDF content is reversed.
 *
 * Dirty state is derived from facts: pending commands exist, the open file differs from
 * the last clean file (opened or saved), or the last save failed.
 */
export class PdfDocumentEditor implements IPdfDocumentEditor {
  private readonly engine: IPdfiumEngine;
  private currentFilePath: string | null = null;
  private docHandle: PdfDocumentHandle | null = null;
  private readonly textObjectsCache: Map<string, PdfTextObject> = new Map();
  private readonly deletedObjectIds: Set<string> = new Set();
  private readonly insertedObjectsCache: Map<string, PdfTextObject> = new Map();
  private readonly pageSizeCache: Map<number, PdfPageSize> = new Map();
  private pendingEdits: PdfTextEditCommand[] = [];
  private insertCounter: number = 0;
  private isSaving: boolean = false;
  private originalSourcePath: string | null = null;
  /** File representing the last clean (opened or successfully saved) state. */
  private cleanFilePath: string | null = null;
  private saveState: PdfSaveState = 'CLEAN';
  /**
   * Objects removed by the latest applied deletion: objectId -> fingerprint of the
   * deleted object. Used to reject stale references without hiding objects that
   * legitimately inherited the same positional ID.
   */
  private retiredObjects: Map<string, string> = new Map();

  // Domain undo/redo history stacks (no native pointers)
  private undoStack: PdfEditorHistoryAction[] = [];
  private redoStack: PdfEditorHistoryAction[] = [];

  // Revision-file storage safety (Phase 15): sizes of opened revision files, files that are
  // no longer referenced by history, and the cap applied to applied-edit revisions.
  private readonly revisionFileSizes: Map<string, number> = new Map();
  private readonly discardedRevisionFiles: Set<string> = new Set();
  private revisionLimits: PdfRevisionLimits = { ...DEFAULT_REVISION_LIMITS };
  private historyTruncated = false;

  constructor(engine: IPdfiumEngine, initialFilePath?: string) {
    this.engine = engine;
    if (initialFilePath) {
      this.currentFilePath = initialFilePath;
      this.originalSourcePath = initialFilePath;
      this.cleanFilePath = initialFilePath;
    }
  }

  /**
   * Opens a document. `isWorkingCopy = true` keeps the immutable source and the last clean
   * file of the current session (the opened file then counts as unsaved work unless it is
   * the clean file itself). Opening always starts a new history.
   */
  async open(filePath: string, isWorkingCopy = false): Promise<void> {
    const retainedSource = (isWorkingCopy && this.originalSourcePath) ? this.originalSourcePath : null;
    const retainedClean = (isWorkingCopy && this.cleanFilePath) ? this.cleanFilePath : null;
    if (this.docHandle) {
      await this.close();
    }
    this.originalSourcePath = retainedSource ?? filePath;
    this.cleanFilePath = retainedClean ?? filePath;
    this.currentFilePath = filePath;
    this.textObjectsCache.clear();
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
    this.pageSizeCache.clear();
    this.retiredObjects = new Map();
    this.pendingEdits = [];
    this.insertCounter = 0;
    this.clearHistory();
    this.isSaving = false;
    this.refreshSaveState();
    this.historyTruncated = false;
    this.docHandle = await this.engine.openDocument(filePath);
    this.recordFileSize(this.docHandle, filePath);
  }

  getPageCount(): number {
    this.ensureDocumentOpen();
    return this.docHandle!.pageCount;
  }

  async getPageSize(pageIndex: number): Promise<PdfPageSize> {
    this.ensureDocumentOpen();
    if (this.pageSizeCache.has(pageIndex)) {
      return this.pageSizeCache.get(pageIndex)!;
    }
    const size = await this.engine.getPageSize(this.docHandle!.docHandle, pageIndex);
    this.pageSizeCache.set(pageIndex, size);
    return size;
  }

  async getTextObjects(pageIndex: number): Promise<PdfTextObject[]> {
    this.ensureDocumentOpen();
    if (pageIndex < 0 || pageIndex >= (this.docHandle?.pageCount ?? 0)) {
      throw new PdfPageOutOfRangeError(
        `Page index ${pageIndex} is out of range [0, ${(this.docHandle?.pageCount ?? 1) - 1}]`,
      );
    }

    // Prefetch page size for coordinate transformations
    if (!this.pageSizeCache.has(pageIndex)) {
      try {
        const size = await this.engine.getPageSize(this.docHandle!.docHandle, pageIndex);
        this.pageSizeCache.set(pageIndex, size);
      } catch {
        this.pageSizeCache.set(pageIndex, { pageIndex, width: 612, height: 792 });
      }
    }

    const rawObjects = await this.engine.getTextObjects(
      this.docHandle!.docHandle,
      pageIndex,
    );

    // Cache original objects
    for (const obj of rawObjects) {
      this.textObjectsCache.set(obj.id, obj);
    }

    // Map active pending edits into the view
    const visibleObjects: PdfTextObject[] = [];

    for (const obj of rawObjects) {
      // 1. Skip objects with a queued (not yet applied) deletion. Objects removed by an
      //    applied deletion are already absent from the working copy and are never hidden
      //    by ID (a different object may legitimately carry the same positional ID).
      if (this.deletedObjectIds.has(obj.id)) {
        continue;
      }

      // 2. Check for pending replacement
      const pendingReplace = this.pendingEdits.find(
        (cmd) => cmd.type === 'replace' && cmd.objectId === obj.id,
      );

      if (pendingReplace && pendingReplace.type === 'replace') {
        visibleObjects.push({
          ...obj,
          text: pendingReplace.newText,
          fontSize: pendingReplace.format?.fontSize ?? obj.fontSize,
          color: pendingReplace.format?.color ?? obj.color,
          fontName: pendingReplace.format
            ? resolveStandardFontName(pendingReplace.format)
            : obj.fontName,
        });
      } else {
        visibleObjects.push(obj);
      }
    }

    // 3. Append active pending inserted objects for this page
    for (const [id, insObj] of this.insertedObjectsCache.entries()) {
      if (insObj.pageIndex === pageIndex && !this.deletedObjectIds.has(id)) {
        visibleObjects.push(insObj);
      }
    }

    return visibleObjects;
  }

  replaceText(
    objectId: string,
    newText: string,
    format?: PdfTextFormatOptions,
  ): void {
    this.ensureDocumentOpen();

    if (!objectId) {
      throw new PdfInvalidObjectIdError('Object ID cannot be empty.');
    }

    if (this.isDeletedReference(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Cannot replace text on deleted object "${objectId}".`,
      );
    }

    if (!newText || newText.trim().length === 0) {
      throw new PdfInvalidReplacementError(
        'Replacement text cannot be empty or whitespace only.',
      );
    }

    // Phase 15: never queue text the PDF fonts cannot draw (inserted text uses standard fonts)
    if (this.insertedObjectsCache.has(objectId)) {
      assertInsertableText(newText);
    } else {
      assertReplaceableText(newText);
    }

    // Find any existing pending command for this objectId
    const previousPending = this.pendingEdits.find((cmd) => cmd.objectId === objectId);

    // Case 1: Editing a pending inserted object
    if (this.insertedObjectsCache.has(objectId)) {
      const existingIns = this.insertedObjectsCache.get(objectId)!;
      const previousText = existingIns.text;
      const previousFormat: PdfTextFormatOptions = {
        fontSize: existingIns.fontSize ?? undefined,
        color: existingIns.color ?? undefined,
      };

      const fontSize = format?.fontSize ?? existingIns.fontSize ?? 14;
      const fontName = format ? resolveStandardFontName(format) : existingIns.fontName;
      const color = format?.color ?? existingIns.color ?? '#000000';

      const updatedInsObj: PdfTextObject = {
        ...existingIns,
        text: newText,
        fontSize,
        fontName,
        color,
      };
      this.insertedObjectsCache.set(objectId, updatedInsObj);

      const cmdIdx = this.pendingEdits.findIndex(
        (c) => c.type === 'insert' && c.objectId === objectId,
      );
      if (cmdIdx >= 0) {
        this.pendingEdits[cmdIdx] = {
          type: 'insert',
          objectId,
          pageIndex: existingIns.pageIndex,
          text: newText,
          // Baseline origin of the inserted object (== pdfBounds.left/bottom when unrotated)
          x: existingIns.matrix?.e ?? existingIns.pdfBounds.left,
          y: existingIns.matrix?.f ?? existingIns.pdfBounds.bottom,
          bounds: existingIns.bounds,
          fontSize,
          fontName: fontName ?? undefined,
          color,
        };
      }

      this.pushHistory({
        type: 'replace',
        objectId,
        wasInserted: true,
        previousText,
        previousFormat,
        newText,
        newFormat: format,
        previousPendingCommand: previousPending,
      });
      this.refreshSaveState();
      return;
    }

    // Case 2: Editing an existing extracted PDF text object
    if (!this.textObjectsCache.has(objectId)) {
      throw new PdfInvalidObjectIdError(
        `Unknown text object ID: "${objectId}". Ensure getTextObjects() was called for its page.`,
      );
    }

    const target = this.textObjectsCache.get(objectId)!;

    // No-op check: if text is unchanged and no formatting is specified, do not dirty the document
    if (newText === target.text && (!format || Object.keys(format).length === 0)) {
      return;
    }

    // Validate requested format
    if (format) {
      if (format.fontSize !== undefined) {
        if (typeof format.fontSize !== 'number' || !isFinite(format.fontSize) || format.fontSize <= 0) {
          throw new PdfInvalidFontSizeError(
            `Invalid font size: ${format.fontSize}pt. Font size must be a positive finite number.`,
          );
        }
      }
      if (format.color !== undefined) {
        if (
          typeof format.color !== 'string' ||
          !/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(format.color.trim())
        ) {
          throw new PdfInvalidColorError(
            `Invalid color: "${format.color}". Color must be a valid hex string (e.g. #RRGGBB).`,
          );
        }
      }

      // Check target formatting capabilities
      const isNested = Boolean(target.objectPath && target.objectPath.length > 1);
      const isSubsetOrEmbedded = Boolean(
        target.fontDetails?.isSubset || target.fontDetails?.isEmbedded,
      );

      const hasStyleChange =
        format.isBold !== undefined ||
        format.isItalic !== undefined ||
        (format.fontFamily !== undefined &&
          format.fontFamily !== target.fontName &&
          format.fontFamily !== target.fontDetails?.familyName);

      if (hasStyleChange) {
        if (isNested) {
          throw new PdfUnsupportedFormattingError(
            'Font family and bold/italic style modifications are unsupported on nested Form XObject text.',
          );
        }
        if (isSubsetOrEmbedded) {
          throw new PdfUnsupportedFormattingError(
            `Cannot substitute font family or bold/italic on embedded subset font "${target.fontName}". Font substitution destroys typographic fidelity.`,
          );
        }
      }
    }

    if (!target.isEditable) {
      throw new PdfInvalidReplacementError(
        `Object "${objectId}" is not an editable vector text object.`,
      );
    }

    const previousText =
      previousPending && previousPending.type === 'replace'
        ? previousPending.newText
        : target.text;
    const previousFormat =
      previousPending && previousPending.type === 'replace'
        ? previousPending.format
        : undefined;

    // Remove any existing pending edit for this objectId
    this.pendingEdits = this.pendingEdits.filter(
      (cmd) => cmd.objectId !== objectId,
    );

    this.pendingEdits.push({
      type: 'replace',
      objectId,
      pageIndex: target.pageIndex,
      objectIndex: target.objectIndex,
      objectPath: target.objectPath,
      newText,
      format,
    });

    this.pushHistory({
      type: 'replace',
      objectId,
      wasInserted: false,
      previousText,
      previousFormat,
      newText,
      newFormat: format,
      previousPendingCommand: previousPending,
    });
    this.refreshSaveState();
  }

  async applyExistingTextReplacement(
    objectId: string,
    newText: string,
    workingCopyPath: string,
    format?: PdfTextFormatOptions,
  ): Promise<{
    result: PdfMultiEditResult;
    reconciledObject: PdfTextObject;
  }> {
    this.ensureDocumentOpen();

    if (!objectId || objectId.trim().length === 0) {
      throw new PdfInvalidObjectIdError('Object ID cannot be empty.');
    }

    if (this.isDeletedReference(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Cannot replace text on deleted object "${objectId}".`,
      );
    }

    if (!newText || newText.trim().length === 0) {
      throw new PdfInvalidReplacementError(
        'Replacement text cannot be empty or whitespace only.',
      );
    }

    // Phase 15: refuse characters no PDF font path can draw (the native layer additionally
    // checks every new character against the original font's glyphs)
    assertReplaceableText(newText.trim());

    this.validateWorkingCopyPath(workingCopyPath);

    if (!this.textObjectsCache.has(objectId)) {
      throw new PdfInvalidObjectIdError(
        `Unknown text object ID: "${objectId}". Ensure getTextObjects() was called for its page.`,
      );
    }

    const target = this.textObjectsCache.get(objectId)!;
    if (!target.isEditable) {
      throw new PdfUnsupportedReplacementError(
        `Object "${objectId}" is not an editable vector text object.`,
      );
    }

    const objectPath =
      target.objectPath && target.objectPath.length > 0
        ? target.objectPath
        : [target.objectIndex];

    if (objectPath.some((idx) => typeof idx !== 'number' || idx < 0)) {
      throw new PdfInvalidObjectPathError(
        `Invalid object path: [${objectPath.join(', ')}]. All indices must be non-negative.`,
      );
    }

    const trimmedText = newText.trim();

    const replaceCmd: PdfReplaceCommand = {
      type: 'replace',
      objectId: target.id,
      pageIndex: target.pageIndex,
      objectIndex: target.objectIndex,
      objectPath,
      originalText: target.text,
      newText: trimmedText,
      format,
    };

    const result = await this.applyRevision(
      replaceCmd,
      workingCopyPath,
      'replace',
      (errMsg) => {
        const lower = errMsg.toLowerCase();
        if (
          lower.includes('unsupported') ||
          lower.includes('cannot substitute font') ||
          lower.includes('form xobject text cannot change')
        ) {
          return new PdfUnsupportedFormattingError(errMsg);
        }
        if (lower.includes('font') || lower.includes('glyph') || lower.includes('subset')) {
          return new PdfFontLimitationError(errMsg);
        }
        if (lower.includes('locator') || lower.includes('path')) {
          return new PdfInvalidObjectPathError(errMsg);
        }
        return new PdfTextReplacementError(errMsg);
      },
      'Native replacement failed',
    );

    // Reconcile: fetch genuine native-extracted text objects from the new working copy
    const updatedPageObjects = await this.getTextObjects(target.pageIndex);

    // Locate reconciled object: match by objectPath, ID, or page/text match
    const targetPathStr = objectPath.join('/');
    let reconciled = updatedPageObjects.find(
      (obj) =>
        (obj.objectPath && obj.objectPath.join('/') === targetPathStr) ||
        obj.id === target.id,
    );

    if (!reconciled) {
      // Fallback find by text on same page
      reconciled = updatedPageObjects.find(
        (obj) => obj.pageIndex === target.pageIndex && obj.text === trimmedText,
      );
    }

    if (!reconciled) {
      // Synthetic reconciled object preserving original geometry
      reconciled = {
        ...target,
        text: trimmedText,
        fontSize: format?.fontSize ?? target.fontSize,
        color: format?.color ?? target.color,
      };
    }

    return {
      result,
      reconciledObject: reconciled,
    };
  }

  async applyExistingTextDeletion(
    objectId: string,
    workingCopyPath: string,
  ): Promise<{
    result: PdfMultiEditResult;
  }> {
    this.ensureDocumentOpen();

    if (!objectId || objectId.trim().length === 0) {
      throw new PdfInvalidObjectIdError('Object ID cannot be empty.');
    }

    if (this.isDeletedReference(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Cannot delete text object "${objectId}" because it is already deleted.`,
      );
    }

    this.validateWorkingCopyPath(workingCopyPath);

    if (!this.textObjectsCache.has(objectId)) {
      throw new PdfInvalidObjectIdError(
        `Unknown text object ID: "${objectId}". Ensure getTextObjects() was called for its page.`,
      );
    }

    const target = this.textObjectsCache.get(objectId)!;
    if (!target.isEditable) {
      throw new PdfNonDeletableObjectError(
        `Object "${objectId}" is not a deletable vector text object.`,
      );
    }

    const objectPath =
      target.objectPath && target.objectPath.length > 0
        ? target.objectPath
        : [target.objectIndex];

    if (objectPath.some((idx) => typeof idx !== 'number' || idx < 0)) {
      throw new PdfInvalidObjectPathError(
        `Invalid object path: [${objectPath.join(', ')}]. All indices must be non-negative.`,
      );
    }

    const deleteCmd: PdfDeleteCommand = {
      type: 'delete',
      objectId: target.id,
      pageIndex: target.pageIndex,
      objectIndex: target.objectIndex,
      objectPath,
      originalText: target.text,
    };

    const result = await this.applyRevision(
      deleteCmd,
      workingCopyPath,
      'delete',
      (errMsg) => {
        const lower = errMsg.toLowerCase();
        if (lower.includes('locator') || lower.includes('path')) {
          return new PdfInvalidObjectPathError(errMsg);
        }
        if (lower.includes('not a text object')) {
          return new PdfNonDeletableObjectError(errMsg);
        }
        return new PdfTextDeletionError(errMsg);
      },
      'Native deletion failed',
    );

    // Refresh the page from the new working copy. The deleted object is gone from the file;
    // its (positional) ID is retired by fingerprint only, so an object that now carries the
    // same ID stays visible and editable.
    await this.getTextObjects(target.pageIndex);
    this.retiredObjects.set(objectId, pdfObjectFingerprint(target));

    return { result };
  }

  /**
   * Deletes several text objects (e.g. every word of a selected line) as ONE applied revision:
   * one native batch, one reopen verification, one undo step. Same validation as
   * applyExistingTextDeletion for every object; nothing is applied when any object is invalid.
   */
  async applyExistingTextDeletions(
    objectIds: readonly string[],
    workingCopyPath: string,
  ): Promise<{ result: PdfMultiEditResult }> {
    this.ensureDocumentOpen();
    const ids = [...new Set(objectIds.filter((id) => typeof id === 'string' && id.trim().length > 0))];
    if (ids.length === 0) {
      throw new PdfInvalidObjectIdError('No text objects to delete.');
    }
    if (ids.length === 1) {
      return this.applyExistingTextDeletion(ids[0], workingCopyPath);
    }
    this.validateWorkingCopyPath(workingCopyPath);

    const { targets, commands } = this.deleteCommandsFor(ids);

    const result = await this.applyRevision(
      commands,
      workingCopyPath,
      'delete',
      (errMsg) => {
        const lower = errMsg.toLowerCase();
        if (lower.includes('locator') || lower.includes('path')) return new PdfInvalidObjectPathError(errMsg);
        if (lower.includes('not a text object')) return new PdfNonDeletableObjectError(errMsg);
        return new PdfTextDeletionError(errMsg);
      },
      'Native deletion failed',
    );

    const pages = new Set(targets.map(({ target }) => target.pageIndex));
    for (const pageIndex of pages) {
      await this.getTextObjects(pageIndex);
    }
    for (const { target } of targets) {
      this.retiredObjects.set(target.id, pdfObjectFingerprint(target));
    }
    return { result };
  }

  /** Validated delete commands for existing text objects (throws before anything is applied). */
  private deleteCommandsFor(ids: readonly string[]): {
    targets: { target: PdfTextObject; objectPath: readonly number[] }[];
    commands: PdfDeleteCommand[];
  } {
    const targets = ids.map((objectId) => {
      if (this.isDeletedReference(objectId)) {
        throw new PdfDeletedObjectEditError(`Cannot delete text object "${objectId}" because it is already deleted.`);
      }
      const target = this.textObjectsCache.get(objectId);
      if (!target) {
        throw new PdfInvalidObjectIdError(
          `Unknown text object ID: "${objectId}". Ensure getTextObjects() was called for its page.`,
        );
      }
      if (!target.isEditable) {
        throw new PdfNonDeletableObjectError(`Object "${objectId}" is not a deletable vector text object.`);
      }
      const objectPath = target.objectPath && target.objectPath.length > 0 ? target.objectPath : [target.objectIndex];
      if (objectPath.some((idx) => typeof idx !== 'number' || idx < 0)) {
        throw new PdfInvalidObjectPathError(
          `Invalid object path: [${objectPath.join(', ')}]. All indices must be non-negative.`,
        );
      }
      return { target, objectPath };
    });
    const commands: PdfDeleteCommand[] = targets.map(({ target, objectPath }) => ({
      type: 'delete',
      objectId: target.id,
      pageIndex: target.pageIndex,
      objectIndex: target.objectIndex,
      objectPath: [...objectPath],
      originalText: target.text,
    }));
    return { targets, commands };
  }

  deleteText(objectId: string): void {
    this.ensureDocumentOpen();

    if (!objectId) {
      throw new PdfInvalidObjectIdError('Object ID cannot be empty.');
    }

    if (this.isDeletedReference(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Text object "${objectId}" has already been deleted.`,
      );
    }

    const previousPending = this.pendingEdits.find((cmd) => cmd.objectId === objectId);

    // If it is a pending inserted object, remove it completely from pending queue
    if (this.insertedObjectsCache.has(objectId)) {
      const targetObject = this.insertedObjectsCache.get(objectId)!;
      this.insertedObjectsCache.delete(objectId);
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== objectId,
      );
      this.deletedObjectIds.add(objectId);

      this.pushHistory({
        type: 'delete',
        targetObject,
        wasInserted: true,
        previousPendingCommand: previousPending,
      });
      this.refreshSaveState();
      return;
    }

    if (!this.textObjectsCache.has(objectId)) {
      throw new PdfInvalidObjectIdError(
        `Unknown text object ID: "${objectId}". Ensure getTextObjects() was called for its page.`,
      );
    }

    const target = this.textObjectsCache.get(objectId)!;
    if (!target.isEditable) {
      throw new PdfNonDeletableObjectError(
        `Object "${objectId}" is not a deletable vector text object.`,
      );
    }

    const objectPath =
      target.objectPath && target.objectPath.length > 0
        ? target.objectPath
        : [target.objectIndex];

    if (objectPath.some((idx) => typeof idx !== 'number' || idx < 0)) {
      throw new PdfInvalidObjectPathError(
        `Invalid object path: [${objectPath.join(', ')}]. All indices must be non-negative.`,
      );
    }

    // Remove any existing pending edit for this objectId
    this.pendingEdits = this.pendingEdits.filter(
      (cmd) => cmd.objectId !== objectId,
    );

    this.pendingEdits.push({
      type: 'delete',
      objectId,
      pageIndex: target.pageIndex,
      objectIndex: target.objectIndex,
      objectPath: target.objectPath,
    });

    this.deletedObjectIds.add(objectId);

    this.pushHistory({
      type: 'delete',
      targetObject: target,
      wasInserted: false,
      previousPendingCommand: previousPending,
    });
    this.refreshSaveState();
  }

  insertText(
    pageIndex: number,
    text: string,
    position: { x: number; y: number },
    format?: PdfTextFormatOptions,
  ): PdfTextObject {
    this.ensureDocumentOpen();

    if (pageIndex < 0 || pageIndex >= (this.docHandle?.pageCount ?? 0)) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} is out of range`);
    }

    if (!text || text.trim().length === 0) {
      throw new PdfInvalidReplacementError('Inserted text cannot be empty or whitespace only.');
    }

    // Phase 15: added text uses standard fonts; refuse characters they cannot draw
    assertInsertableText(text);

    const fontSize = format?.fontSize ?? 14;
    const fontName = resolveStandardFontName(format);
    const color = format?.color ?? '#000000';

    const pageSize: PdfPageSize = this.pageSizeCache.get(pageIndex) ?? { pageIndex, width: 612, height: 792 };

    // Approximate bounding box in document top-left coordinates
    const charWidth = fontSize * 0.54;
    const width = Math.max(text.length * charWidth, 24);
    const height = fontSize * 1.25;

    // PDF user-space baseline origin + upright orientation (rotation-aware; unrotated pages:
    // pdfX = x, pdfY = pageHeight - (y + fontSize) exactly as before)
    const placement = placeInsertedText(pageSize, position, fontSize, { width, height });
    const pdfX = placement.pdfX;
    const pdfY = placement.pdfY;

    // Stable optimistic identifier
    const objectId = `p${pageIndex}_ins_${Date.now()}_${++this.insertCounter}`;

    const optimisticObj: PdfTextObject = {
      id: objectId,
      pageIndex,
      objectIndex: -1, // optimistic until saved & reopened
      text,
      bounds: { x: position.x, y: position.y, width, height },
      pdfBounds: placement.pdfBounds,
      fontSize,
      fontName,
      color,
      colorRgba: null,
      matrix: placement.matrix,
      isEditable: true,
    };

    this.insertedObjectsCache.set(objectId, optimisticObj);

    const insertCommand: PdfInsertCommand = {
      type: 'insert',
      objectId,
      pageIndex,
      text,
      x: pdfX,
      y: pdfY,
      bounds: optimisticObj.bounds,
      fontSize,
      fontName,
      color,
    };

    this.pendingEdits.push(insertCommand);

    this.pushHistory({
      type: 'insert',
      insertedObject: optimisticObj,
      command: insertCommand,
    });
    this.refreshSaveState();

    return optimisticObj;
  }

  async applyNewTextInsertion(
    pageIndex: number,
    text: string,
    position: { x: number; y: number },
    workingCopyPath: string,
    format?: PdfTextFormatOptions,
  ): Promise<{
    result: PdfMultiEditResult;
    insertedObject: PdfTextObject;
  }> {
    this.ensureDocumentOpen();

    if (pageIndex < 0 || pageIndex >= (this.docHandle?.pageCount ?? 0)) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} is out of range`);
    }

    if (!text || text.trim().length === 0) {
      throw new PdfInvalidReplacementError('Inserted text cannot be empty or whitespace only.');
    }

    if (
      !position ||
      typeof position.x !== 'number' ||
      typeof position.y !== 'number' ||
      isNaN(position.x) ||
      isNaN(position.y)
    ) {
      throw new PdfInvalidPlacementError('Invalid text placement coordinates.');
    }

    this.validateWorkingCopyPath(workingCopyPath);

    const trimmedText = text.trim();
    // Phase 15: added text uses standard fonts; refuse characters they cannot draw
    assertInsertableText(trimmedText);

    const pageSize = await this.getPageSize(pageIndex);

    const fontSize = format?.fontSize ?? 14;
    const fontName = resolveStandardFontName(format);
    const color = format?.color ?? '#000000';

    const charWidth = fontSize * 0.54;
    const width = Math.max(trimmedText.length * charWidth, 24);
    const height = fontSize * 1.25;

    // PDF user-space baseline origin (rotation-aware; unrotated pages unchanged). The native
    // layer orients the text upright for the page's rotation.
    const placement = placeInsertedText(
      pageSize.height ? pageSize : { ...pageSize, height: 792 },
      position,
      fontSize,
      { width, height },
    );
    const pdfX = placement.pdfX;
    const pdfY = placement.pdfY;

    const objectId = `p${pageIndex}_ins_${Date.now()}_${++this.insertCounter}`;

    const insertCmd: PdfInsertCommand = {
      type: 'insert',
      objectId,
      pageIndex,
      text: trimmedText,
      x: pdfX,
      y: pdfY,
      bounds: { x: position.x, y: position.y, width, height },
      fontSize,
      fontName,
      color,
    };

    const result = await this.applyRevision(
      insertCmd,
      workingCopyPath,
      'insert',
      (errMsg) => new PdfTextInsertionError(errMsg),
      'Native insertion failed',
    );

    // Fetch genuine native-extracted text objects from the new working copy
    const updatedPageObjects = await this.getTextObjects(pageIndex);

    // Locate newly inserted object: match by exact text and coordinate proximity or last inserted
    let reconciled = updatedPageObjects.find(
      (obj) =>
        obj.text === trimmedText &&
        Math.abs(obj.bounds.x - position.x) < 40 &&
        Math.abs(obj.bounds.y - position.y) < 40,
    );

    if (!reconciled) {
      reconciled = updatedPageObjects.find(
        (obj) => obj.text === trimmedText,
      );
    }

    if (!reconciled) {
      reconciled = updatedPageObjects[updatedPageObjects.length - 1];
    }

    if (!reconciled) {
      reconciled = {
        id: objectId,
        pageIndex,
        objectIndex: updatedPageObjects.length,
        objectPath: [updatedPageObjects.length],
        text: trimmedText,
        bounds: { x: position.x, y: position.y, width, height },
        pdfBounds: placement.pdfBounds,
        fontSize,
        fontName,
        color,
        colorRgba: null,
        matrix: placement.matrix,
        isEditable: true,
      };
    }

    this.textObjectsCache.set(reconciled.id, reconciled);

    return {
      result,
      insertedObject: reconciled,
    };
  }

  /**
   * Writes a text box (one or more lines, each a standard-14 text object) into the page as ONE
   * applied revision: one native batch, reopen verification, one undo step. `lines` are
   * display-space top-left positions (baseline at y + fontSize, rotation-aware like single
   * insertions). With `replaceObjectIds` the same batch first deletes those objects (moving /
   * resizing text that PIE added); nothing is applied when any id or line is invalid.
   */
  async applyTextBoxInsertion(
    pageIndex: number,
    lines: readonly { readonly text: string; readonly position: { readonly x: number; readonly y: number } }[],
    workingCopyPath: string,
    format?: PdfTextFormatOptions,
    replaceObjectIds: readonly string[] = [],
  ): Promise<{ result: PdfMultiEditResult; insertedObjects: PdfTextObject[] }> {
    this.ensureDocumentOpen();
    if (pageIndex < 0 || pageIndex >= (this.docHandle?.pageCount ?? 0)) {
      throw new PdfPageOutOfRangeError(`Page index ${pageIndex} is out of range`);
    }
    const items = lines
      .map((l) => ({ text: l.text.replace(/\s+$/u, ''), position: l.position }))
      .filter((l) => l.text.trim().length > 0);
    if (items.length === 0) {
      throw new PdfInvalidReplacementError('Inserted text cannot be empty or whitespace only.');
    }
    for (const item of items) {
      const p = item.position;
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || isNaN(p.x) || isNaN(p.y)) {
        throw new PdfInvalidPlacementError('Invalid text placement coordinates.');
      }
      // Added text uses standard fonts; refuse characters they cannot draw
      assertInsertableText(item.text);
    }
    this.validateWorkingCopyPath(workingCopyPath);

    const replaced = [...new Set(replaceObjectIds.filter((id) => typeof id === 'string' && id.trim().length > 0))];
    const { targets, commands: deleteCommands } = replaced.length > 0 ? this.deleteCommandsFor(replaced) : { targets: [], commands: [] };
    if (targets.some(({ target }) => target.pageIndex !== pageIndex)) {
      throw new PdfInvalidPlacementError('Text can only be moved within its page.');
    }

    const pageSize = await this.getPageSize(pageIndex);
    const sizeForPlacement = pageSize.height ? pageSize : { ...pageSize, height: 792 };
    const fontSize = format?.fontSize ?? 14;
    const fontName = resolveStandardFontName(format);
    const color = format?.color ?? '#000000';

    const insertCommands: PdfInsertCommand[] = items.map((item) => {
      const width = Math.max(item.text.length * fontSize * 0.54, 24);
      const height = fontSize * 1.25;
      const placement = placeInsertedText(sizeForPlacement, item.position, fontSize, { width, height });
      return {
        type: 'insert',
        objectId: `p${pageIndex}_ins_${Date.now()}_${++this.insertCounter}`,
        pageIndex,
        text: item.text,
        x: placement.pdfX,
        y: placement.pdfY,
        bounds: { x: item.position.x, y: item.position.y, width, height },
        fontSize,
        fontName,
        color,
      };
    });

    const result = await this.applyRevision(
      [...deleteCommands, ...insertCommands],
      workingCopyPath,
      'insert',
      (errMsg) => new PdfTextInsertionError(errMsg),
      'Native insertion failed',
    );

    const updated = await this.getTextObjects(pageIndex);
    for (const { target } of targets) {
      this.retiredObjects.set(target.id, pdfObjectFingerprint(target));
    }
    // Reconcile each line with the extracted object nearest its requested position
    const used = new Set<string>();
    const insertedObjects: PdfTextObject[] = [];
    for (const item of items) {
      const match = updated
        .filter((o) => !used.has(o.id) && o.text.trim() === item.text.trim())
        .sort(
          (a, b) =>
            Math.hypot(a.bounds.x - item.position.x, a.bounds.y - item.position.y) -
            Math.hypot(b.bounds.x - item.position.x, b.bounds.y - item.position.y),
        )[0];
      if (match) {
        used.add(match.id);
        insertedObjects.push(match);
      }
    }
    return { result, insertedObjects };
  }

  /**
   * Applies a character-range edit (see pdfCharSelection.planRangeEdit) as ONE applied revision:
   * each item replaces an object's whole text (newText) or deletes the object (null), in one
   * native batch with `reflow`, so the rest of the line closes up or makes room. `format`
   * applies to the first replaced object (which receives the new text). Everything is
   * validated before anything is applied; the result is reopen-verified like every edit.
   */
  async applyTextRangeEdit(
    items: readonly { readonly objectId: string; readonly newText: string | null }[],
    workingCopyPath: string,
    format?: PdfTextFormatOptions,
  ): Promise<{ result: PdfMultiEditResult }> {
    this.ensureDocumentOpen();
    if (items.length === 0) throw new PdfInvalidObjectIdError('Nothing to change.');
    this.validateWorkingCopyPath(workingCopyPath);

    const commands: PdfTextEditCommand[] = [];
    const pages = new Set<number>();
    const deletedTargets: PdfTextObject[] = [];
    let formatUsed = false;
    for (const item of items) {
      const target = this.textObjectsCache.get(item.objectId);
      if (!target || this.isDeletedReference(item.objectId)) {
        throw new PdfInvalidObjectIdError(`Unknown text object ID: "${item.objectId}". Reload the page and try again.`);
      }
      if (!target.isEditable) {
        throw new PdfUnsupportedReplacementError(`Object "${item.objectId}" is not editable vector text.`);
      }
      const objectPath = target.objectPath && target.objectPath.length > 0 ? [...target.objectPath] : [target.objectIndex];
      if (objectPath.some((idx) => typeof idx !== 'number' || idx < 0)) {
        throw new PdfInvalidObjectPathError(`Invalid object path: [${objectPath.join(', ')}].`);
      }
      pages.add(target.pageIndex);
      const text = item.newText === null ? '' : item.newText.replace(/\s*\n\s*/g, ' ').trim();
      if (text.length === 0) {
        commands.push({
          type: 'delete',
          objectId: target.id,
          pageIndex: target.pageIndex,
          objectIndex: target.objectIndex,
          objectPath,
          originalText: target.text,
          reflow: true,
        } as PdfDeleteCommand);
        deletedTargets.push(target);
      } else {
        assertReplaceableText(text);
        commands.push({
          type: 'replace',
          objectId: target.id,
          pageIndex: target.pageIndex,
          objectIndex: target.objectIndex,
          objectPath,
          originalText: target.text,
          newText: text,
          ...(format && !formatUsed ? { format } : {}),
          reflow: true,
        } as PdfReplaceCommand);
        formatUsed = true;
      }
    }
    if (pages.size > 1) throw new PdfInvalidReplacementError('A text edit must stay on one page.');

    const onlyDeletes = commands.every((c) => c.type === 'delete');
    const result = await this.applyRevision(
      commands,
      workingCopyPath,
      onlyDeletes ? 'delete' : 'replace',
      (errMsg) => {
        const lower = errMsg.toLowerCase();
        if (lower.includes('font') || lower.includes('glyph') || lower.includes('subset')) {
          return new PdfFontLimitationError(errMsg);
        }
        if (lower.includes('locator') || lower.includes('path')) return new PdfInvalidObjectPathError(errMsg);
        return onlyDeletes ? new PdfTextDeletionError(errMsg) : new PdfTextReplacementError(errMsg);
      },
      'Native text edit failed',
    );
    for (const pageIndex of pages) await this.getTextObjects(pageIndex);
    for (const target of deletedTargets) this.retiredObjects.set(target.id, pdfObjectFingerprint(target));
    return { result };
  }

  getPendingEdits(): readonly PdfTextEditCommand[] {
    return [...this.pendingEdits];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  async undo(): Promise<void> {
    this.ensureDocumentOpen();
    const action = this.undoStack.pop();
    if (!action) return;

    if (action.type === 'revision') {
      try {
        await this.undoRevision(action);
      } catch (err) {
        this.undoStack.push(action);
        throw err;
      }
      this.redoStack.push(action);
      this.refreshSaveState();
      return;
    }

    // Queued-edit undo: completes synchronously (before the returned promise exists).
    if (action.type === 'insert') {
      // Revert insertion: remove from inserted objects cache and pending edits
      this.insertedObjectsCache.delete(action.insertedObject.id);
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== action.insertedObject.id,
      );
    } else if (action.type === 'delete') {
      // Revert deletion: remove from deleted set
      this.deletedObjectIds.delete(action.targetObject.id);
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== action.targetObject.id,
      );

      if (action.wasInserted) {
        this.insertedObjectsCache.set(action.targetObject.id, action.targetObject);
        if (action.previousPendingCommand) {
          this.pendingEdits.push(action.previousPendingCommand);
        }
      } else {
        if (action.previousPendingCommand) {
          this.pendingEdits.push(action.previousPendingCommand);
        }
      }
    } else if (action.type === 'replace') {
      // Revert replacement
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== action.objectId,
      );

      if (action.wasInserted) {
        const existing = this.insertedObjectsCache.get(action.objectId);
        if (existing) {
          const fontSize = action.previousFormat?.fontSize ?? existing.fontSize ?? 14;
          const fontName = action.previousFormat
            ? resolveStandardFontName(action.previousFormat)
            : existing.fontName;
          const color = action.previousFormat?.color ?? existing.color ?? '#000000';

          const reverted: PdfTextObject = {
            ...existing,
            text: action.previousText,
            fontSize,
            fontName,
            color,
          };
          this.insertedObjectsCache.set(action.objectId, reverted);

          if (action.previousPendingCommand && action.previousPendingCommand.type === 'insert') {
            this.pendingEdits.push(action.previousPendingCommand);
          }
        }
      } else {
        if (action.previousPendingCommand) {
          this.pendingEdits.push(action.previousPendingCommand);
        }
      }
    }

    this.redoStack.push(action);
    this.refreshSaveState();
  }

  async redo(): Promise<void> {
    this.ensureDocumentOpen();
    const action = this.redoStack.pop();
    if (!action) return;

    if (action.type === 'revision') {
      try {
        await this.redoRevision(action);
      } catch (err) {
        this.redoStack.push(action);
        throw err;
      }
      this.undoStack.push(action);
      this.refreshSaveState();
      return;
    }

    // Queued-edit redo: completes synchronously (before the returned promise exists).
    if (action.type === 'insert') {
      // Re-apply insertion
      this.insertedObjectsCache.set(action.insertedObject.id, action.insertedObject);
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== action.insertedObject.id,
      );
      this.pendingEdits.push(action.command);
    } else if (action.type === 'delete') {
      // Re-apply deletion
      this.deletedObjectIds.add(action.targetObject.id);
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== action.targetObject.id,
      );

      if (action.wasInserted) {
        this.insertedObjectsCache.delete(action.targetObject.id);
      } else {
        // Preserve the object locator path so nested Form XObject deletions stay correct.
        this.pendingEdits.push({
          type: 'delete',
          objectId: action.targetObject.id,
          pageIndex: action.targetObject.pageIndex,
          objectIndex: action.targetObject.objectIndex,
          objectPath: action.targetObject.objectPath,
        });
      }
    } else if (action.type === 'replace') {
      // Re-apply replacement
      this.pendingEdits = this.pendingEdits.filter(
        (cmd) => cmd.objectId !== action.objectId,
      );

      if (action.wasInserted) {
        const existing = this.insertedObjectsCache.get(action.objectId);
        if (existing) {
          const fontSize = action.newFormat?.fontSize ?? existing.fontSize ?? 14;
          const fontName = action.newFormat
            ? resolveStandardFontName(action.newFormat)
            : existing.fontName;
          const color = action.newFormat?.color ?? existing.color ?? '#000000';

          const updated: PdfTextObject = {
            ...existing,
            text: action.newText,
            fontSize,
            fontName,
            color,
          };
          this.insertedObjectsCache.set(action.objectId, updated);

          this.pendingEdits.push({
            type: 'insert',
            objectId: action.objectId,
            pageIndex: existing.pageIndex,
            text: action.newText,
            x: existing.pdfBounds.left,
            y: existing.pdfBounds.bottom,
            bounds: existing.bounds,
            fontSize,
            fontName: fontName ?? undefined,
            color,
          });
        }
      } else {
        const target = this.textObjectsCache.get(action.objectId);
        if (target) {
          // Preserve the object locator path so nested Form XObject replacements stay correct.
          this.pendingEdits.push({
            type: 'replace',
            objectId: action.objectId,
            pageIndex: target.pageIndex,
            objectIndex: target.objectIndex,
            objectPath: target.objectPath,
            newText: action.newText,
            format: action.newFormat,
          });
        }
      }
    }

    this.undoStack.push(action);
    this.refreshSaveState();
  }

  clearHistory(): void {
    // Files only reachable through the dropped history are released for deletion
    this.discardRevisionFiles(this.undoStack);
    this.discardRevisionFiles(this.redoStack);
    this.undoStack = [];
    this.redoStack = [];
  }


  /**
   * Retrieves original unedited text object by ID from cache (used for knockout overlays).
   */
  getOriginalObject(objectId: string): PdfTextObject | undefined {
    return this.textObjectsCache.get(objectId);
  }

  /**
   * Moves a pending inserted text object to a new page coordinate before saving.
   */
  moveInsertedText(objectId: string, newPosition: { x: number; y: number }): void {
    this.ensureDocumentOpen();
    const obj = this.insertedObjectsCache.get(objectId);
    if (!obj) return;

    const pageSize: PdfPageSize =
      this.pageSizeCache.get(obj.pageIndex) ?? { pageIndex: obj.pageIndex, width: 612, height: 792 };
    // Rotation-aware (unrotated pages: pdfX = x, pdfY = pageHeight - (y + fontSize) as before)
    const placement = placeInsertedText(pageSize, newPosition, obj.fontSize || 14, {
      width: obj.bounds.width,
      height: obj.bounds.height,
    });
    const pdfX = placement.pdfX;
    const pdfY = placement.pdfY;
    const updatedBounds = { ...obj.bounds, x: newPosition.x, y: newPosition.y };

    const origMatrix = obj.matrix || placement.matrix;
    const updatedObj: PdfTextObject = {
      ...obj,
      bounds: updatedBounds,
      pdfBounds: placement.pdfBounds,
      matrix: {
        a: origMatrix.a,
        b: origMatrix.b,
        c: origMatrix.c,
        d: origMatrix.d,
        e: pdfX,
        f: pdfY,
      },
    };
    this.insertedObjectsCache.set(objectId, updatedObj);

    // Update command in pendingEdits queue
    const cmdIdx = this.pendingEdits.findIndex(
      (c) => c.type === 'insert' && c.objectId === objectId,
    );
    if (cmdIdx !== -1) {
      const cmd = this.pendingEdits[cmdIdx];
      if (cmd.type === 'insert') {
        this.pendingEdits[cmdIdx] = {
          ...cmd,
          x: pdfX,
          y: pdfY,
          bounds: updatedBounds,
        };
      }
    }
  }

  /**
   * Persists the current document state (applied working-copy revisions plus any queued
   * commands) to `outputPath`, validates the output by reopening it with PDFium and makes
   * it the new clean document.
   *
   * - Queued commands are written in one native batch.
   * - With no queued commands (all edits already applied to the working copy, or no edits)
   *   a verified native copy is written; an empty edit batch is never sent.
   * - Output that is the open file, the clean file or any undo/redo revision file is staged
   *   to a temporary file first, so a failed save never damages a recovery point.
   */
  async saveDocument(outputPath?: string): Promise<{
    outputPath: string;
    result: PdfMultiEditResult;
    verified: boolean;
  }> {
    this.ensureDocumentOpen();

    if (this.isSaving) {
      throw new PdfConcurrentSaveError('A save operation is already in progress.');
    }

    if (outputPath !== undefined) {
      if (typeof outputPath !== 'string' || !outputPath.trim() || !outputPath.trim().toLowerCase().endsWith('.pdf')) {
        throw new PdfSaveError('Output path must be a valid non-empty string ending with .pdf');
      }
    }

    const resolvedOutput = outputPath && outputPath.trim().length > 0
      ? outputPath.trim()
      : this.deriveDefaultOutputPath();

    if (!resolvedOutput) {
      throw new PdfSaveError('Output PDF path cannot be empty.');
    }

    // Source immutability: Output cannot be the original imported source document
    const sourcePath = this.originalSourcePath || this.currentFilePath!;
    if (resolvedOutput.trim() === sourcePath.trim()) {
      throw new PdfSaveError(
        'Input and output paths must be different to preserve source immutability. Output path cannot be the original source file.',
      );
    }

    this.isSaving = true;
    this.saveState = 'SAVING';

    try {
      const mustStage = this.getProtectedFilePaths().includes(resolvedOutput);
      const targetOutput = mustStage
        ? `${resolvedOutput.replace(/\.pdf$/i, '')}.tmp_${Date.now()}.pdf`
        : resolvedOutput;

      // Two distinct native operations: a non-empty edit batch, or a verified copy.
      // An empty applyBatchEdits() batch is never sent.
      let result: PdfMultiEditResult;
      const batchCommandCount = this.pendingEdits.length;
      if (batchCommandCount > 0) {
        const request: PdfBatchEditRequest = {
          inputPdfPath: this.currentFilePath!,
          outputPdfPath: targetOutput,
          commands: [...this.pendingEdits],
        };
        result = await this.engine.applyBatchEdits(request);
      } else {
        result = await this.engine.copyDocument(this.currentFilePath!, targetOutput);
      }

      // Native success alone is not enough: every applied edit must be verified in the
      // reopened output, and the output is reopened again below (verifyPdfOutput).
      this.assertSaveSucceeded(result, batchCommandCount);

      // Verification with PDFium
      await this.verifyPdfOutput(targetOutput, this.docHandle?.pageCount);

      let finalPath = targetOutput;
      if (targetOutput !== resolvedOutput && typeof this.engine.replaceFile === 'function') {
        await this.engine.replaceFile(targetOutput, resolvedOutput);
        finalPath = resolvedOutput;
      }

      // Successfully saved: the verified output becomes the clean document
      this.pendingEdits = [];
      this.insertedObjectsCache.clear();
      this.deletedObjectIds.clear();

      await this.open(finalPath, true);
      this.cleanFilePath = finalPath;
      this.isSaving = false;
      this.refreshSaveState();

      return {
        outputPath: finalPath,
        result,
        verified: true,
      };
    } catch (err) {
      this.saveState = 'SAVE_FAILED';
      throw err;
    } finally {
      this.isSaving = false;
    }
  }

  async saveEdits(outputPath: string): Promise<PdfMultiEditResult> {
    const { result } = await this.saveDocument(outputPath);
    return result;
  }

  async saveDocumentAs(outputPath: string): Promise<{
    outputPath: string;
    result: PdfMultiEditResult;
    verified: boolean;
  }> {
    this.ensureDocumentOpen();

    if (!outputPath || typeof outputPath !== 'string' || !outputPath.trim() || !outputPath.trim().toLowerCase().endsWith('.pdf')) {
      throw new PdfSaveAsError('Destination path must be a valid non-empty string ending with .pdf');
    }

    const sourcePath = this.getSourceFilePath();
    if (sourcePath && outputPath.trim() === sourcePath.trim()) {
      throw new PdfSaveAsError('Cannot save over the immutable source document.');
    }

    return this.saveDocument(outputPath.trim());
  }

  /**
   * Discards all unsaved work (queued commands and applied working-copy revisions) and
   * returns to the last clean document (the opened file, or the last successful save).
   */
  async discardWorkingChanges(): Promise<void> {
    if (this.isSaving) {
      throw new PdfConcurrentSaveError('Cannot discard changes while a save operation is in progress.');
    }

    this.pendingEdits = [];
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
    this.textObjectsCache.clear();
    this.pageSizeCache.clear();
    this.retiredObjects = new Map();
    this.clearHistory();

    if (this.cleanFilePath && this.currentFilePath !== this.cleanFilePath) {
      await this.open(this.cleanFilePath, true);
    }
    this.refreshSaveState();
    if (this.saveState !== 'SAVING') {
      this.saveState = 'CLEAN';
    }
  }

  async verifyPdfOutput(outputPath: string, expectedPageCount?: number): Promise<boolean> {
    if (!outputPath || typeof outputPath !== 'string' || !outputPath.trim()) {
      throw new PdfValidationFailureError('Output path cannot be empty for verification');
    }
    const handle = await this.engine.openDocument(outputPath);
    try {
      if (!handle || handle.docHandle <= 0 || handle.pageCount <= 0) {
        throw new PdfCorruptedError('Saved output PDF has invalid handle or 0 pages.');
      }
      if (expectedPageCount !== undefined && handle.pageCount !== expectedPageCount) {
        throw new PdfValidationFailureError(
          `Page count mismatch: expected ${expectedPageCount}, got ${handle.pageCount}`,
        );
      }
      // Verify every page can be opened and has valid positive dimensions where engine supports
      if (typeof this.engine.getPageSize === 'function') {
        for (let p = 0; p < handle.pageCount; ++p) {
          try {
            const size = await this.engine.getPageSize(handle.docHandle, p);
            if (size && (size.width <= 0 || size.height <= 0)) {
              throw new PdfCorruptedError(`Page ${p} has invalid dimensions (${size?.width}x${size?.height})`);
            }
          } catch (sizeErr: any) {
            if (sizeErr instanceof PdfCorruptedError) throw sizeErr;
            // Native mock in older test suites may not define getPageSize
          }
        }
      }
      return true;
    } finally {
      if (handle && handle.docHandle > 0) {
        await this.engine.closeDocument(handle.docHandle);
      }
    }
  }

  getSaveState(): PdfSaveState {
    return this.saveState;
  }

  isDirty(): boolean {
    return this.saveState === 'SAVE_FAILED' || this.computeDirty();
  }

  getSourceFilePath(): string | null {
    return this.originalSourcePath || this.currentFilePath;
  }

  getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  /** File of the last clean state (opened, discarded-to, or successfully saved). */
  getCleanFilePath(): string | null {
    return this.cleanFilePath;
  }

  /**
   * Every file the editor may still need: the immutable source, the clean file, the open
   * file and all undo/redo revision files. Temporary-file cleanup must never delete these.
   */
  getProtectedFilePaths(): string[] {
    const paths = new Set<string>();
    if (this.originalSourcePath) paths.add(this.originalSourcePath);
    if (this.cleanFilePath) paths.add(this.cleanFilePath);
    if (this.currentFilePath) paths.add(this.currentFilePath);
    for (const action of [...this.undoStack, ...this.redoStack]) {
      if (action.type === 'revision') {
        paths.add(action.beforePath);
        paths.add(action.afterPath);
      }
    }
    return [...paths];
  }

  deriveDefaultOutputPath(): string {
    const base = this.originalSourcePath || this.currentFilePath || 'document.pdf';
    return base.replace(/(_(working|edited)(_\d+)?)?\.pdf$/i, '') + '_edited.pdf';
  }

  async close(): Promise<void> {
    if (this.docHandle) {
      try {
        await this.engine.closeDocument(this.docHandle.docHandle);
      } finally {
        this.docHandle = null;
        this.currentFilePath = null;
        this.originalSourcePath = null;
        this.cleanFilePath = null;
        this.textObjectsCache.clear();
        this.deletedObjectIds.clear();
        this.insertedObjectsCache.clear();
        this.pageSizeCache.clear();
        this.retiredObjects = new Map();
        this.pendingEdits = [];
        this.clearHistory();
        this.isSaving = false;
        this.saveState = 'CLEAN';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Working-copy revisions
  // ---------------------------------------------------------------------------

  /**
   * Applies `command` natively from the open file into `workingCopyPath` and makes the
   * verified working copy the open document. Queued commands outstanding at this point are
   * folded into the same native batch (otherwise reopening would silently drop them) and
   * snapshotted so undo restores them exactly.
   */
  private async applyRevision(
    commandOrCommands: PdfTextEditCommand | readonly PdfTextEditCommand[],
    workingCopyPath: string,
    operation: 'replace' | 'delete' | 'insert',
    mapFailure: (message: string) => Error,
    defaultFailureMessage: string,
  ): Promise<PdfMultiEditResult> {
    const commands: readonly PdfTextEditCommand[] = Array.isArray(commandOrCommands)
      ? commandOrCommands
      : [commandOrCommands as PdfTextEditCommand];
    const command = commands[0];
    const beforePath = this.currentFilePath!;
    const afterPath = workingCopyPath.trim();
    const folded = this.capturePendingSnapshot();

    const request: PdfBatchEditRequest = {
      inputPdfPath: beforePath,
      outputPdfPath: afterPath,
      commands: [...this.pendingEdits, ...commands],
    };

    const result = await this.engine.applyBatchEdits(request);
    this.assertBatchSucceeded(result, mapFailure, defaultFailureMessage, request.commands.length);

    // The verified working copy becomes the open document; history, source and clean
    // file are preserved (unlike open()).
    await this.reopenRevision(afterPath);

    if (folded) {
      const foldedActions = new Set(folded.undoActions);
      this.undoStack = this.undoStack.filter((a) => !foldedActions.has(a));
    }
    this.pendingEdits = [];
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
    this.retiredObjects = new Map();

    const revision: PdfRevisionHistoryAction = {
      type: 'revision',
      operation,
      objectId: command.objectId,
      pageIndex: command.pageIndex,
      beforePath,
      afterPath,
      foldedPending: folded,
    };
    this.pushHistory(revision);
    this.pruneRevisionHistory();
    this.refreshSaveState();
    return result;
  }

  /**
   * Page tools and markup (rotate / delete / move / insert / duplicate pages; ink, shapes,
   * highlights, images): applied natively from the open file into `workingCopyPath`, which
   * becomes the open document as ONE undoable revision (undo reopens the previous file).
   * The source and the clean file are never modified.
   */
  async applyDocumentOperations(
    operations: readonly PdfDocumentOperation[],
    workingCopyPath: string,
  ): Promise<PdfDocumentOperationsResult> {
    this.ensureDocumentOpen();
    if (this.pendingEdits.length > 0) {
      throw new PdfDocumentOperationError('Apply or discard the queued text edits before changing pages.');
    }
    const pageCount = this.getPageCount();
    validateDocumentOperations(operations, pageCount);
    this.validateWorkingCopyPath(workingCopyPath);
    if (typeof this.engine.applyDocumentOperations !== 'function') {
      throw new PdfOutputUnavailableError('Page tools are not available on this platform.');
    }
    const beforePath = this.currentFilePath!;
    const afterPath = workingCopyPath.trim();
    const expected = expectedPageCount(operations, pageCount);
    const result = await this.engine.applyDocumentOperations(beforePath, afterPath, operations);
    if (!result.verified || !result.sourceUnchanged || result.pageCountAfter !== expected) {
      throw new PdfDocumentOperationError('The changed PDF could not be verified. Nothing was changed.');
    }

    await this.reopenRevision(afterPath);
    if (this.docHandle && this.docHandle.pageCount !== expected) {
      // The reopened file disagrees with the verified result: go back to the previous file.
      await this.reopenRevision(beforePath);
      throw new PdfDocumentOperationError('The changed PDF has an unexpected number of pages.');
    }
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
    this.retiredObjects = new Map();

    const kinds = new Set(operations.map(operationKind));
    this.pushHistory({
      type: 'revision',
      operation: kinds.has('pages') ? 'pages' : 'markup',
      objectId: '',
      pageIndex: operations[0].pageIndex,
      beforePath,
      afterPath,
    });
    this.pruneRevisionHistory();
    this.refreshSaveState();
    return result;
  }

  private async undoRevision(action: PdfRevisionHistoryAction): Promise<void> {
    await this.reopenRevision(action.beforePath);
    this.retiredObjects = new Map();
    const snapshot = action.foldedPending;
    if (snapshot) {
      this.pendingEdits = [...snapshot.pendingEdits];
      this.deletedObjectIds.clear();
      snapshot.deletedObjectIds.forEach((id) => this.deletedObjectIds.add(id));
      this.insertedObjectsCache.clear();
      snapshot.insertedObjects.forEach((obj) => this.insertedObjectsCache.set(obj.id, obj));
      this.undoStack.push(...snapshot.undoActions);
    } else {
      this.pendingEdits = [];
      this.deletedObjectIds.clear();
      this.insertedObjectsCache.clear();
    }
  }

  private async redoRevision(action: PdfRevisionHistoryAction): Promise<void> {
    await this.reopenRevision(action.afterPath);
    this.retiredObjects = new Map();
    if (action.foldedPending) {
      const folded = new Set(action.foldedPending.undoActions);
      this.undoStack = this.undoStack.filter((a) => !folded.has(a));
    }
    this.pendingEdits = [];
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
  }

  /**
   * Switches the open document to another revision file without starting a new session.
   * Opens the new file before closing the old one so a failure leaves the editor usable.
   */
  private async reopenRevision(filePath: string): Promise<void> {
    let handle: PdfDocumentHandle;
    try {
      handle = await this.engine.openDocument(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PdfWorkingCopyError(`Unable to open PDF revision "${filePath}": ${msg}`, err);
    }
    const previous = this.docHandle;
    this.docHandle = handle;
    this.currentFilePath = filePath;
    this.recordFileSize(handle, filePath);
    this.textObjectsCache.clear();
    this.pageSizeCache.clear();
    if (previous && previous.docHandle !== handle.docHandle) {
      try {
        await this.engine.closeDocument(previous.docHandle);
      } catch {
        // The previous revision handle is no longer used; a close failure is not fatal.
      }
    }
  }

  /** Queued-edit state since the last applied revision (null when nothing is queued). */
  private capturePendingSnapshot(): PdfPendingStateSnapshot | undefined {
    if (this.pendingEdits.length === 0) {
      return undefined;
    }
    const undoActions: PdfEditorHistoryAction[] = [];
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const action = this.undoStack[i];
      if (action.type === 'revision') break;
      undoActions.unshift(action);
    }
    return {
      pendingEdits: [...this.pendingEdits],
      deletedObjectIds: [...this.deletedObjectIds],
      insertedObjects: [...this.insertedObjectsCache.values()],
      undoActions,
    };
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  private validateWorkingCopyPath(workingCopyPath: string): void {
    if (!workingCopyPath || workingCopyPath.trim().length === 0) {
      throw new PdfBatchEditError('Working copy output path cannot be empty.');
    }

    if (this.currentFilePath && workingCopyPath.trim() === this.currentFilePath.trim()) {
      throw new PdfBatchEditError(
        'Working copy output path must be separate from input path to ensure source immutability.',
      );
    }

    // Never overwrite the immutable source, the clean file or an undo/redo revision.
    if (this.getProtectedFilePaths().includes(workingCopyPath.trim())) {
      throw new PdfBatchEditError(
        'Working copy output path must not overwrite the source, the last saved document or an undo revision.',
      );
    }
  }

  /** Throws when any native command failed or the source checksum changed. */
  private assertBatchSucceeded(
    result: PdfMultiEditResult,
    mapFailure: (message: string) => Error,
    defaultFailureMessage: string,
    expectedCommandCount: number,
  ): void {
    const failed = Array.isArray(result?.commands)
      ? result.commands.find((c) => c.status === 'failed')
      : undefined;
    if (failed) {
      // Missing glyphs are a typed, user-facing failure regardless of the operation
      throw unsupportedGlyphsErrorFromNative(failed.error) ?? mapFailure(failed.error || defaultFailureMessage);
    }
    this.assertSourceUnchanged(result);
    this.assertReopenVerified(result, expectedCommandCount);
  }

  private assertSaveSucceeded(result: PdfMultiEditResult, expectedCommandCount: number): void {
    if (!result) {
      throw new PdfSaveError('Native save returned no result.');
    }
    if (result.limitations && result.limitations.length > 0) {
      throw new PdfBatchEditError(result.limitations[0]);
    }
    if (Array.isArray(result.commands)) {
      const failedCmd = result.commands.find((c) => c.status === 'failed');
      if (failedCmd) {
        throw (
          unsupportedGlyphsErrorFromNative(failedCmd.error) ??
          new PdfBatchEditError(failedCmd.error || 'Native save operation failed.')
        );
      }
    }
    this.assertSourceUnchanged(result);
    this.assertReopenVerified(result, expectedCommandCount);
  }

  /**
   * Every applied edit must have been verified in the reopened output before an apply or
   * save is reported as successful. Native results carry a per-command verifiedInReopened
   * flag (duplicate-safe, object-level); legacy-shaped results carry aggregate flags.
   * Results without applied edits (verified copies) have nothing to verify here; the
   * output itself is still reopened and validated by verifyPdfOutput().
   */
  private assertReopenVerified(result: PdfMultiEditResult, expectedCommandCount: number): void {
    if (!result) {
      throw new PdfReopenVerificationError('Native operation returned no result. The change was not committed.');
    }
    const commands = Array.isArray(result.commands) ? result.commands : [];
    const applied = commands.filter((c) => c.status === 'applied');

    if (expectedCommandCount > 0 && applied.length === 0 && !(result.appliedCommands > 0)) {
      throw new PdfReopenVerificationError(
        'The native result did not report any applied edit for a non-empty edit batch. The change was not committed.',
      );
    }

    const unverified = applied.find((c) => c.verifiedInReopened === false);
    if (unverified) {
      throw new PdfReopenVerificationError(
        `The ${unverified.type} edit (${unverified.objectId}) could not be verified in the saved PDF` +
          `${unverified.verificationError ? `: ${unverified.verificationError}` : '.'} ` +
          'The change was not committed.',
      );
    }

    if (applied.length === 0 && !(result.appliedCommands > 0)) {
      return;
    }

    const verification = result.reopenedVerification;
    if (!verification) {
      throw new PdfReopenVerificationError(
        'The saved PDF was not verified after reopening. The change was not committed.',
      );
    }
    const missing = verification.missingReplacements ?? [];
    const residual = verification.residualDeletions ?? [];
    if (
      verification.allReplacementsVerified === false ||
      verification.allDeletionsVerified === false ||
      verification.allInsertionsVerified === false ||
      missing.length > 0 ||
      residual.length > 0
    ) {
      const detail = [...missing, ...residual].join(', ');
      throw new PdfReopenVerificationError(
        `Edits could not be verified in the saved PDF${detail ? ` (${detail})` : ''}. The change was not committed.`,
      );
    }
  }

  private assertSourceUnchanged(result: PdfMultiEditResult): void {
    if (
      result &&
      result.sourceChecksumBefore &&
      result.sourceChecksumAfter &&
      result.sourceChecksumBefore !== result.sourceChecksumAfter
    ) {
      throw new PdfBatchEditError(
        'The input PDF changed during the native operation; the result was rejected to protect source immutability.',
      );
    }
  }

  /**
   * True when `objectId` refers to an object deleted by a queued deletion, or to the object
   * removed by the latest applied deletion (and not to a different object that inherited
   * its positional ID).
   */
  private isDeletedReference(objectId: string): boolean {
    if (this.deletedObjectIds.has(objectId)) {
      return true;
    }
    const retiredFingerprint = this.retiredObjects.get(objectId);
    if (!retiredFingerprint) {
      return false;
    }
    const current = this.textObjectsCache.get(objectId);
    if (!current) {
      return true;
    }
    return pdfObjectFingerprint(current) === retiredFingerprint;
  }

  private computeDirty(): boolean {
    if (this.pendingEdits.length > 0) return true;
    return Boolean(
      this.currentFilePath &&
        this.cleanFilePath &&
        this.currentFilePath !== this.cleanFilePath,
    );
  }

  private refreshSaveState(): void {
    if (this.isSaving) return;
    this.saveState = this.computeDirty() ? 'DIRTY' : 'CLEAN';
  }

  private pushHistory(action: PdfEditorHistoryAction): void {
    this.undoStack.push(action);
    // User mutations clear the redo branch; its revision files are no longer reachable.
    this.discardRevisionFiles(this.redoStack);
    this.redoStack = [];
  }

  private discardRevisionFiles(actions: readonly PdfEditorHistoryAction[]): void {
    for (const action of actions) {
      if (action.type === 'revision') {
        this.discardedRevisionFiles.add(action.beforePath);
        this.discardedRevisionFiles.add(action.afterPath);
      }
    }
  }

  private recordFileSize(handle: PdfDocumentHandle | null, filePath: string): void {
    if (handle && typeof handle.fileSizeBytes === 'number' && handle.fileSizeBytes >= 0) {
      this.revisionFileSizes.set(filePath, handle.fileSizeBytes);
    }
  }

  /** Bytes of revision files referenced by history (source and clean file excluded). */
  private referencedRevisionBytes(): number {
    const paths = new Set<string>();
    for (const action of [...this.undoStack, ...this.redoStack]) {
      if (action.type === 'revision') {
        paths.add(action.beforePath);
        paths.add(action.afterPath);
      }
    }
    if (this.originalSourcePath) paths.delete(this.originalSourcePath);
    if (this.cleanFilePath) paths.delete(this.cleanFilePath);
    let total = 0;
    paths.forEach((p) => {
      total += this.revisionFileSizes.get(p) ?? 0;
    });
    return total;
  }

  /**
   * Storage cap for applied-edit revisions. When the history holds more revisions than
   * allowed (or their files exceed the byte budget), the OLDEST undo steps are dropped —
   * deterministically, always keeping the most recent revision so the last edit can be
   * undone. Dropped steps can no longer be undone; their files are released for deletion
   * (never the source, the clean file, the open file or any file still in history).
   */
  private pruneRevisionHistory(): void {
    const countRevisions = () => this.undoStack.filter((a) => a.type === 'revision').length;
    while (
      countRevisions() > 1 &&
      (countRevisions() > this.revisionLimits.maxRevisions ||
        this.referencedRevisionBytes() > this.revisionLimits.maxBytes)
    ) {
      const oldest = this.undoStack.findIndex((a) => a.type === 'revision');
      if (oldest < 0) break;
      // Everything up to and including the oldest revision becomes un-undoable together.
      this.discardRevisionFiles(this.undoStack.splice(0, oldest + 1));
      this.historyTruncated = true;
    }
  }

  /** Overrides the revision storage cap (minimum one revision). */
  setRevisionLimits(limits: Partial<PdfRevisionLimits>): void {
    this.revisionLimits = {
      maxRevisions: Math.max(1, Math.floor(limits.maxRevisions ?? this.revisionLimits.maxRevisions)),
      maxBytes: Math.max(0, limits.maxBytes ?? this.revisionLimits.maxBytes),
    };
    this.pruneRevisionHistory();
  }

  /** True once older undo steps were dropped by the revision storage cap. */
  isHistoryTruncated(): boolean {
    return this.historyTruncated;
  }

  /**
   * Revision files that are no longer referenced by history and are not protected (source,
   * clean file, open file, any undo/redo revision). The caller deletes them; each path is
   * returned once.
   */
  takeDiscardedRevisionFiles(): string[] {
    const protectedPaths = new Set(this.getProtectedFilePaths());
    const released = [...this.discardedRevisionFiles].filter((p) => !protectedPaths.has(p));
    this.discardedRevisionFiles.clear();
    return released;
  }

  /**
   * Identity of what is currently rendered: the open native document handle and file. A new
   * value after every open / applied edit / undo / redo / save, so render caches keyed by it
   * can never serve a stale page.
   */
  getRenderIdentity(): { docHandle: number; filePath: string } | null {
    if (!this.docHandle || !this.currentFilePath) return null;
    return { docHandle: this.docHandle.docHandle, filePath: this.currentFilePath };
  }

  private ensureDocumentOpen(): void {
    if (!this.docHandle || !this.currentFilePath) {
      throw new PdfDocumentClosedError(
        'No PDF document is currently open. Call open(filePath) first.',
      );
    }
  }
}
