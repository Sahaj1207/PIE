/**
 * v1.0 — markup geometry (shared by PDF and image), image drawings / transforms on the
 * canonical Document + history, library operations and app settings.
 */
import { NativeModules } from 'react-native';
import {
  commandsBounds,
  commandsToSvg,
  fitStrokesInto,
  normalizeRect,
  shapeCommands,
  simplifyPoints,
  smoothStroke,
} from '../src/features/markup/inkPath';
import { HIGHLIGHTER_OPACITY, drawingFromGesture } from '../src/features/markup/markupModel';
import { createSignature } from '../src/features/markup/signatureStore';
import {
  addImageDrawings,
  applyTransformedImage,
  collectImageText,
  fitAspectRect,
  normalizeCropRect,
  pageHasEdits,
  signatureDrawing,
  toImageDrawings,
} from '../src/features/image/imageMarkup';
import { buildImageRenderPlan } from '../src/features/image/imageRenderPlan';
import { ImageExportEngine } from '../src/features/export/imageExportEngine';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { fingerprintImageDocument, isImageDocumentDirty } from '../src/features/image/imageDocumentState';
import { Document, TextRegion } from '../src/types/document';
import { InMemoryDocumentStorage } from '../src/storage/InMemoryDocumentStorage';
import { createDocumentActivityRegistry } from '../src/features/documents/documentActivity';
import {
  copyTitle,
  deleteLibraryDocument,
  duplicateDocument,
  filterAndSortDocuments,
  formatBytes,
  formatRelativeDate,
  normalizeTitle,
  renameDocument,
  validateDocumentTitle,
} from '../src/features/library/libraryService';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../src/settings/appSettings';
import { resolveDarkMode } from '../src/ui/ThemeProvider';
import { estimateTextWidth } from '../src/features/text/textLayout';

function imageDoc(overrides: Partial<Document['pages'][0]> = {}): Document {
  return {
    id: 'img-1',
    metadata: { id: 'img-1', title: 'Photo', kind: 'image', sourceUri: 'file:///src.jpg', pageCount: 1, createdAt: 1, updatedAt: 1 },
    pages: [
      {
        id: 'p0',
        pageIndex: 0,
        dimensions: { width: 1000, height: 800 },
        rotation: 0,
        originalContent: { pageIndex: 0, assetUri: 'file:///w/working.jpg', width: 1000, height: 800 },
        editableTextRegions: [],
        addedText: [],
        ...overrides,
      },
    ],
  };
}

const region = (id: string, text: string, x: number, y: number, status: TextRegion['status'] = 'detected'): TextRegion => ({
  id,
  pageIndex: 0,
  bounds: { x, y, width: 100, height: 20 },
  originalText: text,
  currentText: status === 'modified' ? `${text}!` : text,
  status,
  style: { fontSize: 16, color: '#000000' },
});

