/**
 * Phase 15 — revision-file storage safety: applied-edit revisions are capped by count and
 * bytes, the oldest undo steps are dropped deterministically, released files never include
 * the source / clean / open file, and only session working copies are ever deleted.
 */
import { NativeModules } from 'react-native';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { DEFAULT_REVISION_LIMITS, PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { deleteReleasedRevisionFiles } from '../src/features/pdf/pdfDocumentFiles';
import { IFileStore } from '../src/storage/nativeFileStore';

const ROOT = '/data/files/pie';
const SOURCE = `${ROOT}/documents/pdf-s/source.pdf`;
const W = (n: number) => `${ROOT}/sessions/pdf-s/working/working_${n}.pdf`;

function installNative(sizes: Map<string, number> = new Map()) {
  const files = new Map<string, string[]>([[SOURCE, ['v0']]]);
  let next = 1;
  const handles = new Map<number, string>();
  (NativeModules as any).PdfiumNativeModule = {
    openDocument: jest.fn(async (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error('not found'), { code: 'PDF_FILE_NOT_FOUND' });
      const h = next++;
      handles.set(h, p);
      return { docHandle: h, pageCount: 1, filePath: p, fileSizeBytes: sizes.get(p) ?? 100 };
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
  };
  return files;
}

async function openEditor() {
  const editor = new PdfDocumentEditor(new PdfiumEngine());
  await editor.open(SOURCE);
  await editor.getTextObjects(0);
  return editor;
}

async function applyEdits(editor: PdfDocumentEditor, from: number, to: number) {
  for (let n = from; n <= to; n++) {
    await editor.getTextObjects(0);
    await editor.applyExistingTextReplacement('p0_path0', `v${n}`, W(n));
  }
}

afterEach(() => {
  delete (NativeModules as any).PdfiumNativeModule;
});

describe('Phase 15 — revision history cap', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_REVISION_LIMITS.maxRevisions).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_REVISION_LIMITS.maxBytes).toBeGreaterThan(0);
  });

  it('keeps at most N revisions; the oldest undo steps are dropped deterministically', async () => {
    installNative();
    const editor = await openEditor();
    editor.setRevisionLimits({ maxRevisions: 3 });

    await applyEdits(editor, 1, 4);
    expect(editor.isHistoryTruncated()).toBe(true);
    // W1 is still the "before" file of the oldest remaining step; the source is protected
    expect(editor.takeDiscardedRevisionFiles()).toEqual([]);

    await applyEdits(editor, 5, 5);
    expect(editor.takeDiscardedRevisionFiles()).toEqual([W(1)]);

    // Exactly three undo steps remain: W5 -> W4 -> W3 -> W2, then no further undo
    for (const expected of [W(4), W(3), W(2)]) {
      expect(editor.canUndo()).toBe(true);
      await editor.undo();
      expect(editor.getCurrentFilePath()).toBe(expected);
    }
    expect(editor.canUndo()).toBe(false);
    // Redo still walks forward through the available history
    await editor.redo();
    expect(editor.getCurrentFilePath()).toBe(W(3));
  });

  it('caps the bytes of revision files (source / clean file excluded), keeping the newest step', async () => {
    installNative();
    const editor = await openEditor();
    editor.setRevisionLimits({ maxRevisions: 50, maxBytes: 250 });
    await applyEdits(editor, 1, 3);

    // W1..W3 = 300 bytes > 250: steps are dropped until W2 + W3 = 200 remain
    await editor.undo();
    expect(editor.getCurrentFilePath()).toBe(W(2));
    expect(editor.canUndo()).toBe(false);
    expect(editor.takeDiscardedRevisionFiles()).toEqual([W(1)]);
  });

  it('never releases the source, the clean file or the open file', async () => {
    installNative();
    const editor = await openEditor();
    editor.setRevisionLimits({ maxRevisions: 1 });
    await applyEdits(editor, 1, 6);
    const released = editor.takeDiscardedRevisionFiles();
    expect(released).not.toContain(SOURCE);
    expect(released).not.toContain(editor.getCleanFilePath());
    expect(released).not.toContain(editor.getCurrentFilePath());
    expect(released).not.toContain(W(5)); // before-file of the one remaining undo step
    expect(released.sort()).toEqual([W(1), W(2), W(3), W(4)].sort());
    // Released files are reported once
    expect(editor.takeDiscardedRevisionFiles()).toEqual([]);
  });

  it('a new edit after undo releases the abandoned redo branch', async () => {
    installNative();
    const editor = await openEditor();
    await applyEdits(editor, 1, 2);
    await editor.undo(); // back to W1, W2 is now only reachable via redo
    expect(editor.takeDiscardedRevisionFiles()).toEqual([]);
    await editor.getTextObjects(0);
    await editor.applyExistingTextReplacement('p0_path0', 'branch', W(3));
    expect(editor.takeDiscardedRevisionFiles()).toEqual([W(2)]);
    expect(editor.canRedo()).toBe(false);
  });
});

describe('Phase 15 — deleting released revision files', () => {
  function store(): IFileStore & { deleted: string[] } {
    const deleted: string[] = [];
    return {
      deleted,
      getRootPath: jest.fn(async () => ROOT),
      writeFileAtomic: jest.fn(),
      readFile: jest.fn(),
      exists: jest.fn(),
      copyFile: jest.fn(),
      deletePath: jest.fn(async (p: string) => void deleted.push(p)),
      listDirectory: jest.fn(async () => []),
      makeDirectory: jest.fn(),
    } as any;
  }

  it('only deletes direct PDF children of this document session working directory', async () => {
    const fs = store();
    const removed = await deleteReleasedRevisionFiles(
      'pdf-s',
      [
        W(1),
        `file://${W(2)}`,
        SOURCE,
        `${ROOT}/documents/pdf-s/rev_1700.pdf`,
        `${ROOT}/sessions/pdf-other/working/working_1.pdf`,
        `${ROOT}/sessions/pdf-s/working/nested/working_9.pdf`,
        `${ROOT}/sessions/pdf-s/working/notes.txt`,
        `${ROOT}/sessions/pdf-s/working`,
        `${ROOT}/sessions/pdf-s/working/../../../documents/pdf-s/source.pdf`,
      ],
      fs,
    );
    expect(fs.deleted).toEqual([W(1), W(2)]);
    expect(removed).toBe(2);
  });

  it('is a no-op without a file store or released paths, and rejects unsafe ids', async () => {
    await expect(deleteReleasedRevisionFiles('pdf-s', [W(1)], null)).resolves.toBe(0);
    await expect(deleteReleasedRevisionFiles('pdf-s', [], store())).resolves.toBe(0);
    await expect(deleteReleasedRevisionFiles('../x', [W(1)], store())).rejects.toThrow();
  });
});
