/**
 * Phase 11 — PDF save/persistence, delete lifecycle and undo/redo hardening.
 *
 * Drives the real PdfiumEngine + PdfDocumentEditor against a native simulator that
 * mirrors pdfium_bridge.cpp behaviour relevant to correctness:
 * - positional object IDs (`p<page>_path<i>` / `p<page>_path<i>_<j>` for Form XObjects),
 *   which shift after a deletion;
 * - object resolution before mutation, replacements/deletions/insertions per batch;
 * - every batch writes a NEW output file and never modifies the input;
 * - the REAL result JSON shape (success / commandResults / applied / sourceSha*).
 */
import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import {
  PdfBatchEditError,
  PdfDeletedObjectEditError,
  PdfSaveError,
  PdfWorkingCopyError,
} from '../src/errors';

interface SimText {
  kind: 'text';
  text: string;
  y: number;
}
interface SimForm {
  kind: 'form';
  children: SimText[];
}
type SimEntry = SimText | SimForm;
type SimPage = SimEntry[];

class NativePdfSimulator {
  files = new Map<string, SimPage[]>();
  handles = new Map<number, string>();
  nextHandle = 1;
  failNextBatchWith: unknown = null;
  batchCalls: { input: string; output: string; edits: any[] }[] = [];
  moves: [string, string][] = [];

  module = {
    openDocument: jest.fn(async (path: string) => {
      if (!this.files.has(path)) {
        throw Object.assign(new Error(`PDF file not found at path: ${path}`), { code: 'PDF_FILE_NOT_FOUND' });
      }
      const handle = this.nextHandle++;
      this.handles.set(handle, path);
      return { docHandle: handle, pageCount: this.files.get(path)!.length, filePath: path };
    }),
    closeDocument: jest.fn(async (handle: number) => {
      this.handles.delete(handle);
      return true;
    }),
    getPageCount: jest.fn(async (handle: number) => this.pagesOf(handle).length),
    getPageSize: jest.fn(async (_handle: number, pageIndex: number) => ({ pageIndex, width: 612, height: 792 })),
    getTextObjects: jest.fn(async (handle: number, pageIndex: number) =>
      JSON.stringify(this.extract(this.pagesOf(handle)[pageIndex], pageIndex)),
    ),
    applyBatchEdits: jest.fn(async (input: string, output: string, editsJson: string) =>
      JSON.stringify(this.batch(input, output, editsJson)),
    ),
    moveFile: jest.fn(async (from: string, to: string) => {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      this.moves.push([from, to]);
      return to;
    }),
    purgeRenderCache: jest.fn(async () => 0),
  };

  addFile(path: string, pages: SimPage[]) {
    this.files.set(path, JSON.parse(JSON.stringify(pages)));
  }

  texts(path: string, pageIndex = 0): string[] {
    const page = this.files.get(path)![pageIndex];
    const out: string[] = [];
    for (const e of page) {
      if (e.kind === 'text') out.push(e.text);
      else e.children.forEach((c) => out.push(c.text));
    }
    return out;
  }

  private pagesOf(handle: number): SimPage[] {
    const path = this.handles.get(handle);
    if (!path) throw new Error(`invalid handle ${handle}`);
    return this.files.get(path)!;
  }

  private object(id: string, pageIndex: number, objectIndex: number, path: number[], t: SimText) {
    const width = Math.max(20, t.text.length * 7);
    return {
      id,
      pageIndex,
      objectIndex,
      objectPath: path,
      text: t.text,
      bounds: { x: 50, y: t.y, width, height: 16 },
      pdfBounds: { left: 50, bottom: 792 - t.y - 16, right: 50 + width, top: 792 - t.y },
      fontSize: 12,
      fontName: 'Helvetica',
      color: '#000000',
      colorRgba: { r: 0, g: 0, b: 0, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 792 - t.y - 16 },
      isEditable: true,
    };
  }

  private extract(page: SimPage, pageIndex: number) {
    const out: any[] = [];
    page.forEach((entry, i) => {
      if (entry.kind === 'text') {
        out.push(this.object(`p${pageIndex}_path${i}`, pageIndex, i, [i], entry));
      } else {
        entry.children.forEach((child, j) => {
          out.push(this.object(`p${pageIndex}_path${i}_${j}`, pageIndex, j, [i, j], child));
        });
      }
    });
    return out;
  }