describe('ink geometry', () => {
  it('simplifies jitter and keeps the final point', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }];
    const out = simplifyPoints(pts, 1);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 5.2, y: 0 });
    expect(out).toHaveLength(3);
  });

  it('smooths a stroke into M / Q / L commands and serialises to SVG', () => {
    const cmds = smoothStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 10 }], 0.1);
    expect(cmds[0]).toEqual(['M', 0, 0]);
    expect(cmds.filter((c) => c[0] === 'Q')).toHaveLength(2);
    expect(cmds[cmds.length - 1]).toEqual(['L', 30, 10]);
    expect(commandsToSvg(cmds)).toMatch(/^M0 0 Q10 0 15 5/);
  });

  it('a tap becomes a dot, not an empty path', () => {
    expect(smoothStroke([{ x: 3, y: 4 }])).toHaveLength(2);
    expect(smoothStroke([])).toEqual([]);
  });

  it('fits strokes into a target box keeping proportions', () => {
    const fitted = fitStrokesInto([[['M', 0, 0], ['L', 100, 50]]], { x: 10, y: 10, width: 50, height: 50 });
    const b = commandsBounds(fitted)!;
    expect(b.width).toBeCloseTo(50, 5);
    expect(b.height).toBeCloseTo(25, 5);
    expect(b.y).toBeCloseTo(22.5, 5); // centred vertically
  });

  it('normalises drag rectangles and builds shapes', () => {
    expect(normalizeRect({ x: 10, y: 10, width: -5, height: -5 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(shapeCommands('rect', { x: 0, y: 0, width: 10, height: 5 }, 1)).toHaveLength(5);
    expect(shapeCommands('ellipse', { x: 0, y: 0, width: 10, height: 5 }, 1).filter((c) => c[0] === 'C')).toHaveLength(4);
    expect(shapeCommands('arrow', { x: 0, y: 0, width: 10, height: 0 }, 1).length).toBeGreaterThan(2);
  });

  it('turns gestures into drawings per tool', () => {
    const pts = [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 40, y: 10 }];
    const hl = drawingFromGesture('highlighter', pts, { color: '#FFE066', width: 2 }, 3)!;
    expect(hl.kind).toBe('highlighter');
    expect(hl.opacity).toBe(HIGHLIGHTER_OPACITY);
    expect(hl.width).toBeGreaterThan(2);
    const rect = drawingFromGesture('rect', pts, { color: '#000000', width: 2 }, 3)!;
    expect(rect.kind).toBe('shape');
    expect(rect.rect).toEqual({ x: 0, y: 0, width: 40, height: 10 });
    expect(drawingFromGesture('rect', [{ x: 0, y: 0 }, { x: 1, y: 1 }], { color: '#000000', width: 2 }, 3)).toBeNull();
    expect(drawingFromGesture('eraser', pts, { color: '#000000', width: 2 }, 3)).toBeNull();
  });
});

describe('signatures', () => {
  it('normalises to the stroke bounds with padding and rejects scribble dots', () => {
    const sig = createSignature([[['M', 100, 100], ['L', 300, 160]]], 3, 1000)!;
    expect(sig.width).toBeCloseTo(208, 5);
    expect(sig.height).toBeCloseTo(68, 5);
    expect(commandsBounds(sig.strokes)!.x).toBeCloseTo(4, 5);
    expect(createSignature([[['M', 1, 1], ['L', 2, 2]]], 3)).toBeNull();
  });

  it('is placed as a drawing inside the requested rect', () => {
    const sig = createSignature([[['M', 0, 0], ['L', 200, 100]]], 3)!;
    const d = signatureDrawing(sig, { x: 100, y: 100, width: 200, height: 100 });
    const b = commandsBounds([d.commands as any])!;
    expect(b.x).toBeGreaterThanOrEqual(100);
    expect(b.x + b.width).toBeLessThanOrEqual(300.01);
    expect(d.kind).toBe('signature');
  });
});

