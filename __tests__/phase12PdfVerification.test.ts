/**
 * Phase 12 — PDF reopen verification, escaped/Unicode text and Save semantics.
 *
 * Drives the REAL PdfiumEngine + PdfDocumentEditor against a native simulator that returns
 * the real batch JSON shape and implements the Phase 12 verification contract of
 * pdfium_bridge.cpp (pie::verifyPageEdits in pie_bridge_core.h, mirrored below): the edited
 * object must hold exactly the requested text, and exact occurrence counts on the page must
 * match, so duplicate text can neither hide a failed edit nor fail a correct one.
 * The C++ implementation itself is covered by android/app/src/test/cpp/pie_bridge_core_test.cpp.
 *
 * Faults simulate a native layer that claims success without (correctly) writing the edit.
 */
import { NativeModules } from 'react-native';
import { PdfiumEngine, normalizeNativeBatchResult } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfBatchEditError, PdfReopenVerificationError } from '../src/errors';

interface SimObj {
  text: string;
}
type SimPage = SimObj[];

interface Faults {
  dropDeletes?: boolean;
  dropReplacements?: boolean;
  replacementTextOverride?: string;
  omitCommandResults?: boolean;
  reportChangedSourceChecksum?: boolean;
}

interface VerifyEdit {
  type: string;
  preText: string;
  newText: string;
  objectFound: boolean;
  objectText: string;
  verified?: boolean;
  error?: string;
}

/** TypeScript mirror of pie::verifyPageEdits (android/app/src/main/cpp/pdfium/pie_bridge_core.h). */
function verifyPageEdits(before: string[], after: string[], edits: VerifyEdit[]): void {
  const norm = (s: string) => s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  const counts = (texts: string[]) => {
    const m = new Map<string, number>();
    texts.forEach((t) => m.set(norm(t), (m.get(norm(t)) ?? 0) + 1));
    return m;
  };
  const expected = counts(before);
  const bump = (k: string, d: number) => expected.set(norm(k), (expected.get(norm(k)) ?? 0) + d);
  let expectedTotal = before.length;
  for (const e of edits) {
    if (e.type === 'replace') { bump(e.preText, -1); bump(e.newText, 1); }
    if (e.type === 'delete') { bump(e.preText, -1); expectedTotal--; }
    if (e.type === 'insert') { bump(e.newText, 1); expectedTotal++; }
  }
  const actual = counts(after);
  const count = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
  for (const e of edits) {
    e.verified = false;
    const pre = norm(e.preText);
    const req = norm(e.newText);
    if (e.type === 'replace' || e.type === 'insert') {
      if (!e.objectFound) { e.error = 'Edited text object was not found at its expected location'; continue; }
      if (norm(e.objectText) !== req) { e.error = 'Reopened object text does not match the requested text'; continue; }
      if (count(actual, req) !== count(expected, req)) {
        e.error = `Requested text occurs ${count(actual, req)} time(s) in the reopened page; expected ${count(expected, req)}`;
        continue;
      }
      if (e.type === 'replace' && pre && pre !== req && count(actual, pre) !== count(expected, pre)) {
        e.error = `Replaced text still occurs ${count(actual, pre)} time(s) in the reopened page; expected ${count(expected, pre)}`;
        continue;
      }
      e.verified = true;
    } else if (e.type === 'delete') {
      if (pre ? count(actual, pre) !== count(expected, pre) : after.length !== expectedTotal) {
        e.error = `Deleted text occurs ${count(actual, pre)} time(s) in the reopened page; expected ${count(expected, pre)}`;
        continue;
      }
      e.verified = true;
    }
  }
}