  private batch(input: string, output: string, editsJson: string) {
    const edits = JSON.parse(editsJson);
    this.batchCalls.push({ input, output, edits });

    if (this.failNextBatchWith) {
      const failure = this.failNextBatchWith;
      this.failNextBatchWith = null;
      return failure;
    }
    if (input === output) {
      return { success: false, errorCode: 'SAME_INPUT_OUTPUT', errorMessage: 'Input path and output path must be different' };
    }
    const source = this.files.get(input);
    if (!source) {
      return { success: false, errorCode: 'PDF_FILE_NOT_FOUND', errorMessage: `Input PDF file not found or inaccessible: ${input}` };
    }

    const pages: SimPage[] = JSON.parse(JSON.stringify(source));

    // Resolve every target before mutating (as the C++ bridge does)
    const resolved = edits.map((c: any) => {
      if (c.type === 'insert') return null;
      const path: number[] = c.objectPath && c.objectPath.length > 0 ? c.objectPath : [c.objectIndex];
      const page = pages[c.pageIndex];
      if (!page) return null;
      if (path.length === 1) {
        const e = page[path[0]];
        return e && e.kind === 'text' ? { container: page, entry: e } : null;
      }
      const form = page[path[0]];
      if (!form || form.kind !== 'form') return null;
      const child = form.children[path[1]];
      return child ? { container: form.children, entry: child } : null;
    });

    const removals: { container: any[]; entry: SimText }[] = [];
    const results = edits.map((c: any, i: number) => {
      const base = {
        type: c.type,
        objectId: c.objectId,
        pageIndex: c.pageIndex,
        objectIndex: c.objectIndex ?? 0,
        originalText: c.originalText ?? '',
        newText: c.newText ?? c.text ?? '',
        applied: false,
        verifiedInReopened: false,
        fontStrategy: '',
        fontReused: false,
        error: '',
      };
      if (c.type === 'insert') {
        pages[c.pageIndex].push({ kind: 'text', text: c.text, y: c.bounds?.y ?? 500 });
        return { ...base, applied: true, verifiedInReopened: true, fontStrategy: 'LOADED_STANDARD', newText: c.text };
      }
      const target = resolved[i];
      if (!target) {
        return { ...base, error: 'Object locator path could not be resolved' };
      }
      if (c.type === 'replace') {
        target.entry.text = c.newText;
        return { ...base, applied: true, verifiedInReopened: true, fontStrategy: 'REUSED_ORIGINAL', fontReused: true };
      }
      removals.push(target);
      return { ...base, applied: true, verifiedInReopened: true };
    });
    for (const r of removals) {
      const idx = r.container.indexOf(r.entry);
      if (idx >= 0) r.container.splice(idx, 1);
    }

    this.files.set(output, pages);
    return {
      success: true,
      inputPath: input,
      outputPath: output,
      commandsApplied: edits.length,
      sourceUnchanged: true,
      sourceShaBefore: 'sha-src',
      sourceShaAfter: 'sha-src',
      pageCountBefore: source.length,
      pageCountAfter: pages.length,
      commandResults: results,
    };
  }
}

const SOURCE = '/app/cache/picked_pdfs/123_contract.pdf';
const W = (n: number) => `/app/files/pie/sessions/pdf-1/working/working_${n}.pdf`;

let sim: NativePdfSimulator;
let engine: PdfiumEngine;
let editor: PdfDocumentEditor;

async function setup(pages: SimPage[] = [[
  { kind: 'text', text: 'Alpha', y: 60 },
  { kind: 'text', text: 'Bravo', y: 100 },
  { kind: 'text', text: 'Charlie', y: 140 },
]]) {
  sim = new NativePdfSimulator();
  sim.addFile(SOURCE, pages);
  (NativeModules as any).PdfiumNativeModule = sim.module;
  engine = new PdfiumEngine();
  editor = new PdfDocumentEditor(engine);
  await editor.open(SOURCE);
  await editor.getTextObjects(0);
}

