/**
 * Phase 15 — zoom-aware rendering and the render cache: base render scale budget, zoom
 * detail (region) selection, cache keys / LRU / revision invalidation and stale-render
 * prevention across edit, undo, redo and save.
 */
import { NativeModules } from 'react-native';
import {
  DEFAULT_PAGE_RENDER_SCALE,
  MAX_DETAIL_RENDER_PIXELS,
  MAX_PAGE_RENDER_PIXELS,
  chooseDetailRender,
  choosePageRenderScale,
  detailRenderCovers,
  requiredPixelsPerPoint,
} from '../src/features/pdf/pdfRenderScale';
import {
  PdfRenderCache,
  pageRenderKey,
  regionRenderKey,
  renderRevisionKey,
} from '../src/features/pdf/pdfRenderCache';
import { visibleDocumentRect } from '../src/features/pdf/pdfViewportMath';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';

const LETTER = { width: 612, height: 792 };

describe('Phase 15 — base render scale', () => {
  it('keeps the previous 2 px/pt for normal pages', () => {
    expect(choosePageRenderScale(612, 792)).toBe(DEFAULT_PAGE_RENDER_SCALE);
    expect(choosePageRenderScale(595.28, 841.89)).toBe(2);
  });

  it('caps very large pages by the pixel budget (no runaway bitmaps)', () => {
    const scale = choosePageRenderScale(2384, 3370); // A0
    expect(scale).toBeLessThan(2);
    expect(2384 * scale * 3370 * scale).toBeLessThanOrEqual(MAX_PAGE_RENDER_PIXELS);
    expect(choosePageRenderScale(14400, 14400)).toBeGreaterThan(0); // never 0, minimum applies
  });

  it('required density grows with zoom and screen density', () => {
    expect(requiredPixelsPerPoint(0.55, 1, 3)).toBeCloseTo(1.65, 6);
    expect(requiredPixelsPerPoint(0.55, 4, 3)).toBeCloseTo(6.6, 6);
  });
});

describe('Phase 15 — zoom detail selection', () => {
  const base = { page: LETTER, baseFitScale: 0.55, pixelRatio: 3, baseRenderScale: 2 };

  it('no detail render at fit zoom (the 2x base render is sharp enough)', () => {
    expect(chooseDetailRender({ ...base, zoom: 1, visibleRect: { x: 0, y: 0, ...LETTER } })).toBeNull();
    expect(chooseDetailRender({ ...base, zoom: 1.3, visibleRect: { x: 0, y: 0, ...LETTER } })).toBeNull();
  });

  it('renders only the visible region (plus margin) at a quantized higher scale when zoomed in', () => {
    const visible = { x: 200, y: 300, width: 160, height: 280 };
    const plan = chooseDetailRender({ ...base, zoom: 4, visibleRect: visible })!;
    // 6.6 px/pt needed -> next step 8, but the 6 MP budget for a 240x420 pt region caps it
    // at sqrt(6e6 / 100800) = 7.7 -> 7.5 (0.25 steps)
    expect(plan.scale).toBe(7.5);
    expect(plan.rect).toEqual({ x: 160, y: 230, width: 240, height: 420 });
    expect(plan.rect.width * plan.rect.height * plan.scale ** 2).toBeLessThanOrEqual(MAX_DETAIL_RENDER_PIXELS);
  });

  it('clamps the region to the page and respects the pixel budget', () => {
    const plan = chooseDetailRender({ ...base, zoom: 4, visibleRect: { x: 0, y: 0, width: 612, height: 792 } })!;
    expect(plan.rect).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    expect(612 * 792 * plan.scale ** 2).toBeLessThanOrEqual(MAX_DETAIL_RENDER_PIXELS);
    expect(plan.scale).toBeGreaterThan(2 * 1.15);
  });

  it('skips detail when the budget cannot improve on the base render', () => {
    expect(
      chooseDetailRender({ ...base, zoom: 4, maxPixels: 612 * 792 * 4, visibleRect: { x: 0, y: 0, ...LETTER } }),
    ).toBeNull();
    expect(chooseDetailRender({ ...base, zoom: 4, visibleRect: null })).toBeNull();
  });

  it('an existing detail covering the plan is reused (no re-render on small pans)', () => {
    const existing = { scale: 8, rect: { x: 100, y: 100, width: 300, height: 400 } };
    expect(detailRenderCovers(existing, { scale: 8, rect: { x: 120, y: 150, width: 200, height: 300 } })).toBe(true);
    expect(detailRenderCovers(existing, { scale: 12, rect: { x: 120, y: 150, width: 200, height: 300 } })).toBe(false);
    expect(detailRenderCovers(existing, { scale: 8, rect: { x: 50, y: 150, width: 200, height: 300 } })).toBe(false);
    expect(detailRenderCovers(null, { scale: 3, rect: { x: 0, y: 0, width: 1, height: 1 } })).toBe(false);
  });

  it('visible rect uses the viewport transform and is clamped to the page', () => {
    const t = { baseScale: 0.5, pageOriginX: 0, pageOriginY: 0, zoom: 2, translateX: -100, translateY: -200 };
    expect(visibleDocumentRect({ width: 300, height: 400 }, t, LETTER)).toEqual({ x: 100, y: 200, width: 300, height: 400 });
    expect(visibleDocumentRect({ width: 300, height: 400 }, { ...t, translateX: 5000 }, LETTER)).toBeNull();
  });
});

