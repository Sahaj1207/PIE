/**
 * v1.0 — PDF page tools, markup, merge, images -> PDF and search: validation, native result
 * handling, and the editor's revision model (one undoable step, source never modified).
 */
import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import {
  PdfDocumentOperation,
  createPdfFromImageFiles,
  expectedPageCount,
  mergePdfFiles,
  operationKind,
  parseSearchResponse,
  runDocumentOperations,
  searchPdf,
  validateDocumentOperations,
} from '../src/features/pdf/pdfDocumentOperations';
import { PdfDocumentOperationError, PdfMergeError, PdfPasswordRequiredError } from '../src/errors';

declare const __dirname: string;

const ROOT = '/data/files/pie';
const SOURCE = `${ROOT}/documents/pdf-1/source.pdf`;
const W = (n: number) => `${ROOT}/sessions/pdf-1/working/working_${n}.pdf`;

/** Fake native module: every file has a page count; operations derive the output's count. */
function installNative(initialPages = 3) {
  const pages = new Map<string, number>([[SOURCE, initialPages]]);
  let next = 1;
  const handles = new Map<number, string>();
  const mod = {
    openDocument: jest.fn(async (p: string) => {
      if (!pages.has(p)) throw new Error('not found');
      const h = next++;
      handles.set(h, p);
      return { docHandle: h, pageCount: pages.get(p), filePath: p, fileSizeBytes: 100 };
    }),
    closeDocument: jest.fn(async () => true),
    getPageSize: jest.fn(async (_h: number, pageIndex: number) => ({ pageIndex, width: 612, height: 792 })),
    getTextObjects: jest.fn(async () => '[]'),
    applyDocumentOperations: jest.fn(async (input: string, output: string, json: string) => {
      const { operations } = JSON.parse(json);
      const before = pages.get(input)!;
      const after = expectedPageCount(operations, before);
      pages.set(output, after);
      return JSON.stringify({
        success: true, outputPath: output, pageCountBefore: before, pageCountAfter: after,
        verified: true, sourceUnchanged: true, sourceShaBefore: 'a', sourceShaAfter: 'a', operations: [],
      });
    }),
    searchText: jest.fn(),
    mergeDocuments: jest.fn(),
    createPdfFromImages: jest.fn(),
  };
  (NativeModules as any).PdfiumNativeModule = mod;
  return { mod, pages };
}

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('operation validation', () => {
  it('rejects empty batches, bad pages and deleting the last page', () => {
    expect(() => validateDocumentOperations([], 3)).toThrow(PdfDocumentOperationError);
    expect(() => validateDocumentOperations([{ type: 'rotatePage', pageIndex: 3, quarterTurns: 1 }], 3)).toThrow();
    expect(() => validateDocumentOperations([{ type: 'deletePage', pageIndex: 0 }], 1)).toThrow(/at least one page/);
    expect(() => validateDocumentOperations([{ type: 'movePage', pageIndex: 0, toIndex: 5 }], 3)).toThrow();
    expect(() =>
      validateDocumentOperations([{ type: 'addInk', pageIndex: 0, strokes: [[]], color: '#000000', width: 2 }], 3),
    ).toThrow(/Nothing was drawn/);
  });

  it('tracks page count through a batch', () => {
    const ops: PdfDocumentOperation[] = [
      { type: 'insertBlankPage', pageIndex: 3 },
      { type: 'duplicatePage', pageIndex: 0 },
      { type: 'deletePage', pageIndex: 4 },
    ];
    expect(() => validateDocumentOperations(ops, 3)).not.toThrow();
    expect(expectedPageCount(ops, 3)).toBe(4);
  });

  it('classifies page tools vs markup', () => {
    expect(operationKind({ type: 'deletePage', pageIndex: 0 })).toBe('pages');
    expect(operationKind({ type: 'addHighlight', pageIndex: 0, style: 'highlight', rects: [], color: '#FF0' })).toBe('markup');
  });
});