describe('image drawings on the canonical document', () => {
  it('adds drawings as one history step; undo/redo and dirty state follow', () => {
    const base = imageDoc();
    const history = new DocumentHistoryManager();
    history.initialize(base);
    const saved = fingerprintImageDocument(base);
    const ink = drawingFromGesture('pen', [{ x: 1, y: 1 }, { x: 50, y: 50 }, { x: 90, y: 20 }], { color: '#FF0000', width: 4 }, 3)!;
    const next = addImageDrawings(base, toImageDrawings([ink]));
    history.push(next);
    expect(next.pages[0].drawings).toHaveLength(1);
    expect(base.pages[0].drawings).toBeUndefined(); // immutable
    expect(isImageDocumentDirty(next, saved)).toBe(true);
    const undone = history.undo()!;
    expect(isImageDocumentDirty(undone, saved)).toBe(false);
    expect(history.redo()!.pages[0].drawings).toHaveLength(1);
  });

  it('render plan and exporter receive the same drawings', async () => {
    const ink = drawingFromGesture('highlighter', [{ x: 1, y: 1 }, { x: 50, y: 50 }, { x: 90, y: 20 }], { color: '#FFE066', width: 4 }, 3)!;
    const doc = addImageDrawings(imageDoc(), toImageDrawings([ink]));
    const plan = buildImageRenderPlan(doc.pages[0], { measureText: estimateTextWidth });
    expect(plan.drawings).toHaveLength(1);
    expect(plan.drawings[0].multiply).toBe(true);

    const exportImagePage = jest.fn().mockResolvedValue({ destinationUri: 'file:///out.png', format: 'png', fileSizeBytes: 1 });
    (NativeModules as any).ImageProcessingModule = { exportImagePage };
    await new ImageExportEngine(estimateTextWidth).exportDocument(doc, { format: 'png' });
    const params = exportImagePage.mock.calls[0][0];
    expect(params.drawings).toEqual([
      { commands: plan.drawings[0].commands, color: '#FFE066', width: plan.drawings[0].width, opacity: plan.drawings[0].opacity, multiply: true },
    ]);
    delete (NativeModules as any).ImageProcessingModule;
  });

  it('a transform replaces the working image and clears layers that no longer fit', () => {
    const doc = addImageDrawings(
      imageDoc({ editableTextRegions: [region('a', 'Hi', 0, 0, 'modified')] }),
      toImageDrawings([drawingFromGesture('pen', [{ x: 1, y: 1 }, { x: 9, y: 9 }, { x: 20, y: 2 }], { color: '#000000', width: 1 }, 1)!]),
    );
    expect(pageHasEdits(doc.pages[0])).toBe(true);
    const out = applyTransformedImage(doc, { assetUri: 'file:///s/asset_1.png', width: 800, height: 1000 });
    expect(out.pages[0].dimensions).toEqual({ width: 800, height: 1000 });
    expect(out.pages[0].originalContent.assetUri).toBe('file:///s/asset_1.png');
    expect(out.pages[0].editableTextRegions).toEqual([]);
    expect(out.pages[0].drawings).toEqual([]);
    expect(pageHasEdits(out.pages[0])).toBe(false);
    // Source document untouched (undo returns to it)
    expect(doc.pages[0].originalContent.assetUri).toBe('file:///w/working.jpg');
  });

  it('crop helpers keep aspect and clamp to the image', () => {
    expect(fitAspectRect({ x: 0, y: 0, width: 400, height: 200 }, 1)).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    expect(normalizeCropRect({ x: -5, y: 790, width: 2000, height: 50 }, 1000, 800)).toEqual({ x: 0, y: 790, width: 1000, height: 10 });
  });

  it('collects visible text in reading order (Live Text copy)', () => {
    const page = imageDoc({
      editableTextRegions: [region('b', 'World', 200, 10), region('a', 'Hello', 10, 12), region('c', 'Next line', 10, 80), region('d', 'gone', 10, 120, 'deleted')],
    }).pages[0];
    expect(collectImageText(page)).toBe('Hello\nWorld\nNext line');
  });
});