class VerifyingNativeSimulator {
  files = new Map<string, SimPage[]>();
  handles = new Map<number, string>();
  nextHandle = 1;
  faults: Faults = {};
  batchCalls: { input: string; output: string; json: string }[] = [];

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
    getPageSize: jest.fn(async (_h: number, pageIndex: number) => ({ pageIndex, width: 612, height: 792 })),
    getTextObjects: jest.fn(async (handle: number, pageIndex: number) =>
      JSON.stringify(
        this.pagesOf(handle)[pageIndex].map((o, i) => ({
          id: `p${pageIndex}_path${i}`,
          pageIndex,
          objectIndex: i,
          objectPath: [i],
          text: o.text,
          bounds: { x: 50, y: 60 + i * 30, width: 120, height: 16 },
          pdfBounds: { left: 50, bottom: 716 - i * 30, right: 170, top: 732 - i * 30 },
          fontSize: 12,
          fontName: 'Helvetica',
          color: '#000000',
          colorRgba: { r: 0, g: 0, b: 0, a: 255 },
          matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 716 - i * 30 },
          isEditable: true,
        })),
      ),
    ),
    applyBatchEdits: jest.fn(async (input: string, output: string, json: string) =>
      JSON.stringify(this.batch(input, output, json)),
    ),
    moveFile: jest.fn(async (from: string, to: string) => {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      return to;
    }),
    purgeRenderCache: jest.fn(async () => 0),
  };

  addFile(path: string, texts: string[][]) {
    this.files.set(path, texts.map((p) => p.map((text) => ({ text }))));
  }

  texts(path: string, pageIndex = 0): string[] {
    return this.files.get(path)![pageIndex].map((o) => o.text);
  }

  private pagesOf(handle: number): SimPage[] {
    const path = this.handles.get(handle);
    if (!path) throw new Error(`invalid handle ${handle}`);
    return this.files.get(path)!;
  }

  private batch(input: string, output: string, json: string) {
    this.batchCalls.push({ input, output, json });
    const edits: any[] = JSON.parse(json);
    const source = this.files.get(input);
    if (!source) {
      return { success: false, errorCode: 'PDF_FILE_NOT_FOUND', errorMessage: `Input PDF file not found: ${input}` };
    }
    const pages: SimPage[] = source.map((p) => p.map((o) => ({ ...o })));
    const before = pages.map((p) => p.map((o) => o.text));

    const results = edits.map((c) => ({
      type: c.type,
      objectId: c.objectId,
      pageIndex: c.pageIndex,
      objectIndex: c.objectIndex ?? 0,
      originalText: c.originalText ?? '',
      newText: c.newText ?? '',
      applied: false,
      verifiedInReopened: false,
      verificationError: '',
      fontStrategy: '',
      fontReused: false,
      error: '',
    }));
    const targets = edits.map((c) =>
      c.type === 'insert' ? null : pages[c.pageIndex]?.[(c.objectPath && c.objectPath[0]) ?? c.objectIndex] ?? null,
    );
    const preTexts = targets.map((t) => (t ? t.text : ''));
    const edited: (SimObj | null)[] = edits.map(() => null);

    edits.forEach((c, i) => {
      const page = pages[c.pageIndex];
      if (c.type === 'insert') {
        const obj = { text: c.text };
        page.push(obj);
        edited[i] = obj;
        results[i].applied = true;
        results[i].newText = c.text;
        return;
      }
      const target = targets[i];
      if (!target) {
        results[i].error = 'Object locator path could not be resolved';
        return;
      }
      if (c.type === 'replace') {
        if (!this.faults.dropReplacements) target.text = this.faults.replacementTextOverride ?? c.newText;
        edited[i] = target;
      } else if (!this.faults.dropDeletes) {
        page.splice(page.indexOf(target), 1);
      }
      results[i].applied = true;
    });

    const touched = [...new Set(edits.map((c) => c.pageIndex as number))];
    for (const p of touched) {
      const indices = edits.map((c, i) => i).filter((i) => edits[i].pageIndex === p && results[i].applied);
      const inputs: VerifyEdit[] = indices.map((i) => ({
        type: results[i].type,
        preText: preTexts[i],
        newText: results[i].newText,
        objectFound: !!edited[i] && pages[p].includes(edited[i]!),
        objectText: edited[i]?.text ?? '',
      }));
      verifyPageEdits(before[p], pages[p].map((o) => o.text), inputs);
      indices.forEach((i, k) => {
        results[i].verifiedInReopened = inputs[k].verified === true;
        results[i].verificationError = inputs[k].error ?? '';
      });
    }

    this.files.set(output, pages);
    return {
      success: true,
      inputPath: input,
      outputPath: output,
      commandsApplied: edits.length,
      sourceUnchanged: !this.faults.reportChangedSourceChecksum,
      sourceShaBefore: 'sha-src',
      sourceShaAfter: this.faults.reportChangedSourceChecksum ? 'sha-changed' : 'sha-src',
      pageCountBefore: source.length,
      pageCountAfter: pages.length,
      commandResults: this.faults.omitCommandResults ? [] : results,
    };
  }
}

const SOURCE = '/data/files/pie/documents/pdf-12/source.pdf';
const W = (n: number) => `/data/files/pie/sessions/pdf-12/working/working_${n}.pdf`;
const REV = '/data/files/pie/documents/pdf-12/rev_1.pdf';
const INVOICE = [['Total', 'Subtotal', 'Total', 'Tax']];

let sim: VerifyingNativeSimulator;
let engine: PdfiumEngine;
let editor: PdfDocumentEditor;

