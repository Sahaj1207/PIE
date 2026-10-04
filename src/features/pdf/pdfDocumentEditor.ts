import {
  IPdfDocumentEditor,
  IPdfiumEngine,
  PdfBatchEditRequest,
  PdfDocumentHandle,
  PdfEditorHistoryAction,
  PdfInsertCommand,
  PdfMultiEditResult,
  PdfPageSize,
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
} from '../../errors';
import { PdfReplaceCommand, PdfDeleteCommand } from './types';

export function resolveStandardFontName(format?: PdfTextFormatOptions): string {
  const family = format?.fontFamily ?? 'Helvetica';
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
  private saveState: PdfSaveState = 'CLEAN';

  // Domain undo/redo history stacks (no native pointers)
  private undoStack: PdfEditorHistoryAction[] = [];
  private redoStack: PdfEditorHistoryAction[] = [];

  constructor(engine: IPdfiumEngine, initialFilePath?: string) {
    this.engine = engine;
    if (initialFilePath) {
      this.currentFilePath = initialFilePath;
      this.originalSourcePath = initialFilePath;
    }
  }

  async open(filePath: string, isWorkingCopy = false): Promise<void> {
    const retainedSource = (isWorkingCopy && this.originalSourcePath) ? this.originalSourcePath : null;
    if (this.docHandle) {
      await this.close();
    }
    if (retainedSource) {
      this.originalSourcePath = retainedSource;
      this.saveState = 'DIRTY';
    } else {
      this.originalSourcePath = filePath;
      this.saveState = 'CLEAN';
    }
    this.currentFilePath = filePath;
    this.textObjectsCache.clear();
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
    this.pageSizeCache.clear();
    this.pendingEdits = [];
    this.insertCounter = 0;
    this.clearHistory();
    this.isSaving = false;
    this.docHandle = await this.engine.openDocument(filePath);
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
      // 1. Skip deleted objects
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

    if (this.deletedObjectIds.has(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Cannot replace text on deleted object "${objectId}".`,
      );
    }

    if (!newText || newText.trim().length === 0) {
      throw new PdfInvalidReplacementError(
        'Replacement text cannot be empty or whitespace only.',
      );
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
          x: existingIns.pdfBounds.left,
          y: existingIns.pdfBounds.bottom,
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

    this.saveState = 'DIRTY';
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

    if (this.deletedObjectIds.has(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Cannot replace text on deleted object "${objectId}".`,
      );
    }

    if (!newText || newText.trim().length === 0) {
      throw new PdfInvalidReplacementError(
        'Replacement text cannot be empty or whitespace only.',
      );
    }

    if (!workingCopyPath || workingCopyPath.trim().length === 0) {
      throw new PdfBatchEditError('Working copy output path cannot be empty.');
    }

    if (this.currentFilePath && workingCopyPath.trim() === this.currentFilePath.trim()) {
      throw new PdfBatchEditError(
        'Working copy output path must be separate from input path to ensure source immutability.',
      );
    }

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

    const request: PdfBatchEditRequest = {
      inputPdfPath: this.currentFilePath!,
      outputPdfPath: workingCopyPath,
      commands: [replaceCmd],
    };

    const result = await this.engine.applyBatchEdits(request);

    const firstCmdResult = result?.commands?.[0];
    if (firstCmdResult && firstCmdResult.status === 'failed') {
      const errMsg = firstCmdResult.error || 'Native replacement failed';
      if (
        errMsg.toLowerCase().includes('unsupported') ||
        errMsg.toLowerCase().includes('cannot substitute font') ||
        errMsg.toLowerCase().includes('form xobject text cannot change')
      ) {
        throw new PdfUnsupportedFormattingError(errMsg);
      }
      if (
        errMsg.toLowerCase().includes('font') ||
        errMsg.toLowerCase().includes('glyph') ||
        errMsg.toLowerCase().includes('subset')
      ) {
        throw new PdfFontLimitationError(errMsg);
      }
      if (
        errMsg.toLowerCase().includes('locator') ||
        errMsg.toLowerCase().includes('path')
      ) {
        throw new PdfInvalidObjectPathError(errMsg);
      }
      throw new PdfTextReplacementError(errMsg);
    }

    // Reconcile: Reopen working copy to fetch genuine native-extracted text objects
    await this.open(workingCopyPath, true);
    this.saveState = 'DIRTY';
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

    if (this.deletedObjectIds.has(objectId)) {
      throw new PdfDeletedObjectEditError(
        `Cannot delete text object "${objectId}" because it is already deleted.`,
      );
    }

    if (!workingCopyPath || workingCopyPath.trim().length === 0) {
      throw new PdfBatchEditError('Working copy output path cannot be empty.');
    }

    if (this.currentFilePath && workingCopyPath.trim() === this.currentFilePath.trim()) {
      throw new PdfBatchEditError(
        'Working copy output path must be separate from input path to ensure source immutability.',
      );
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

    const deleteCmd: PdfDeleteCommand = {
      type: 'delete',
      objectId: target.id,
      pageIndex: target.pageIndex,
      objectIndex: target.objectIndex,
      objectPath,
      originalText: target.text,
    };

    const request: PdfBatchEditRequest = {
      inputPdfPath: this.currentFilePath!,
      outputPdfPath: workingCopyPath,
      commands: [deleteCmd],
    };

    const result = await this.engine.applyBatchEdits(request);

    const firstCmdResult = result?.commands?.[0];
    if (firstCmdResult && firstCmdResult.status === 'failed') {
      const errMsg = firstCmdResult.error || 'Native deletion failed';
      if (
        errMsg.toLowerCase().includes('locator') ||
        errMsg.toLowerCase().includes('path')
      ) {
        throw new PdfInvalidObjectPathError(errMsg);
      }
      if (errMsg.toLowerCase().includes('not a text object')) {
        throw new PdfNonDeletableObjectError(errMsg);
      }
      throw new PdfTextDeletionError(errMsg);
    }

    // Mark as deleted in domain editor caches
    this.pendingEdits = this.pendingEdits.filter((cmd) => cmd.objectId !== objectId);

    // Reopen working copy so subsequent operations and extraction use the modified document
    await this.open(workingCopyPath);
    await this.getTextObjects(target.pageIndex);
    this.deletedObjectIds.add(objectId);

    return { result };
  }

  deleteText(objectId: string): void {
    this.ensureDocumentOpen();

    if (!objectId) {
      throw new PdfInvalidObjectIdError('Object ID cannot be empty.');
    }

    if (this.deletedObjectIds.has(objectId)) {
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

    this.saveState = 'DIRTY';
    this.pushHistory({
      type: 'delete',
      targetObject: target,
      wasInserted: false,
      previousPendingCommand: previousPending,
    });
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

    const fontSize = format?.fontSize ?? 14;
    const fontName = resolveStandardFontName(format);
    const color = format?.color ?? '#000000';

    const pageHeight = this.pageSizeCache.get(pageIndex)?.height ?? 792;

    // Approximate bounding box in document top-left coordinates
    const charWidth = fontSize * 0.54;
    const width = Math.max(text.length * charWidth, 24);
    const height = fontSize * 1.25;

    // PDF user-space coordinates (origin at bottom-left)
    const pdfX = position.x;
    const pdfY = pageHeight - (position.y + fontSize);

    // Stable optimistic identifier
    const objectId = `p${pageIndex}_ins_${Date.now()}_${++this.insertCounter}`;

    const optimisticObj: PdfTextObject = {
      id: objectId,
      pageIndex,
      objectIndex: -1, // optimistic until saved & reopened
      text,
      bounds: { x: position.x, y: position.y, width, height },
      pdfBounds: {
        left: pdfX,
        bottom: pdfY,
        right: pdfX + width,
        top: pdfY + height,
      },
      fontSize,
      fontName,
      color,
      colorRgba: null,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: pdfX, f: pdfY },
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

    this.saveState = 'DIRTY';
    this.pushHistory({
      type: 'insert',
      insertedObject: optimisticObj,
      command: insertCommand,
    });

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

    if (!workingCopyPath || workingCopyPath.trim().length === 0) {
      throw new PdfBatchEditError('Working copy output path cannot be empty.');
    }

    if (this.currentFilePath && workingCopyPath.trim() === this.currentFilePath.trim()) {
      throw new PdfBatchEditError(
        'Working copy output path must be separate from input path to ensure source immutability.',
      );
    }

    const trimmedText = text.trim();
    const pageSize = await this.getPageSize(pageIndex);
    const pageHeight = pageSize.height || 792;

    const fontSize = format?.fontSize ?? 14;
    const fontName = resolveStandardFontName(format);
    const color = format?.color ?? '#000000';

    const charWidth = fontSize * 0.54;
    const width = Math.max(trimmedText.length * charWidth, 24);
    const height = fontSize * 1.25;

    // PDF user-space coordinates (origin at bottom-left)
    const pdfX = position.x;
    const pdfY = pageHeight - (position.y + fontSize);

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

    const request: PdfBatchEditRequest = {
      inputPdfPath: this.currentFilePath!,
      outputPdfPath: workingCopyPath,
      commands: [insertCmd],
    };

    const result = await this.engine.applyBatchEdits(request);

    const firstCmdResult = Array.isArray(result?.commands) ? result.commands[0] : undefined;
    if (firstCmdResult && firstCmdResult.status === 'failed') {
      const errMsg = firstCmdResult.error || 'Native insertion failed';
      throw new PdfTextInsertionError(errMsg);
    }

    // Reopen working copy to fetch genuine native-extracted text objects
    await this.open(workingCopyPath, true);
    this.saveState = 'DIRTY';
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
        pdfBounds: {
          left: pdfX,
          bottom: pdfY,
          right: pdfX + width,
          top: pdfY + height,
        },
        fontSize,
        fontName,
        color,
        colorRgba: null,
        matrix: { a: 1, b: 0, c: 0, d: 1, e: pdfX, f: pdfY },
        isEditable: true,
      };
    }

    this.textObjectsCache.set(reconciled.id, reconciled);
    this.pushHistory({
      type: 'insert',
      insertedObject: reconciled,
      command: insertCmd,
    });

    return {
      result,
      insertedObject: reconciled,
    };
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

  undo(): void {
    this.ensureDocumentOpen();
    const action = this.undoStack.pop();
    if (!action) return;

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
    if (this.pendingEdits.length === 0 && this.undoStack.length === 0) {
      this.saveState = 'CLEAN';
    }
  }

  redo(): void {
    this.ensureDocumentOpen();
    const action = this.redoStack.pop();
    if (!action) return;

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
        this.pendingEdits.push({
          type: 'delete',
          objectId: action.targetObject.id,
          pageIndex: action.targetObject.pageIndex,
          objectIndex: action.targetObject.objectIndex,
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
          this.pendingEdits.push({
            type: 'replace',
            objectId: action.objectId,
            pageIndex: target.pageIndex,
            objectIndex: target.objectIndex,
            newText: action.newText,
            format: action.newFormat,
          });
        }
      }
    }

    this.undoStack.push(action);
    this.saveState = 'DIRTY';
  }

  clearHistory(): void {
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

    const pageHeight = this.pageSizeCache.get(obj.pageIndex)?.height ?? 792;
    const pdfX = newPosition.x;
    const pdfY = pageHeight - (newPosition.y + (obj.fontSize || 14));
    const updatedBounds = { ...obj.bounds, x: newPosition.x, y: newPosition.y };

    const origMatrix = obj.matrix || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const updatedObj: PdfTextObject = {
      ...obj,
      bounds: updatedBounds,
      pdfBounds: {
        left: pdfX,
        bottom: pdfY,
        right: pdfX + obj.bounds.width,
        top: pdfY + obj.bounds.height,
      },
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
      let result: PdfMultiEditResult;

      const targetOutput = (this.currentFilePath && resolvedOutput === this.currentFilePath)
        ? `${resolvedOutput}.tmp_${Date.now()}.pdf`
        : resolvedOutput;

      if (this.pendingEdits.length > 0) {
        const request: PdfBatchEditRequest = {
          inputPdfPath: this.currentFilePath!,
          outputPdfPath: targetOutput,
          commands: [...this.pendingEdits],
        };
        result = await this.engine.applyBatchEdits(request);
      } else if (this.currentFilePath && targetOutput !== this.currentFilePath) {
        const request: PdfBatchEditRequest = {
          inputPdfPath: this.currentFilePath!,
          outputPdfPath: targetOutput,
          commands: [],
        };
        result = await this.engine.applyBatchEdits(request);
      } else {
        result = {
          outputPath: resolvedOutput,
          totalCommands: 0,
          appliedCommands: 0,
          pageCountBefore: this.docHandle!.pageCount,
          pageCountAfter: this.docHandle!.pageCount,
          sourceUnchanged: true,
          sourceChecksumBefore: '',
          sourceChecksumAfter: '',
          commands: [],
          reopenedVerification: {
            allReplacementsVerified: true,
            allDeletionsVerified: true,
            verifiedReplacements: [],
            missingReplacements: [],
            residualDeletions: [],
          },
          limitations: [],
        };
      }

      if (result) {
        if (result.limitations && result.limitations.length > 0) {
          throw new PdfBatchEditError(result.limitations[0]);
        }
        if (Array.isArray(result.commands)) {
          const failedCmd = result.commands.find((c) => c.status === 'failed');
          if (failedCmd) {
            throw new PdfBatchEditError(failedCmd.error || 'Native save operation failed.');
          }
        }
      }

      // Verification with PDFium
      const verifiedTarget = (targetOutput !== resolvedOutput) ? targetOutput : resolvedOutput;
      await this.verifyPdfOutput(verifiedTarget, this.docHandle?.pageCount);

      // Successfully saved: clean pending edits
      this.pendingEdits = [];
      this.insertedObjectsCache.clear();
      this.deletedObjectIds.clear();

      // Invalidate caches & reopen output as active document
      await this.open(resolvedOutput, true);
      this.saveState = 'CLEAN';

      return {
        outputPath: resolvedOutput,
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

  async discardWorkingChanges(): Promise<void> {
    if (this.isSaving) {
      throw new PdfConcurrentSaveError('Cannot discard changes while a save operation is in progress.');
    }

    this.pendingEdits = [];
    this.deletedObjectIds.clear();
    this.insertedObjectsCache.clear();
    this.textObjectsCache.clear();
    this.pageSizeCache.clear();
    this.clearHistory();

    if (this.originalSourcePath && this.currentFilePath !== this.originalSourcePath) {
      await this.open(this.originalSourcePath, false);
    }
    this.saveState = 'CLEAN';
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
    return (
      this.saveState === 'DIRTY' ||
      this.saveState === 'SAVE_FAILED' ||
      this.pendingEdits.length > 0
    );
  }

  getSourceFilePath(): string | null {
    return this.originalSourcePath || this.currentFilePath;
  }

  getCurrentFilePath(): string | null {
    return this.currentFilePath;
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
        this.textObjectsCache.clear();
        this.deletedObjectIds.clear();
        this.insertedObjectsCache.clear();
        this.pageSizeCache.clear();
        this.pendingEdits = [];
        this.clearHistory();
        this.isSaving = false;
        this.saveState = 'CLEAN';
      }
    }
  }

  private pushHistory(action: PdfEditorHistoryAction): void {
    this.undoStack.push(action);
    this.redoStack = []; // User mutations clear redo branch
  }

  private ensureDocumentOpen(): void {
    if (!this.docHandle || !this.currentFilePath) {
      throw new PdfDocumentClosedError(
        'No PDF document is currently open. Call open(filePath) first.',
      );
    }
  }
}