describe('Phase 15 — render cache', () => {
  const idA = { docHandle: 1, filePath: '/w/working_1.pdf' };
  const idB = { docHandle: 2, filePath: '/w/working_2.pdf' };
  const render = (name: string, w = 100, h = 100) => ({ filePath: `/cache/pdfium_renders/${name}.png`, width: w, height: h });

  it('keys include revision identity, page, scale, region and flags', () => {
    const keys = new Set([
      pageRenderKey(idA, 0, 2),
      pageRenderKey(idA, 1, 2),
      pageRenderKey(idA, 0, 3),
      pageRenderKey(idB, 0, 2),
      pageRenderKey({ docHandle: 1, filePath: '/w/other.pdf' }, 0, 2),
      regionRenderKey(idA, 0, 8, { x: 0, y: 0, width: 100, height: 100 }),
      regionRenderKey(idA, 0, 8, { x: 10, y: 0, width: 100, height: 100 }),
    ]);
    expect(keys.size).toBe(7);
    expect(pageRenderKey(idA, 0, 2)).toContain('|fannot');
    expect(pageRenderKey(idA, 0, 2)).toBe(pageRenderKey({ ...idA }, 0, 2.0));
  });

  it('evicts least-recently-used entries by count and pixel budget, never the newest', () => {
    const cache = new PdfRenderCache({ maxEntries: 2, maxPixels: 1_000_000 });
    const rev = renderRevisionKey(idA);
    expect(cache.set('a', rev, render('a'))).toEqual([]);
    expect(cache.set('b', rev, render('b'))).toEqual([]);
    cache.get('a'); // a becomes most recent
    expect(cache.set('c', rev, render('c'))).toEqual(['/cache/pdfium_renders/b.png']);
    expect(cache.livePaths().sort()).toEqual(['/cache/pdfium_renders/a.png', '/cache/pdfium_renders/c.png']);

    const huge = cache.set('d', rev, render('d', 2000, 2000));
    expect(huge.sort()).toEqual(['/cache/pdfium_renders/a.png', '/cache/pdfium_renders/c.png']);
    expect(cache.livePaths()).toEqual(['/cache/pdfium_renders/d.png']);
  });

  it('dropping other revisions prevents stale renders', () => {
    const cache = new PdfRenderCache();
    cache.set(pageRenderKey(idA, 0, 2), renderRevisionKey(idA), render('a0'));
    cache.set(pageRenderKey(idA, 1, 2), renderRevisionKey(idA), render('a1'));
    cache.set(pageRenderKey(idB, 0, 2), renderRevisionKey(idB), render('b0'));
    expect(cache.retainRevision(renderRevisionKey(idB)).sort()).toEqual([
      '/cache/pdfium_renders/a0.png',
      '/cache/pdfium_renders/a1.png',
    ]);
    expect(cache.get(pageRenderKey(idA, 0, 2))).toBeUndefined();
    expect(cache.get(pageRenderKey(idB, 0, 2))?.filePath).toBe('/cache/pdfium_renders/b0.png');
    expect(cache.clear()).toEqual(['/cache/pdfium_renders/b0.png']);
    expect(cache.size).toBe(0);
  });

  it('re-setting a key returns the replaced file for purging', () => {
    const cache = new PdfRenderCache();
    cache.set('k', 'r', render('old'));
    expect(cache.set('k', 'r', render('new'))).toEqual(['/cache/pdfium_renders/old.png']);
  });
});