async function setup(pages: string[][] = INVOICE) {
  sim = new VerifyingNativeSimulator();
  sim.addFile(SOURCE, pages);
  (NativeModules as any).PdfiumNativeModule = sim.module;
  engine = new PdfiumEngine();
  editor = new PdfDocumentEditor(engine);
  await editor.open(SOURCE);
  await editor.getTextObjects(0);
}

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('Phase 12 — duplicate-safe reopen verification (applied edits)', () => {
  it('deleting ONE of two identical texts is verified (no false failure)', async () => {
    await setup();
    const { result } = await editor.applyExistingTextDeletion('p0_path0', W(1));
    expect(result.commands[0].verifiedInReopened).toBe(true);
    expect(sim.texts(W(1))).toEqual(['Subtotal', 'Total', 'Tax']);
    expect(editor.getCurrentFilePath()).toBe(W(1));
    expect(editor.canUndo()).toBe(true);
  });

  it('a delete the native layer did not perform is rejected even though duplicates remain', async () => {
    await setup();
    sim.faults.dropDeletes = true;
    const attempt = editor.applyExistingTextDeletion('p0_path0', W(1));
    await expect(attempt).rejects.toBeInstanceOf(PdfReopenVerificationError);
    await expect(editor.applyExistingTextDeletion('p0_path0', W(2))).rejects.toThrow(
      /Deleted text occurs 2 time\(s\).*expected 1/,
    );
    // Nothing was committed: the open document and history are unchanged.
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.canUndo()).toBe(false);
    expect((await editor.getTextObjects(0)).map((o) => o.text)).toEqual(['Total', 'Subtotal', 'Total', 'Tax']);
  });

  it('a dropped replacement hidden by identical text elsewhere is rejected (old substring check passed it)', async () => {
    await setup();
    sim.faults.dropReplacements = true;
    await expect(editor.applyExistingTextReplacement('p0_path3', 'Total', W(1))).rejects.toBeInstanceOf(
      PdfReopenVerificationError,
    );
    // The output page still contains "Total" (twice) — a page-wide substring/equality check
    // would have reported this failed replacement as verified.
    expect(sim.texts(W(1)).some((t) => t.includes('Total'))).toBe(true);
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
  });

  it('a correct replacement next to identical text is verified', async () => {
    await setup();
    const { result } = await editor.applyExistingTextReplacement('p0_path3', 'Total', W(1));
    expect(result.commands[0].verifiedInReopened).toBe(true);
    expect(sim.texts(W(1))).toEqual(['Total', 'Subtotal', 'Total', 'Total']);
  });

  it('altered text (e.g. glyphs lost by the font) is rejected', async () => {
    await setup();
    sim.faults.replacementTextOverride = 'Caf';
    await expect(editor.applyExistingTextReplacement('p0_path3', 'Café', W(1))).rejects.toThrow(
      /could not be verified.*does not match the requested text/,
    );
  });

  it('a verified insertion duplicating existing text succeeds', async () => {
    await setup();
    const { result } = await editor.applyNewTextInsertion(0, 'Total', { x: 60, y: 300 }, W(1));
    expect(result.commands[0].verifiedInReopened).toBe(true);
    expect(sim.texts(W(1))).toEqual(['Total', 'Subtotal', 'Total', 'Tax', 'Total']);
  });
});

describe('Phase 12 — Save failure / success semantics', () => {
  it('Save with an unverified edit fails, keeps the edits and the clean file', async () => {
    await setup();
    editor.replaceText('p0_path3', 'VAT');
    sim.faults.dropReplacements = true;

    await expect(editor.saveDocument(REV)).rejects.toBeInstanceOf(PdfReopenVerificationError);
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
    expect(editor.getPendingEdits()).toHaveLength(1);
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.getCleanFilePath()).toBe(SOURCE);
    expect(editor.isDirty()).toBe(true);

    // Retry once the native write is correct: verified save, clean state.
    sim.faults = {};
    const { outputPath, verified } = await editor.saveDocument(REV);
    expect(verified).toBe(true);
    expect(outputPath).toBe(REV);
    expect(sim.texts(REV)).toEqual(['Total', 'Subtotal', 'Total', 'VAT']);
    expect(editor.getSaveState()).toBe('CLEAN');
    expect(editor.getPendingEdits()).toHaveLength(0);
  });

  it('Save fails when the native result does not report the applied edits of a non-empty batch', async () => {
    await setup();
    editor.replaceText('p0_path3', 'VAT');
    sim.faults.omitCommandResults = true;
    await expect(editor.saveDocument(REV)).rejects.toThrow(/did not report any applied edit/);
    expect(editor.getPendingEdits()).toHaveLength(1);
  });

  it('Save after applied edits is a verified copy; copyDocument stays separate from applyBatchEdits', async () => {
    await setup();
    await editor.applyExistingTextReplacement('p0_path3', 'VAT', W(1));
    const applySpy = jest.spyOn(engine, 'applyBatchEdits');
    const copySpy = jest.spyOn(engine, 'copyDocument');

    const { verified } = await editor.saveDocument(REV);
    expect(verified).toBe(true);
    expect(copySpy).toHaveBeenCalledWith(W(1), REV);
    expect(applySpy).not.toHaveBeenCalled();
    expect(sim.batchCalls[sim.batchCalls.length - 1].json).toBe('[]');
    await expect(
      engine.applyBatchEdits({ inputPdfPath: W(1), outputPdfPath: '/x.pdf', commands: [] }),
    ).rejects.toThrow('No edit commands provided');
  });

  it('source immutability: a changed source checksum rejects the save and the source is untouched', async () => {
    await setup();
    editor.replaceText('p0_path3', 'VAT');
    sim.faults.reportChangedSourceChecksum = true;
    await expect(editor.saveDocument(REV)).rejects.toBeInstanceOf(PdfBatchEditError);
    await expect(editor.saveDocument(REV)).rejects.toThrow(/source immutability/);
    expect(sim.texts(SOURCE)).toEqual(['Total', 'Subtotal', 'Total', 'Tax']);
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
  });

  it('Save never writes over the immutable source', async () => {
    await setup();
    editor.replaceText('p0_path3', 'VAT');
    await expect(editor.saveDocument(SOURCE)).rejects.toThrow(/source immutability/);
    expect(sim.batchCalls).toHaveLength(0);
  });
});