describe('library', () => {
  const deps = () => {
    const storage = new InMemoryDocumentStorage();
    return { storage, activity: createDocumentActivityRegistry(), fileStore: null };
  };

  it('validates and normalises names', () => {
    expect(validateDocumentTitle('  ')).toMatch(/Enter/);
    expect(validateDocumentTitle('a/b')).toMatch(/cannot contain/);
    expect(validateDocumentTitle('x'.repeat(121))).toMatch(/at most/);
    expect(validateDocumentTitle('Quarterly report')).toBeNull();
    expect(normalizeTitle(' Report  2026 ', 'pdf')).toBe('Report 2026.pdf');
    expect(normalizeTitle('Holiday', 'image')).toBe('Holiday');
    expect(copyTitle('Report.pdf', ['Report.pdf', 'Report copy.pdf'])).toBe('Report copy 2.pdf');
  });

  it('renames, duplicates and deletes image documents; refuses while open', async () => {
    const d = deps();
    await d.storage.saveDocument(imageDoc({ drawings: [] }));
    const renamed = await renameDocument('img-1', 'Beach', d);
    expect(renamed.metadata.title).toBe('Beach');
    const copy = await duplicateDocument('img-1', d);
    expect(copy.id).not.toBe('img-1');
    expect(copy.metadata.title).toBe('Beach copy');
    expect((await d.storage.listDocuments()).length).toBe(2);

    const release = d.activity.markActive('img-1', 'open');
    await expect(renameDocument('img-1', 'X', d)).rejects.toThrow(/open or busy/);
    await expect(
      deleteLibraryDocument({ id: 'img-1', metadata: renamed.metadata }, d),
    ).rejects.toThrow(/open or busy/);
    release();
    await deleteLibraryDocument({ id: 'img-1', metadata: renamed.metadata }, d);
    expect((await d.storage.listDocuments()).map((x) => x.id)).toEqual([copy.id]);
  });

  it('filters, searches and sorts', () => {
    const mk = (id: string, title: string, kind: 'pdf' | 'image', created: number, updated: number) => ({
      id,
      metadata: { id, title, kind, sourceUri: '', pageCount: 1, createdAt: created, updatedAt: updated },
    });
    const docs = [mk('1', 'b report', 'pdf', 1, 30), mk('2', 'A photo', 'image', 3, 10), mk('3', 'c report', 'pdf', 2, 20)];
    expect(filterAndSortDocuments(docs, '', 'all', 'recent').map((d) => d.id)).toEqual(['1', '3', '2']);
    expect(filterAndSortDocuments(docs, '', 'all', 'name').map((d) => d.id)).toEqual(['2', '1', '3']);
    expect(filterAndSortDocuments(docs, '', 'all', 'created').map((d) => d.id)).toEqual(['2', '3', '1']);
    expect(filterAndSortDocuments(docs, 'REPORT', 'pdf', 'recent').map((d) => d.id)).toEqual(['1', '3']);
    expect(filterAndSortDocuments(docs, '', 'image', 'recent').map((d) => d.id)).toEqual(['2']);
  });

  it('formats sizes and dates', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
    const now = new Date(2026, 9, 6, 15, 0).getTime();
    expect(formatRelativeDate(new Date(2026, 9, 6, 9, 5).getTime(), now)).toBe('Today 09:05');
    expect(formatRelativeDate(new Date(2026, 9, 5, 9, 5).getTime(), now)).toBe('Yesterday');
    expect(formatRelativeDate(new Date(2026, 0, 2).getTime(), now)).toBe('2 Jan 2026');
  });
});

describe('settings and appearance', () => {
  it('sanitises untrusted settings', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ appearance: 'neon', defaultImageExportQuality: 7, markupColor: 'red', haptics: false });
    expect(s.appearance).toBe('system');
    expect(s.defaultImageExportQuality).toBe(1);
    expect(s.markupColor).toBe(DEFAULT_SETTINGS.markupColor);
    expect(s.haptics).toBe(false);
  });

  it('persists through the file store and notifies subscribers', async () => {
    const files = new Map<string, string>();
    const store = {
      getRootPath: async () => '/root',
      exists: async (p: string) => files.has(p),
      readFile: async (p: string) => files.get(p)!,
      writeFileAtomic: async (p: string, c: string) => {
        files.set(p, c);
      },
    } as any;
    const settings = new SettingsStore(() => store);
    await settings.load();
    const listener = jest.fn();
    settings.subscribe(listener);
    settings.update({ appearance: 'dark', libraryLayout: 'list' });
    await settings.flush();
    expect(listener).toHaveBeenCalled();
    expect(JSON.parse(files.get('/root/settings.json')!).appearance).toBe('dark');

    const reloaded = new SettingsStore(() => store);
    expect((await reloaded.load()).libraryLayout).toBe('list');
  });

  it('resolves the effective colour scheme', () => {
    expect(resolveDarkMode('system', 'dark')).toBe(true);
    expect(resolveDarkMode('system', 'light')).toBe(false);
    expect(resolveDarkMode('light', 'dark')).toBe(false);
    expect(resolveDarkMode('dark', null)).toBe(true);
  });
});