describe('native results', () => {
  it('maps native failures and password errors to typed errors', async () => {
    const { mod } = installNative();
    mod.applyDocumentOperations.mockResolvedValueOnce(JSON.stringify({ success: false, errorCode: 'OPERATION_FAILED', errorMessage: 'deletePage: boom' }));
    await expect(runDocumentOperations(SOURCE, W(1), [{ type: 'rotatePage', pageIndex: 0, quarterTurns: 1 }])).rejects.toThrow('deletePage: boom');

    mod.mergeDocuments.mockResolvedValueOnce(JSON.stringify({ success: false, errorCode: 'PDF_PASSWORD_REQUIRED', errorMessage: 'locked' }));
    await expect(mergePdfFiles(['/a.pdf', '/b.pdf'], '/out.pdf')).rejects.toBeInstanceOf(PdfPasswordRequiredError);
    await expect(mergePdfFiles(['/a.pdf'], '/out.pdf')).rejects.toBeInstanceOf(PdfMergeError);
  });

  it('never accepts an unverified result', async () => {
    const { mod } = installNative();
    mod.applyDocumentOperations.mockResolvedValueOnce(JSON.stringify({ success: true, verified: false, sourceUnchanged: true }));
    await expect(runDocumentOperations(SOURCE, W(1), [{ type: 'rotatePage', pageIndex: 0, quarterTurns: 1 }])).rejects.toThrow(/verified/);
  });

  it('refuses writing over the input', async () => {
    installNative();
    await expect(runDocumentOperations(SOURCE, SOURCE, [{ type: 'rotatePage', pageIndex: 0, quarterTurns: 1 }])).rejects.toThrow();
  });

  it('creates PDFs from images and reports page count', async () => {
    const { mod } = installNative();
    mod.createPdfFromImages.mockResolvedValueOnce(JSON.stringify({ success: true, pageCount: 2 }));
    await expect(createPdfFromImageFiles(['file:///a.jpg', 'file:///b.jpg'], '/o.pdf', 'a4')).resolves.toEqual({ pageCount: 2 });
    expect(mod.createPdfFromImages).toHaveBeenCalledWith(['file:///a.jpg', 'file:///b.jpg'], '/o.pdf', 'a4', 0);
  });
});

describe('search', () => {
  it('parses results defensively', () => {
    const r = parseSearchResponse(
      JSON.stringify({
        results: [
          { pageIndex: 1, charIndex: 4, snippet: 'the  quick\nfox', matchStart: 4, matchLength: 5, rects: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 'bad' }] },
          { pageIndex: -1, rects: [] },
        ],
        truncated: true,
      }),
    );
    expect(r.truncated).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].snippet).toBe('the quick fox');
    expect(r.results[0].rects).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
    expect(parseSearchResponse('not json')).toEqual({ results: [], truncated: false });
  });

  it('does not call native for empty queries', async () => {
    const { mod } = installNative();
    await expect(searchPdf(1, '   ')).resolves.toEqual({ results: [], truncated: false });
    expect(mod.searchText).not.toHaveBeenCalled();
  });
});

describe('editor revisions for page tools and markup', () => {
  async function openEditor() {
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    return editor;
  }

  it('applies a page operation as one undoable revision; undo/redo restore page count', async () => {
    const { mod } = installNative(3);
    const editor = await openEditor();
    await editor.applyDocumentOperations([{ type: 'deletePage', pageIndex: 1 }], W(1));
    expect(editor.getPageCount()).toBe(2);
    expect(editor.getCurrentFilePath()).toBe(W(1));
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSourceFilePath()).toBe(SOURCE);
    expect(mod.applyDocumentOperations).toHaveBeenCalledWith(SOURCE, W(1), expect.any(String));

    await editor.undo();
    expect(editor.getPageCount()).toBe(3);
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.isDirty()).toBe(false);

    await editor.redo();
    expect(editor.getPageCount()).toBe(2);
  });

  it('chains markup and page tools', async () => {
    installNative(2);
    const editor = await openEditor();
    await editor.applyDocumentOperations(
      [{ type: 'addInk', pageIndex: 0, strokes: [[['M', 1, 1], ['L', 5, 5]]], color: '#000000', width: 2 }],
      W(1),
    );
    await editor.applyDocumentOperations([{ type: 'insertBlankPage', pageIndex: 2 }], W(2));
    expect(editor.getPageCount()).toBe(3);
    await editor.undo();
    await editor.undo();
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.canUndo()).toBe(false);
  });

  it('a failed operation leaves the open document and history unchanged', async () => {
    const { mod } = installNative(2);
    const editor = await openEditor();
    mod.applyDocumentOperations.mockResolvedValueOnce(JSON.stringify({ success: false, errorCode: 'X', errorMessage: 'nope' }));
    await expect(editor.applyDocumentOperations([{ type: 'rotatePage', pageIndex: 0, quarterTurns: 1 }], W(1))).rejects.toThrow('nope');
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.canUndo()).toBe(false);
    expect(editor.isDirty()).toBe(false);
  });

  it('rejects a result whose page count disagrees with the operations', async () => {
    const { mod } = installNative(2);
    const editor = await openEditor();
    mod.applyDocumentOperations.mockResolvedValueOnce(
      JSON.stringify({ success: true, verified: true, sourceUnchanged: true, pageCountBefore: 2, pageCountAfter: 2 }),
    );
    await expect(editor.applyDocumentOperations([{ type: 'deletePage', pageIndex: 0 }], W(1))).rejects.toThrow(/verified/);
    expect(editor.getPageCount()).toBe(2);
  });

  it('refuses to overwrite the source with a working copy', async () => {
    installNative(2);
    const editor = await openEditor();
    await expect(editor.applyDocumentOperations([{ type: 'rotatePage', pageIndex: 0, quarterTurns: 1 }], SOURCE)).rejects.toThrow();
  });
});

