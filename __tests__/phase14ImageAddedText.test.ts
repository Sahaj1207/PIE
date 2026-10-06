/**
 * Phase 14 — image editor completion: added-text layers (create / edit / move / delete,
 * multiple layers, undo/redo, persistence), font family preservation, multi-line layout and
 * preview/export render-plan parity. Source images stay immutable.
 */
import { NativeModules } from 'react-native';
import { AddedTextElement, Document, TextRegion } from '../src/types/document';
import {
  createAddedText,
  createAddedTextId,
  deleteAddedText,
  moveAddedText,
  normalizeAddedText,
  updateAddedText,
} from '../src/features/image/addedTextLayers';
import {
  DEFAULT_LINE_HEIGHT_RATIO,
  TextFontSpec,
  TextMeasurer,
  estimateTextWidth,
  layoutTextBlock,
  platformFontFamily,
  resolveRenderableFontFamily,
} from '../src/features/text/textLayout';
import { ADDED_TEXT_BASELINE_RATIO, buildImageRenderPlan } from '../src/features/image/imageRenderPlan';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { fingerprintImageDocument, isImageDocumentDirty } from '../src/features/image/imageDocumentState';
import { ImageExportEngine } from '../src/features/export/imageExportEngine';
import { FileSystemDocumentStorage } from '../src/storage/FileSystemDocumentStorage';
import { IFileStore } from '../src/storage/nativeFileStore';
import { ExportError } from '../src/errors';

const ROOT = '/data/app/files/pie';
const ASSET = `file://${ROOT}/documents/img-1/assets/working.jpg`;
const PREVIEW = `file://${ROOT}/documents/img-1/assets/preview.jpg`;

/** Fixed-advance measurer: every character is 10px wide at any size (easy to reason about). */
const fixedMeasure: TextMeasurer = (text) => Array.from(text).length * 10;

const OCR_REGION: TextRegion = {
  id: 'ocr-1',
  pageIndex: 0,
  bounds: { x: 100, y: 100, width: 300, height: 40 },
  originalText: 'Old',
  currentText: 'New',
  status: 'modified',
  style: { fontSize: 30, color: '#000000' },
  reconstructedPatchUri: `file://${ROOT}/documents/img-1/patches/p1.png`,
  reconstructedPatchBounds: { x: 96, y: 96, width: 308, height: 48 },
};