describe('Phase 15 — render identity changes with every revision (no stale renders)', () => {
  const SOURCE = '/data/files/pie/documents/pdf-c/source.pdf';
  const W = (n: number) => `/data/files/pie/sessions/pdf-c/working/working_${n}.pdf`;

  afterEach(() => {
    delete (NativeModules as any).PdfiumNativeModule;
  });

  it('open, applied edit, undo, redo and save each yield a new render identity', async () => {
    const files = new Map<string, string[]>([[SOURCE, ['Header']]]);
    let next = 1;
    const handles = new Map<number, string>();
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (p: string) => {
        const h = next++;
        handles.set(h, p);
        return { docHandle: h, pageCount: 1, filePath: p };
      }),
      closeDocument: jest.fn(async () => true),
      getPageSize: jest.fn(async (_h: number, pageIndex: number) => ({ pageIndex, width: 612, height: 792 })),
      getTextObjects: jest.fn(async (h: number) =>
        JSON.stringify(files.get(handles.get(h)!)!.map((text, i) => ({
          id: `p0_path${i}`, pageIndex: 0, objectIndex: i, objectPath: [i], text,
          bounds: { x: 50, y: 60, width: 120, height: 16 },
          pdfBounds: { left: 50, bottom: 716, right: 170, top: 732 },
          fontSize: 12, fontName: 'Helvetica', isEditable: true,
        }))),
      ),
      applyBatchEdits: jest.fn(async (input: string, output: string, json: string) => {
        const edits = JSON.parse(json);
        const texts = [...files.get(input)!];
        edits.forEach((c: any) => { if (c.type === 'replace') texts[c.objectIndex] = c.newText; });
        files.set(output, texts);
        return JSON.stringify({
          success: true, inputPath: input, outputPath: output, commandsApplied: edits.length,
          sourceUnchanged: true, sourceShaBefore: 's', sourceShaAfter: 's', pageCountBefore: 1, pageCountAfter: 1,
          commandResults: edits.map((c: any) => ({ type: c.type, objectId: c.objectId, pageIndex: 0, objectIndex: c.objectIndex ?? 0, originalText: '', newText: c.newText ?? '', applied: true, verifiedInReopened: true, verificationError: '', fontStrategy: 'REUSED_ORIGINAL', fontReused: true, error: '' })),
        });
      }),
      moveFile: jest.fn(),
    };

    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);
    const keys: string[] = [];
    const record = () => keys.push(pageRenderKey(editor.getRenderIdentity()!, 0, 2));

    record(); // opened source
    await editor.applyExistingTextReplacement('p0_path0', 'Edited', W(1));
    record(); // edited revision
    await editor.undo();
    record(); // back to source (re-opened -> new handle)
    await editor.redo();
    record(); // edited again
    await editor.saveDocument('/data/files/pie/documents/pdf-c/rev_1.pdf');
    record(); // saved revision

    expect(new Set(keys).size).toBe(keys.length);
    // An entry rendered before undo can never be served after it
    const cache = new PdfRenderCache();
    cache.set(keys[1], keys[1].split('|')[0], { filePath: '/r/edited.png', width: 1, height: 1 });
    expect(cache.get(keys[2])).toBeUndefined();
  });

  it('engine.renderPageRegion forwards the region and maps the result', async () => {
    const native = jest.fn().mockResolvedValue({
      filePath: '/cache/pdfium_renders/region_0_1.png',
      uri: 'file:///cache/pdfium_renders/region_0_1.png',
      width: 1920,
      height: 3360,
      scale: 8,
      pageIndex: 0,
      left: 160,
      top: 230,
      regionWidth: 240,
      regionHeight: 420,
    });
    (NativeModules as any).PdfiumNativeModule = { renderPageRegion: native };
    const region = await new PdfiumEngine().renderPageRegion(3, 0, 8, { x: 160, y: 230, width: 240, height: 420 });
    expect(native).toHaveBeenCalledWith(3, 0, 8, 160, 230, 240, 420);
    expect(region.rect).toEqual({ x: 160, y: 230, width: 240, height: 420 });
    expect(region.scale).toBe(8);
    await expect(new PdfiumEngine().renderPageRegion(3, 0, 0, { x: 0, y: 0, width: 1, height: 1 })).rejects.toThrow();
  });
});