describe('Phase 12 — escaped and Unicode text through the JSON bridge', () => {
  // Phase 15: newlines, tabs and emoji are refused for PDF text (a PDF text object cannot draw
  // them; see phase15PdfGlyphs.test.ts). JSON escaping of quotes/backslashes and Unicode is
  // still exercised here; newline/emoji escaping is covered by the C++ core test.
  const TRICKY = 'Line "1" C:\\dir\\file 東京 café €';

  it('sends escaped / CJK text as valid JSON that decodes to the exact string', async () => {
    await setup();
    const { result } = await editor.applyExistingTextReplacement('p0_path3', TRICKY, W(1));
    const sent = sim.batchCalls[0].json;
    expect(() => JSON.parse(sent)).not.toThrow();
    expect(sent).toContain('\\"1\\"');
    expect(sent).toContain('\\\\dir\\\\');
    expect(JSON.parse(sent)[0].newText).toBe(TRICKY);
    expect(result.commands[0].verifiedInReopened).toBe(true);
    expect(sim.texts(W(1))[3]).toBe(TRICKY);
  });

  it('decodes native JSON with \\u escapes and surrogate pairs exactly', () => {
    const raw = JSON.parse(
      '{"success":true,"outputPath":"/o.pdf","commandsApplied":1,"sourceUnchanged":true,' +
        '"sourceShaBefore":"a","sourceShaAfter":"a","pageCountBefore":1,"pageCountAfter":1,' +
        '"commandResults":[{"type":"replace","objectId":"p0_path0","pageIndex":0,"objectIndex":0,' +
        '"originalText":"Tax","newText":"\\u6771\\u4eac \\ud83d\\ude00 \\"q\\"\\n","applied":true,' +
        '"verifiedInReopened":true,"verificationError":"","fontStrategy":"REUSED_ORIGINAL","fontReused":true,"error":""}]}',
    );
    const result = normalizeNativeBatchResult(raw, { outputPdfPath: '/o.pdf', commandCount: 1 });
    expect(result.commands[0].newText).toBe('東京 😀 "q"\n');
    expect(result.commands[0].verificationError).toBeUndefined();
  });

  it('passes the native verification reason through to the editor error', () => {
    const raw = {
      success: true,
      outputPath: '/o.pdf',
      commandsApplied: 1,
      sourceUnchanged: true,
      sourceShaBefore: 'a',
      sourceShaAfter: 'a',
      pageCountBefore: 1,
      pageCountAfter: 1,
      commandResults: [
        {
          type: 'delete', objectId: 'p0_path0', pageIndex: 0, objectIndex: 0, originalText: 'Total', newText: '',
          applied: true, verifiedInReopened: false,
          verificationError: 'Deleted text occurs 2 time(s) in the reopened page; expected 1',
          fontStrategy: '', fontReused: false, error: '',
        },
      ],
    };
    const result = normalizeNativeBatchResult(raw, { outputPdfPath: '/o.pdf', commandCount: 1 });
    expect(result.commands[0].status).toBe('applied');
    expect(result.commands[0].verifiedInReopened).toBe(false);
    expect(result.commands[0].verificationError).toContain('expected 1');
    expect(result.reopenedVerification.allDeletionsVerified).toBe(false);
  });
});