const visibleTexts = async () => (await editor.getTextObjects(0)).map((o) => o.text);

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('Phase 11 — PDF save & persistence after applied edits', () => {
  it('Save after an applied replacement persists it via a verified copy (never an empty edit batch)', async () => {
    await setup();
    const applySpy = jest.spyOn(engine, 'applyBatchEdits');
    const copySpy = jest.spyOn(engine, 'copyDocument');

    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');

    const { outputPath, verified } = await editor.saveDocument('/app/files/pie/documents/pdf-1/rev_1.pdf');
    expect(verified).toBe(true);
    expect(outputPath).toBe('/app/files/pie/documents/pdf-1/rev_1.pdf');

    for (const call of applySpy.mock.calls) {
      expect(call[0].commands.length).toBeGreaterThan(0);
    }
    expect(copySpy).toHaveBeenCalledWith(W(1), '/app/files/pie/documents/pdf-1/rev_1.pdf');
    expect(sim.texts(outputPath)).toEqual(['Alpha v2', 'Bravo', 'Charlie']);
    expect(editor.getCurrentFilePath()).toBe(outputPath);
    expect(editor.getSourceFilePath()).toBe(SOURCE);
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  it('Save after an applied deletion persists the deletion', async () => {
    await setup();
    await editor.applyExistingTextDeletion('p0_path1', W(1));
    const { outputPath } = await editor.saveDocument('/app/out/deleted.pdf');
    expect(sim.texts(outputPath)).toEqual(['Alpha', 'Charlie']);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  it('Save after an applied insertion persists the inserted text', async () => {
    await setup();
    await editor.applyNewTextInsertion(0, 'Delta', { x: 60, y: 300 }, W(1));
    const { outputPath } = await editor.saveDocument('/app/out/inserted.pdf');
    expect(sim.texts(outputPath)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('Save combines applied revisions with queued commands in one native batch', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.getTextObjects(0);
    editor.replaceText('p0_path2', 'Charlie v2');

    const { outputPath } = await editor.saveDocument('/app/out/mixed.pdf');
    const last = sim.batchCalls[sim.batchCalls.length - 1];
    expect(last.input).toBe(W(1));
    expect(last.edits).toHaveLength(1);
    expect(sim.texts(outputPath)).toEqual(['Alpha v2', 'Bravo', 'Charlie v2']);
    expect(editor.getPendingEdits()).toHaveLength(0);
  });

  it('validates the saved output by reopening it, and a fresh editor reopens it correctly', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path1', 'Bravo v2', W(1));
    const { outputPath } = await editor.saveDocument('/app/out/reopen.pdf');
    expect(sim.module.openDocument).toHaveBeenCalledWith(outputPath, null);

    const reopened = new PdfDocumentEditor(new PdfiumEngine());
    await reopened.open(outputPath);
    const objs = await reopened.getTextObjects(0);
    expect(objs.map((o) => o.text)).toEqual(['Alpha', 'Bravo v2', 'Charlie']);
    expect(reopened.isDirty()).toBe(false);
  });

  it('a failed save marks SAVE_FAILED, keeps the working copy open and can be retried', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    sim.failNextBatchWith = {
      success: false,
      errorCode: 'PDF_SAVE_FAILED',
      errorMessage: 'FPDF_SaveAsCopy failed to save edited document',
    };

    await expect(editor.saveDocument('/app/out/fail.pdf')).rejects.toBeInstanceOf(PdfSaveError);
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
    expect(editor.isDirty()).toBe(true);
    expect(editor.getCurrentFilePath()).toBe(W(1));
    expect(editor.canUndo()).toBe(true);

    const { outputPath } = await editor.saveDocument('/app/out/retry.pdf');
    expect(sim.texts(outputPath)).toEqual(['Alpha v2', 'Bravo', 'Charlie']);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  it('saving onto the open document stages a temp file and promotes it (no stale reopen)', async () => {
    await setup();
    editor.replaceText('p0_path0', 'Alpha v2');
    await editor.saveDocument('/app/out/saved.pdf');
    await editor.getTextObjects(0);

    editor.replaceText('p0_path1', 'Bravo v2');
    const { outputPath } = await editor.saveDocument('/app/out/saved.pdf');

    expect(outputPath).toBe('/app/out/saved.pdf');
    expect(sim.moves).toHaveLength(1);
    expect(sim.moves[0][1]).toBe('/app/out/saved.pdf');
    expect(sim.texts('/app/out/saved.pdf')).toEqual(['Alpha v2', 'Bravo v2', 'Charlie']);
    expect([...sim.files.keys()].some((k) => k.includes('.tmp_'))).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
  });

  it('never modifies the source document across applied edits, undo and save', async () => {
    await setup();
    const before = JSON.stringify(sim.files.get(SOURCE));

    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.applyExistingTextDeletion('p0_path1', W(2));
    await editor.undo();
    await editor.saveDocument('/app/out/final.pdf');

    expect(JSON.stringify(sim.files.get(SOURCE))).toBe(before);
    await expect(editor.saveDocument(SOURCE)).rejects.toThrow(/source immutability/);
  });
});

describe('Phase 11 — PDF delete lifecycle', () => {
  it('applied deletion leaves the document DIRTY (never CLEAN) and keeps the source path', async () => {
    await setup();
    await editor.applyExistingTextDeletion('p0_path1', W(1));
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSaveState()).toBe('DIRTY');
    expect(editor.getSourceFilePath()).toBe(SOURCE);
    expect(editor.getCleanFilePath()).toBe(SOURCE);
  });

  it('the object that inherits a deleted positional ID stays visible and editable', async () => {
    await setup();
    await editor.applyExistingTextDeletion('p0_path1', W(1));

    const objs = await editor.getTextObjects(0);
    expect(objs.map((o) => o.text)).toEqual(['Alpha', 'Charlie']);
    expect(objs.find((o) => o.id === 'p0_path1')!.text).toBe('Charlie');

    await editor.applyExistingTextReplacement('p0_path1', 'Charlie v2', W(2));
    expect(sim.texts(W(2))).toEqual(['Alpha', 'Charlie v2']);
  });

  it('a stale reference to an object that no longer exists is rejected', async () => {
    await setup();
    await editor.applyExistingTextDeletion('p0_path2', W(1));
    await expect(editor.applyExistingTextDeletion('p0_path2', W(2))).rejects.toBeInstanceOf(
      PdfDeletedObjectEditError,
    );
    expect(sim.texts(editor.getCurrentFilePath()!)).toEqual(['Alpha', 'Bravo']);
  });

  it('nested Form XObject deletion uses the full object path and keeps siblings correct', async () => {
    await setup([[
      { kind: 'text', text: 'Title', y: 40 },
      { kind: 'form', children: [{ kind: 'text', text: 'Stamp', y: 200 }, { kind: 'text', text: 'Signature', y: 240 }] },
    ]]);
    await editor.applyExistingTextDeletion('p0_path1_0', W(1));

    const call = sim.batchCalls[sim.batchCalls.length - 1];
    expect(call.edits[0].objectPath).toEqual([1, 0]);
    const objs = await editor.getTextObjects(0);
    expect(objs.map((o) => [o.id, o.text])).toEqual([
      ['p0_path0', 'Title'],
      ['p0_path1_0', 'Signature'],
    ]);
  });

  it('discard after a deletion returns to the clean document and restores the object', async () => {
    await setup();
    await editor.applyExistingTextDeletion('p0_path1', W(1));
    await editor.discardWorkingChanges();
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.isDirty()).toBe(false);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(await visibleTexts()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('discard after a save returns to the saved document, not the original source', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Saved Alpha', W(1));
    await editor.saveDocument('/app/out/saved.pdf');
    await editor.getTextObjects(0);
    await editor.applyExistingTextDeletion('p0_path1', W(2));

    await editor.discardWorkingChanges();
    expect(editor.getCurrentFilePath()).toBe('/app/out/saved.pdf');
    expect(await visibleTexts()).toEqual(['Saved Alpha', 'Bravo', 'Charlie']);
  });
});

describe('Phase 11 — PDF undo / redo of applied edits', () => {
  it('undo reopens the previous revision (PDF content reversed); redo reapplies it', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    expect(editor.canUndo()).toBe(true);

    await editor.undo();
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(await visibleTexts()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(editor.isDirty()).toBe(false);
    expect(editor.canRedo()).toBe(true);

    await editor.redo();
    expect(editor.getCurrentFilePath()).toBe(W(1));
    expect(await visibleTexts()).toEqual(['Alpha v2', 'Bravo', 'Charlie']);
    expect(editor.isDirty()).toBe(true);
  });

  it('walks back and forth through replace, delete and insert revisions', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.applyExistingTextDeletion('p0_path1', W(2));
    await editor.applyNewTextInsertion(0, 'Delta', { x: 60, y: 300 }, W(3));
    expect(await visibleTexts()).toEqual(['Alpha v2', 'Charlie', 'Delta']);

    await editor.undo();
    expect(await visibleTexts()).toEqual(['Alpha v2', 'Charlie']);
    await editor.undo();
    expect(await visibleTexts()).toEqual(['Alpha v2', 'Bravo', 'Charlie']);
    await editor.undo();
    expect(await visibleTexts()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.canUndo()).toBe(false);

    await editor.redo();
    await editor.redo();
    await editor.redo();
    expect(editor.getCurrentFilePath()).toBe(W(3));
    expect(await visibleTexts()).toEqual(['Alpha v2', 'Charlie', 'Delta']);
    expect(editor.canRedo()).toBe(false);
  });

  it('a new edit after undo discards the redo branch', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.undo();
    await editor.getTextObjects(0);
    await editor.applyExistingTextReplacement('p0_path2', 'Charlie v2', W(2));
    expect(editor.canRedo()).toBe(false);
    expect(await visibleTexts()).toEqual(['Alpha', 'Bravo', 'Charlie v2']);
  });

  it('queued edits are folded into an applied revision and restored by its undo', async () => {
    await setup();
    editor.replaceText('p0_path0', 'Queued Alpha');
    await editor.applyExistingTextDeletion('p0_path2', W(1));

    const call = sim.batchCalls[sim.batchCalls.length - 1];
    expect(call.edits.map((e: any) => e.type)).toEqual(['replace', 'delete']);
    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(sim.texts(W(1))).toEqual(['Queued Alpha', 'Bravo']);

    await editor.undo();
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.getPendingEdits()).toHaveLength(1);
    expect(await visibleTexts()).toEqual(['Queued Alpha', 'Bravo', 'Charlie']);
    expect(editor.isDirty()).toBe(true);

    await editor.undo();
    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(editor.isDirty()).toBe(false);

    await editor.redo();
    await editor.redo();
    expect(editor.getCurrentFilePath()).toBe(W(1));
    expect(editor.getPendingEdits()).toHaveLength(0);
  });

  it('redo of queued nested edits preserves the Form XObject object path', async () => {
    await setup([[
      { kind: 'text', text: 'Title', y: 40 },
      { kind: 'form', children: [{ kind: 'text', text: 'Stamp', y: 200 }] },
    ]]);

    editor.deleteText('p0_path1_0');
    await editor.undo();
    await editor.redo();
    expect((editor.getPendingEdits()[0] as any).objectPath).toEqual([1, 0]);

    await editor.undo();
    editor.replaceText('p0_path1_0', 'Stamp v2');
    await editor.undo();
    await editor.redo();
    expect((editor.getPendingEdits()[0] as any).objectPath).toEqual([1, 0]);

    const { outputPath } = await editor.saveDocument('/app/out/nested.pdf');
    expect(sim.texts(outputPath)).toEqual(['Title', 'Stamp v2']);
  });

  it('rejects an undo onto a deleted revision file without losing state', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.applyExistingTextReplacement('p0_path1', 'Bravo v2', W(2));
    sim.files.delete(W(1));

    await expect(editor.undo()).rejects.toBeInstanceOf(PdfWorkingCopyError);
    expect(editor.getCurrentFilePath()).toBe(W(2));
    expect(editor.canUndo()).toBe(true);
    expect(await visibleTexts()).toEqual(['Alpha v2', 'Bravo v2', 'Charlie']);
  });

  it('a working copy may not overwrite a file that undo/redo still needs', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.applyExistingTextReplacement('p0_path1', 'Bravo v2', W(2));
    await editor.getTextObjects(0);
    await expect(
      editor.applyExistingTextReplacement('p0_path2', 'Charlie v2', W(1)),
    ).rejects.toBeInstanceOf(PdfBatchEditError);
    await expect(
      editor.applyExistingTextReplacement('p0_path2', 'Charlie v2', SOURCE),
    ).rejects.toBeInstanceOf(PdfBatchEditError);
  });

  it('Save clears history; dirty state is relative to the saved document', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.saveDocument('/app/out/saved.pdf');
    expect(editor.canUndo()).toBe(false);

    await editor.getTextObjects(0);
    await editor.applyExistingTextDeletion('p0_path1', W(2));
    expect(editor.isDirty()).toBe(true);
    await editor.undo();
    expect(editor.getCurrentFilePath()).toBe('/app/out/saved.pdf');
    expect(editor.isDirty()).toBe(false);
  });

  it('reports every file the session still needs as protected', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path0', 'Alpha v2', W(1));
    await editor.applyExistingTextDeletion('p0_path1', W(2));
    await editor.undo();

    const protectedPaths = editor.getProtectedFilePaths();
    expect(protectedPaths).toEqual(expect.arrayContaining([SOURCE, W(1), W(2)]));
  });
});