describe('native contract (static)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs: { readFileSync(f: string, e: 'utf8'): string } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path: { join(...p: string[]): string } = require('path');
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('every Kotlin external has a matching JNI export', () => {
    const kt = read('android/app/src/main/java/com/com.pdfimageeditor/pdf/NativePdfiumBridge.kt');
    const cpp = read('android/app/src/main/cpp/pdfium/pdfium_bridge.cpp');
    const externals = [...kt.matchAll(/external fun (\w+)\(/g)].map((m) => m[1]);
    expect(externals.length).toBeGreaterThan(10);
    for (const name of externals) {
      expect(cpp).toContain(`Java_com_pdfimageeditor_pdf_NativePdfiumBridge_${name}(`);
    }
  });

  it('document operations never write over the input and verify by reopening', () => {
    const ops = read('android/app/src/main/cpp/pdfium/pie_pdf_ops.h');
    expect(ops).toContain('SAME_INPUT_OUTPUT');
    expect(ops).toContain('verifyOutput(outputPath');
    expect(ops).toContain('fileChecksum(inputPath)');
    expect(ops).toContain('A PDF must keep at least one page');
    for (const op of ['rotatePage', 'deletePage', 'movePage', 'insertBlankPage', 'duplicatePage', 'addInk', 'addShape', 'addHighlight', 'addImage']) {
      expect(ops).toContain(`"${op}"`);
    }
  });
});

describe('iOS native parity (static)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs: { readFileSync(f: string, e: 'utf8'): string } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path: { join(...p: string[]): string } = require('path');
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const kt = 'android/app/src/main/java/com/com.pdfimageeditor';

  const pairs: [string, string][] = [
    [`${kt}/pdf/NativePdfiumModule.kt`, 'ios/PieNative/PdfiumNativeModule.mm'],
    [`${kt}/image/ImageProcessingModule.kt`, 'ios/PieNative/ImageProcessingModule.m'],
    [`${kt}/ocr/OcrModule.kt`, 'ios/PieNative/OcrNativeModule.m'],
    [`${kt}/storage/PieFileStoreModule.kt`, 'ios/PieNative/PieFileStoreModule.m'],
    [`${kt}/app/PieAppModule.kt`, 'ios/PieNative/PieAppModule.m'],
  ];

  it.each(pairs)('%s methods all exist on iOS', (android, ios) => {
    const methods = [...read(android).matchAll(/@ReactMethod\s+fun (\w+)\(/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    const iosSource = read(ios);
    for (const m of methods) {
      expect(iosSource).toContain(`RCT_EXPORT_METHOD(${m}`);
    }
  });

  it('iOS uses the shared C++ engine and is offline', () => {
    const mm = read('ios/PieNative/PdfiumNativeModule.mm');
    expect(mm).toContain('#include "pie_pdf_engine.h"');
    const spec = read('PieNative.podspec');
    expect(spec).toContain('android/app/src/main/cpp/pdfium/pdfium_bridge.cpp');
    for (const f of ['PdfiumNativeModule.mm', 'ImageProcessingModule.m', 'OcrNativeModule.m']) {
      expect(read(`ios/PieNative/${f}`)).not.toMatch(/https?:\/\//);
    }
  });

  it('accepts iOS file:// share copies / save destinations, never app documents', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isPlatformDocumentUri } = require('../src/features/pdf/pdfiumEngine');
    expect(isPlatformDocumentUri('content://x/1', 'share', 'android')).toBe(true);
    expect(isPlatformDocumentUri('file:///data/x.pdf', 'share', 'android')).toBe(false);
    const caches = 'file:///var/mobile/Containers/Data/Application/A/Library/Caches/pdf_exports/1/x.pdf';
    const docs = 'file:///var/mobile/Containers/Data/Application/A/Library/Application%20Support/pie/documents/d/rev.pdf';
    expect(isPlatformDocumentUri(caches, 'share', 'ios')).toBe(true);
    expect(isPlatformDocumentUri(docs, 'share', 'ios')).toBe(false);
    expect(isPlatformDocumentUri('file:///private/var/mobile/Library/Mobile%20Documents/x.pdf', 'save', 'ios')).toBe(true);
    expect(isPlatformDocumentUri(docs, 'save', 'ios')).toBe(false);
  });
});