function createImageDoc(): Document {
  return {
    id: 'img-1',
    metadata: {
      id: 'img-1',
      title: 'Receipt',
      kind: 'image',
      sourceUri: 'content://media/external/images/media/9',
      pageCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    pages: [
      {
        id: 'page-0',
        pageIndex: 0,
        dimensions: { width: 1000, height: 800 },
        rotation: 0,
        originalContent: { pageIndex: 0, assetUri: ASSET, previewUri: PREVIEW, width: 1000, height: 800 },
        editableTextRegions: [OCR_REGION],
        addedText: [],
      },
    ],
  };
}

const layers = (doc: Document): AddedTextElement[] => doc.pages[0].addedText;
const sans = (fontSize: number): TextFontSpec => ({ fontFamily: 'sans-serif', fontSize, fontWeight: 'normal', fontStyle: 'normal' });

describe('Phase 14 — multi-line layout', () => {
  it('preserves explicit newlines, including empty lines', () => {
    const layout = layoutTextBlock('Line 1\n\nLine 3', sans(20), { measure: fixedMeasure });
    expect(layout.lines.map((l) => l.text)).toEqual(['Line 1', '', 'Line 3']);
    expect(layout.lineHeight).toBe(20 * DEFAULT_LINE_HEIGHT_RATIO);
    expect(layout.height).toBe(3 * 25);
    expect(layout.width).toBe(60);
  });

  it('normalizes CRLF and wraps deterministically at whitespace with real measurement', () => {
    const text = 'alpha beta gamma\r\ndelta';
    const a = layoutTextBlock(text, sans(10), { measure: fixedMeasure, maxWidth: 110 });
    const b = layoutTextBlock(text, sans(10), { measure: fixedMeasure, maxWidth: 110 });
    expect(a).toEqual(b);
    expect(a.lines.map((l) => l.text)).toEqual(['alpha beta', 'gamma', 'delta']);
    expect(a.lines.every((l) => l.width <= 110)).toBe(true);
  });

  it('breaks words wider than the wrap width by character', () => {
    const layout = layoutTextBlock('abcdefghij', sans(10), { measure: fixedMeasure, maxWidth: 40 });
    expect(layout.lines.map((l) => l.text)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('uses an explicit line height when the style provides one', () => {
    expect(layoutTextBlock('a\nb', sans(10), { measure: fixedMeasure, lineHeight: 40 }).height).toBe(80);
  });

  it('the deterministic fallback measures monospace exactly and wide glyphs as 1em', () => {
    expect(estimateTextWidth('abcd', { ...sans(10), fontFamily: 'monospace' })).toBeCloseTo(24, 6);
    expect(estimateTextWidth('東京', sans(10))).toBeCloseTo(20, 6);
    expect(estimateTextWidth('ab', { ...sans(10), fontWeight: 'bold' })).toBeGreaterThan(estimateTextWidth('ab', sans(10)));
  });
});

describe('Phase 14 — font family preservation and safe fallback', () => {
  it('maps requested families to renderable ones deterministically', () => {
    expect(resolveRenderableFontFamily('serif')).toBe('serif');
    expect(resolveRenderableFontFamily('monospace')).toBe('monospace');
    expect(resolveRenderableFontFamily('Times New Roman')).toBe('serif');
    expect(resolveRenderableFontFamily('Courier New')).toBe('monospace');
    expect(resolveRenderableFontFamily('Helvetica')).toBe('sans-serif');
    expect(resolveRenderableFontFamily('Totally Unknown Font')).toBe('sans-serif');
    expect(resolveRenderableFontFamily(undefined)).toBe('sans-serif');
  });

  it('uses platform font names that the renderer can provide', () => {
    expect(platformFontFamily('serif', 'android')).toBe('serif');
    expect(platformFontFamily('serif', 'ios')).toBe('Times New Roman');
    expect(platformFontFamily('monospace', 'ios')).toBe('Courier');
    expect(platformFontFamily('sans-serif', 'ios')).toBe('Helvetica');
  });
});

describe('Phase 14 — added-text layers', () => {
  it('creates a measured, multi-line layer and keeps its font family', () => {
    const doc = createImageDoc();
    const { document, element } = createAddedText(
      doc,
      { text: '  Total due\nThank you  ', origin: { x: 50.4, y: 60.6 }, style: { fontFamily: 'serif', fontSize: 20, color: '#DC2626', alignment: 'center' } },
      fixedMeasure,
    );
    expect(element.text).toBe('Total due\nThank you');
    expect(element.style.fontFamily).toBe('serif');
    expect(element.style.alignment).toBe('center');
    expect(element.style.color).toBe('#DC2626');
    expect(element.bounds).toEqual({ x: 50, y: 61, width: 90, height: 50 });
    expect(element.wrapWidth).toBe(1000 - 50 - 8);
    expect(layers(document)).toHaveLength(1);
    // The input document is never mutated
    expect(layers(doc)).toHaveLength(0);
  });

  it('rejects empty text and normalizes CRLF', () => {
    expect(() => createAddedText(createImageDoc(), { text: ' \n ', origin: { x: 1, y: 1 }, style: {} }, fixedMeasure)).toThrow(
      'cannot be empty',
    );
    expect(normalizeAddedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('keeps a new layer inside the image', () => {
    const { element } = createAddedText(
      createImageDoc(),
      { text: 'Edge', origin: { x: 995, y: 795 }, style: { fontSize: 20 } },
      fixedMeasure,
    );
    expect(element.bounds.x + element.bounds.width).toBeLessThanOrEqual(1000);
    expect(element.bounds.y + element.bounds.height).toBeLessThanOrEqual(800);
  });

  it('edits text, family, size, color and alignment while preserving position', () => {
    const created = createAddedText(createImageDoc(), { text: 'Hello', origin: { x: 200, y: 300 }, style: { fontSize: 16 } }, fixedMeasure);
    const { document, element } = updateAddedText(
      created.document,
      created.element.id,
      { text: 'Hello\nWorld!', style: { fontFamily: 'monospace', fontSize: 32, color: '#007AFF', alignment: 'right', fontWeight: 'bold' } },
      fixedMeasure,
    );
    expect(element.id).toBe(created.element.id);
    expect(element.bounds.x).toBe(200);
    expect(element.bounds.y).toBe(300);
    expect(element.bounds.width).toBe(60);
    expect(element.bounds.height).toBe(80);
    expect(element.wrapWidth).toBe(created.element.wrapWidth);
    expect(element.style).toMatchObject({ fontFamily: 'monospace', fontSize: 32, color: '#007AFF', alignment: 'right', fontWeight: 'bold' });
    expect(layers(document)).toHaveLength(1);
  });

  it('a partial style edit keeps the remaining formatting', () => {
    const created = createAddedText(
      createImageDoc(),
      { text: 'Keep', origin: { x: 10, y: 10 }, style: { fontFamily: 'serif', fontSize: 24, color: '#34C759', fontStyle: 'italic' } },
      fixedMeasure,
    );
    const { element } = updateAddedText(created.document, created.element.id, { style: { fontSize: 30 } }, fixedMeasure);
    expect(element.style).toMatchObject({ fontFamily: 'serif', fontSize: 30, color: '#34C759', fontStyle: 'italic' });
    expect(element.text).toBe('Keep');
  });

  it('moves a layer in document coordinates, clamped inside the page', () => {
    const created = createAddedText(createImageDoc(), { text: 'Move me', origin: { x: 100, y: 100 }, style: { fontSize: 20 } }, fixedMeasure);
    const moved = moveAddedText(created.document, created.element.id, { x: 400.4, y: 250.6 });
    expect(moved.element.bounds).toEqual({ ...created.element.bounds, x: 400, y: 251 });

    const clamped = moveAddedText(created.document, created.element.id, { x: -50, y: 5000 });
    expect(clamped.element.bounds.x).toBe(0);
    expect(clamped.element.bounds.y).toBe(800 - created.element.bounds.height);
    expect(clamped.element.bounds.width).toBe(created.element.bounds.width);
  });

  it('multiple layers have stable distinct ids and never affect each other', () => {
    let doc = createImageDoc();
    const a = createAddedText(doc, { text: 'A', origin: { x: 10, y: 10 }, style: { color: '#000000' } }, fixedMeasure);
    doc = a.document;
    const b = createAddedText(doc, { text: 'B', origin: { x: 20, y: 20 }, style: { color: '#FF0000' } }, fixedMeasure);
    doc = b.document;
    const c = createAddedText(doc, { text: 'C', origin: { x: 30, y: 30 }, style: { color: '#00FF00' } }, fixedMeasure);
    doc = c.document;
    expect(new Set(layers(doc).map((l) => l.id)).size).toBe(3);

    const before = layers(doc);
    doc = updateAddedText(doc, b.element.id, { text: 'B edited', style: { fontSize: 40 } }, fixedMeasure).document;
    doc = moveAddedText(doc, c.element.id, { x: 500, y: 500 }).document;
    const after = layers(doc);
    expect(after[0]).toEqual(before[0]);
    expect(after[1].text).toBe('B edited');
    expect(after[1].bounds.x).toBe(20);
    expect(after[2].bounds).toMatchObject({ x: 500, y: 500 });
    expect(after[2].text).toBe('C');

    doc = deleteAddedText(doc, b.element.id);
    expect(layers(doc).map((l) => l.text)).toEqual(['A', 'C']);
    // OCR regions are untouched by added-text operations
    expect(doc.pages[0].editableTextRegions).toEqual([OCR_REGION]);
  });

  it('ids stay unique even when created in the same millisecond', () => {
    const existing = [{ id: 'added-x' } as AddedTextElement];
    const ids = new Set(Array.from({ length: 50 }, () => createAddedTextId(existing, 1700000000000)));
    expect(ids.size).toBe(50);
  });

  it('operations on a missing layer fail loudly instead of silently changing another', () => {
    const doc = createImageDoc();
    expect(() => updateAddedText(doc, 'nope', { text: 'x' }, fixedMeasure)).toThrow('no longer exists');
    expect(() => moveAddedText(doc, 'nope', { x: 1, y: 1 })).toThrow('no longer exists');
  });
});

describe('Phase 14 — undo / redo and dirty state', () => {
  it('create, edit, move and delete are each one undoable step on the right layer', () => {
    const history = new DocumentHistoryManager();
    let doc = createImageDoc();
    history.initialize(doc);
    const saved = fingerprintImageDocument(doc);

    const created = createAddedText(doc, { text: 'Note', origin: { x: 10, y: 10 }, style: {} }, fixedMeasure);
    doc = created.document;
    history.push(doc);
    const id = created.element.id;
    doc = updateAddedText(doc, id, { text: 'Note 2' }, fixedMeasure).document;
    history.push(doc);
    doc = moveAddedText(doc, id, { x: 300, y: 200 }).document;
    history.push(doc);
    doc = deleteAddedText(doc, id);
    history.push(doc);
    expect(isImageDocumentDirty(doc, saved)).toBe(false);

    let state = history.undo()!; // undo delete
    expect(layers(state)[0]).toMatchObject({ id, text: 'Note 2', bounds: { x: 300, y: 200 } });
    state = history.undo()!; // undo move
    expect(layers(state)[0].bounds).toMatchObject({ x: 10, y: 10 });
    state = history.undo()!; // undo edit
    expect(layers(state)[0].text).toBe('Note');
    state = history.undo()!; // undo create
    expect(layers(state)).toHaveLength(0);
    expect(isImageDocumentDirty(state, saved)).toBe(false);

    state = history.redo()!;
    state = history.redo()!;
    expect(layers(state)[0]).toMatchObject({ id, text: 'Note 2' });
  });

  it('a move changes the fingerprint (dirty); moving back restores it', () => {
    const created = createAddedText(createImageDoc(), { text: 'X', origin: { x: 10, y: 10 }, style: {} }, fixedMeasure);
    const saved = fingerprintImageDocument(created.document);
    const moved = moveAddedText(created.document, created.element.id, { x: 50, y: 50 }).document;
    expect(isImageDocumentDirty(moved, saved)).toBe(true);
    const back = moveAddedText(moved, created.element.id, { x: 10, y: 10 }).document;
    expect(isImageDocumentDirty(back, saved)).toBe(false);
  });
});

describe('Phase 14 — persistence and reopen', () => {
  function fakeStore(): IFileStore & { files: Map<string, string> } {
    const files = new Map<string, string>();
    const norm = (p: string) => (p.startsWith('file://') ? p.substring(7) : p);
    return {
      files,
      getRootPath: jest.fn(async () => ROOT),
      writeFileAtomic: jest.fn(async (p: string, c: string) => void files.set(norm(p), c)),
      readFile: jest.fn(async (p: string) => {
        if (!files.has(norm(p))) throw new Error('not found');
        return files.get(norm(p))!;
      }),
      exists: jest.fn(async (p: string) => files.has(norm(p))),
      copyFile: jest.fn(async (f: string, t: string) => void files.set(norm(t), files.get(norm(f))!)),
      deletePath: jest.fn(async () => undefined),
      listDirectory: jest.fn(async () => []),
      makeDirectory: jest.fn(async () => undefined),
    };
  }

  it('saves and reopens every added-text layer with font family, alignment, wrap width and newlines', async () => {
    const store = fakeStore();
    store.files.set(`${ROOT}/documents/img-1/assets/working.jpg`, 'jpeg-bytes');
    store.files.set(`${ROOT}/documents/img-1/assets/preview.jpg`, 'jpeg-preview');
    store.files.set(`${ROOT}/documents/img-1/patches/p1.png`, 'png');
    const storage = new FileSystemDocumentStorage(store);

    let doc = createImageDoc();
    doc = createAddedText(doc, { text: 'First\nSecond', origin: { x: 40, y: 40 }, style: { fontFamily: 'serif', alignment: 'center', fontSize: 22 } }, fixedMeasure).document;
    doc = createAddedText(doc, { text: 'Mono', origin: { x: 400, y: 500 }, style: { fontFamily: 'monospace', color: '#FF3B30' } }, fixedMeasure).document;
    await storage.saveDocument(doc);

    const reopened = await storage.getDocument('img-1');
    expect(layers(reopened!)).toEqual(layers(doc));
    expect(layers(reopened!)[0].style.fontFamily).toBe('serif');
    expect(layers(reopened!)[0].text).toBe('First\nSecond');
    expect(layers(reopened!)[0].wrapWidth).toBe(layers(doc)[0].wrapWidth);
    expect(fingerprintImageDocument(reopened!)).toBe(fingerprintImageDocument(doc));
    // Reopened plan draws the same layers
    expect(buildImageRenderPlan(reopened!.pages[0], { measureText: fixedMeasure })).toEqual(
      buildImageRenderPlan(doc.pages[0], { measureText: fixedMeasure }),
    );
  });

  it('a failed save leaves the in-memory document and its dirty state untouched', async () => {
    const store = fakeStore();
    (store.writeFileAtomic as jest.Mock).mockRejectedValue(new Error('disk full'));
    const storage = new FileSystemDocumentStorage(store);
    const base = createImageDoc();
    const saved = fingerprintImageDocument(base);
    const edited = createAddedText(base, { text: 'Unsaved', origin: { x: 5, y: 5 }, style: {} }, fixedMeasure).document;
    const snapshot = JSON.stringify(edited);

    await expect(storage.saveDocument(edited)).rejects.toThrow('disk full');
    expect(JSON.stringify(edited)).toBe(snapshot);
    expect(isImageDocumentDirty(edited, saved)).toBe(true);
  });
});

describe('Phase 14 — render plan: preview / export parity', () => {
  afterEach(() => {
    delete (NativeModules as any).ImageProcessingModule;
  });

  function docWithLayers(): Document {
    let doc = createImageDoc();
    doc = createAddedText(doc, { text: 'Left one\nsecond line', origin: { x: 100, y: 200 }, style: { fontSize: 20 } }, fixedMeasure).document;
    doc = createAddedText(doc, { text: 'Wide line\nab', origin: { x: 300, y: 400 }, style: { fontSize: 20, alignment: 'center', fontFamily: 'Times New Roman' } }, fixedMeasure).document;
    doc = createAddedText(doc, { text: 'xx\nxxxx', origin: { x: 600, y: 100 }, style: { fontSize: 10, alignment: 'right' } }, fixedMeasure).document;
    return doc;
  }

  it('lays out lines with baselines, alignment and a renderable font in document coordinates', () => {
    const plan = buildImageRenderPlan(docWithLayers().pages[0], { measureText: fixedMeasure });
    const [replacement, left, center, right] = plan.textElements;

    expect(replacement.kind).toBe('replacement');
    expect(replacement.lines).toHaveLength(1);
    expect(replacement.lines[0].text).toBe('New');

    expect(left.lines.map((l) => [l.text, l.x, l.baselineY])).toEqual([
      ['Left one', 100, 200 + 20 * ADDED_TEXT_BASELINE_RATIO],
      ['second line', 100, 200 + 20 * ADDED_TEXT_BASELINE_RATIO + 25],
    ]);
    expect(left.drawX).toBe(left.lines[0].x);
    expect(left.baselineY).toBe(left.lines[0].baselineY);

    // Center: 'Wide line' = 90px, 'ab' = 20px -> 'ab' offset (90-20)/2
    expect(center.lines.map((l) => l.x)).toEqual([300, 335]);
    expect(center.fontFamily).toBe('serif');
    // Right: 'xx' = 20px, 'xxxx' = 40px -> 'xx' offset 20
    expect(right.lines.map((l) => l.x)).toEqual([620, 600]);
  });

  it('export sends exactly the planned lines (same measurer -> identical to the canvas plan)', async () => {
    const mockExport = jest.fn().mockResolvedValue({
      destinationUri: 'file:///cache/exports/export_1.png',
      format: 'png',
      fileSizeBytes: 1,
      savedToGallery: false,
    });
    (NativeModules as any).ImageProcessingModule = { exportImagePage: mockExport };
    const doc = docWithLayers();

    await new ImageExportEngine(fixedMeasure).exportDocument(doc, { format: 'png' });
    const params = mockExport.mock.calls[0][0];
    const canvasPlan = buildImageRenderPlan(doc.pages[0], { measureText: fixedMeasure });

    expect(params.textElements.map((t: any) => t.lines)).toEqual(
      canvasPlan.textElements.map((t) => t.lines.map((l) => ({ text: l.text, x: l.x, baselineY: l.baselineY }))),
    );
    expect(params.textElements.map((t: any) => t.fontFamily)).toEqual(canvasPlan.textElements.map((t) => t.fontFamily));
    // Full-resolution source, document coordinates only, no viewport data
    expect(params.sourceImageUri).toBe(ASSET);
    expect(JSON.stringify(params)).not.toMatch(/translate|scale/);
  });

  it('a failed export does not modify the document and allows a retry', async () => {
    const mockExport = jest.fn().mockRejectedValueOnce(new Error('EXPORT_OUT_OF_MEMORY')).mockResolvedValue({
      destinationUri: 'file:///cache/exports/export_2.png',
      format: 'png',
      fileSizeBytes: 1,
      savedToGallery: false,
    });
    (NativeModules as any).ImageProcessingModule = { exportImagePage: mockExport };
    const doc = docWithLayers();
    const snapshot = JSON.stringify(doc);
    const engine = new ImageExportEngine(fixedMeasure);

    await expect(engine.exportDocument(doc, { format: 'png' })).rejects.toBeInstanceOf(ExportError);
    expect(JSON.stringify(doc)).toBe(snapshot);
    await expect(engine.exportDocument(doc, { format: 'png' })).resolves.toMatchObject({ format: 'png' });
  });

  it('added text is a layer: the source image reference never changes', () => {
    let doc = createImageDoc();
    const original = JSON.stringify(doc.pages[0].originalContent);
    const created = createAddedText(doc, { text: 'Layer', origin: { x: 10, y: 10 }, style: {} }, fixedMeasure);
    doc = moveAddedText(updateAddedText(created.document, created.element.id, { text: 'L2' }, fixedMeasure).document, created.element.id, { x: 99, y: 99 }).document;
    doc = deleteAddedText(doc, created.element.id);
    expect(JSON.stringify(doc.pages[0].originalContent)).toBe(original);
    expect(doc.pages[0].originalContent.assetUri).toBe(ASSET);
  });
});
