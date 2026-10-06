/**
 * QA19 — Drive-style PDF text selection (long press = word, handles extend by character),
 * character-range edits with line reflow, Form XObject edits (flattened natively), haptics.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules, Text, TextInput } from 'react-native';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

import {
  PdfPageChars,
  charAtPoint,
  normalizeRange,
  parsePageChars,
  planRangeEdit,
  rangeHandles,
  rangeMarkOperation,
  rangeRects,
  rangeText,
  wordRangeAt,
} from '../src/features/pdf/pdfCharSelection';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfTextObject } from '../src/features/pdf/types';
import { PdfTextEditModal } from '../src/features/pdf/components/PdfTextEditModal';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/settings/appSettings';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const obj = (id: string, text: string, x: number, extra: Partial<PdfTextObject> = {}): PdfTextObject => ({
  id,
  pageIndex: 0,
  objectIndex: Number(id.replace(/\D/g, '')) || 0,
  objectPath: [Number(id.replace(/\D/g, '')) || 0],
  text,
  bounds: { x, y: 100, width: text.length * 6, height: 12 },
  pdfBounds: { left: x, bottom: 680, right: x + text.length * 6, top: 692 },
  fontSize: 10,
  fontName: 'Helvetica',
  color: '#000000',
  colorRgba: null,
  matrix: null,
  isEditable: true,
  ...extra,
});

/**
 * Native-shaped page chars: objects laid out left to right on one line (6pt per character,
 * a generated space between objects), optional second line.
 */
function nativeChars(lines: { id: string; text: string }[][]): string {
  const objects: string[] = [];
  const chars: number[][] = [];
  lines.forEach((line, li) => {
    if (li > 0) chars.push([13, 0, 0, 0, 0, 0, -1, 0, 1], [10, 0, 0, 0, 0, 0, -1, 0, 1]);
    let x = 50;
    const top = 100 + li * 20;
    line.forEach((o, k) => {
      if (k > 0) {
        chars.push([32, x, top, 6, 12, top + 9, -1, 0, 1]);
        x += 6;
      }
      const oi = objects.push(o.id) - 1;
      [...o.text].forEach((ch, off) => {
        chars.push([ch.codePointAt(0)!, x, top, 6, 12, top + 9, oi, off, 0]);
        x += 6;
      });
    });
  });
  return JSON.stringify({ pageIndex: 0, objects, chars });
}

const page1 = () =>
  parsePageChars(
    nativeChars([
      [
        { id: 'p0_path0', text: 'Summer' },
        { id: 'p0_path1', text: 'internship' },
        { id: 'p0_path2', text: 'report' },
      ],
      [{ id: 'p0_path3', text: "don't stop" }],
    ]),
  ) as PdfPageChars;

describe('QA19 character model', () => {
  it('parses native chars into lines with object ownership and generated spaces', () => {
    const p = page1();
    expect(p.lines).toHaveLength(2);
    expect(p.chars[0]).toMatchObject({ ch: 'S', objectId: 'p0_path0', offset: 0, generated: false, line: 0 });
    expect(p.chars[6]).toMatchObject({ ch: ' ', objectId: null, generated: true });
    expect(parsePageChars('not json')).toBeNull();
    expect(parsePageChars({ chars: [] })).toBeNull();
  });

  it('long press selects the word under the finger; tolerance rejects empty space', () => {
    const p = page1();
    const i = charAtPoint(p, { x: 50 + 7 * 6 + 2, y: 105 }, 12)!; // inside "internship"
    expect(rangeText(p, wordRangeAt(p, i))).toBe('internship');
    expect(charAtPoint(p, { x: 300, y: 400 }, 12)).toBeNull();
    // apostrophes inside a word are part of it
    const d = charAtPoint(p, { x: 52, y: 125 }, 12)!;
    expect(rangeText(p, wordRangeAt(p, d))).toBe("don't");
  });

  it('dragging extends by character, across objects and lines, in either direction', () => {
    const p = page1();
    const word = wordRangeAt(p, 10);
    const far = charAtPoint(p, { x: 64, y: 125 })!; // second line, "n"
    const r = normalizeRange(word.start, far);
    expect(rangeText(p, r)).toBe('internship report\ndon');
    expect(rangeRects(p, r)).toHaveLength(2);
    const back = normalizeRange(word.end, 2);
    expect(rangeText(p, back)).toBe('mmer internship');
    const h = rangeHandles(p, back)!;
    expect(h.start.x).toBe(50 + 2 * 6);
    expect(h.end.x).toBe(50 + 17 * 6);
  });

  it('markup uses the exact characters and the stored colour', () => {
    const p = page1();
    const op = rangeMarkOperation(p, { start: 7, end: 16 }, 'underline', '#ff0000') as any;
    expect(op).toMatchObject({ type: 'addHighlight', style: 'underline', color: '#FF0000', opacity: 1 });
    expect(op.rects).toHaveLength(1);
    expect(op.rects[0].x).toBe(50 + 7 * 6);
    expect(op.rects[0].width).toBe(60);
  });
});

describe('QA19 range edit planning', () => {
  const objects = new Map(
    [obj('p0_path0', 'Summer', 50), obj('p0_path1', 'internship', 92), obj('p0_path2', 'report', 158), obj('p0_path3', "don't stop", 50)].map(
      (o) => [o.id, o],
    ),
  );

  it('a whole word replaces that object only', () => {
    const plan = planRangeEdit(page1(), { start: 7, end: 16 }, 'training', objects) as any;
    expect(plan.items).toEqual([{ objectId: 'p0_path1', newText: 'training' }]);
    expect(plan.wholeObjects).toBe(true);
  });

  it('part of a word keeps the rest of that object', () => {
    const plan = planRangeEdit(page1(), { start: 7, end: 11 }, 'extern', objects) as any; // "inter"
    expect(plan.items).toEqual([{ objectId: 'p0_path1', newText: 'externnship' }]);
    expect(plan.wholeObjects).toBe(false);
  });

  it('across objects: first gets the replacement, middle deleted, last keeps its tail', () => {
    const plan = planRangeEdit(page1(), { start: 2, end: 19 }, '', objects) as any; // "mmer internship re"
    expect(plan.items).toEqual([
      { objectId: 'p0_path0', newText: 'Su' },
      { objectId: 'p0_path1', newText: null },
      { objectId: 'p0_path2', newText: 'port' },
    ]);
    expect(plan.objectIds).toEqual(['p0_path0', 'p0_path1', 'p0_path2']);
  });

  it('refuses a partial edit when the characters do not match the object text (ligatures etc.)', () => {
    const odd = new Map(objects);
    odd.set('p0_path1', obj('p0_path1', 'interﬁnship', 92));
    expect(planRangeEdit(page1(), { start: 7, end: 9 }, 'x', odd)).toEqual({ error: expect.stringMatching(/whole word/) });
    // a whole-object selection does not depend on the characters
    expect('items' in (planRangeEdit(page1(), { start: 7, end: 16 }, 'x', odd) as any)).toBe(true);
  });

  it('a selection of only generated characters has nothing to edit', () => {
    expect(planRangeEdit(page1(), { start: 6, end: 6 }, '', objects)).toEqual({ error: expect.any(String) });
  });
});

describe('QA19 character-range edits through the canonical PDF editor', () => {
  const SOURCE = '/app/files/pie/documents/pdf-1/source.pdf';
  const W = (n: number) => `/app/files/pie/sessions/pdf-1/working/working_${n}.pdf`;

  function installNative(initial: string[]) {
    const files = new Map<string, (string | null)[]>([[SOURCE, initial]]);
    const handles = new Map<number, string>();
    let next = 1;
    const batches: any[][] = [];
    const objects = (texts: (string | null)[]) =>
      texts
        .map((t, i) => (t === null ? null : { ...obj(`p0_path${i}`, t, 50 + i * 60), objectIndex: i, objectPath: [i] }))
        .filter(Boolean);
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (p: string) => {
        if (!files.has(p)) throw Object.assign(new Error('not found'), { code: 'PDF_FILE_NOT_FOUND' });
        const h = next++;
        handles.set(h, p);
        return { docHandle: h, pageCount: 1, filePath: p, fileSizeBytes: 100 };
      }),
      closeDocument: jest.fn(async () => true),
      getPageCount: jest.fn(async () => 1),
      getPageSize: jest.fn(async () => ({ pageIndex: 0, width: 612, height: 792 })),
      getTextObjects: jest.fn(async (h: number) => JSON.stringify(objects(files.get(handles.get(h)!)!))),
      applyBatchEdits: jest.fn(async (input: string, output: string, editsJson: string) => {
        const edits = JSON.parse(editsJson);
        batches.push(edits);
        const out = [...files.get(input)!];
        for (const e of edits) out[e.objectPath[0]] = e.type === 'delete' ? null : e.newText;
        files.set(output, out);
        return JSON.stringify({
          success: true,
          inputPath: input,
          outputPath: output,
          commandsApplied: edits.length,
          sourceUnchanged: true,
          sourceShaBefore: 'a',
          sourceShaAfter: 'a',
          pageCountBefore: 1,
          pageCountAfter: 1,
          commandResults: edits.map((e: any) => ({
            type: e.type,
            objectId: e.objectId,
            pageIndex: 0,
            objectIndex: e.objectIndex,
            originalText: e.originalText,
            newText: e.newText ?? '',
            applied: true,
            verifiedInReopened: true,
            fontStrategy: '',
            fontReused: false,
            error: '',
          })),
        });
      }),
      purgeRenderCache: jest.fn(async () => 0),
    };
    return { files, batches };
  }

  afterEach(() => {
    delete (NativeModules as any).PdfiumNativeModule;
  });

  it('replaces and deletes in ONE native batch with reflow, as one undo step', async () => {
    const { files, batches } = installNative(['Summer', 'internship', 'report']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);

    await editor.applyTextRangeEdit(
      [
        { objectId: 'p0_path0', newText: 'Su' },
        { objectId: 'p0_path1', newText: null },
        { objectId: 'p0_path2', newText: 'port' },
      ],
      W(1),
    );

    expect(batches).toHaveLength(1);
    expect(batches[0].map((e: any) => [e.type, e.reflow])).toEqual([
      ['replace', true],
      ['delete', true],
      ['replace', true],
    ]);
    expect(files.get(W(1))).toEqual(['Su', null, 'port']);
    expect(files.get(SOURCE)).toEqual(['Summer', 'internship', 'report']); // source untouched
    expect((await editor.getTextObjects(0)).map((o) => o.text)).toEqual(['Su', 'port']);

    await editor.undo();
    expect((await editor.getTextObjects(0)).map((o) => o.text)).toEqual(['Summer', 'internship', 'report']);
    expect(editor.canUndo()).toBe(false);
  });

  it('formatting goes only to the object that receives the new text', async () => {
    const { batches } = installNative(['A', 'B']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);
    await editor.applyTextRangeEdit(
      [
        { objectId: 'p0_path0', newText: 'X' },
        { objectId: 'p0_path1', newText: 'Y' },
      ],
      W(1),
      { fontSize: 14 },
    );
    expect(batches[0][0].format).toEqual({ fontSize: 14 });
    expect(batches[0][1].format).toBeUndefined();
  });

  it('nothing is applied when any object is unknown', async () => {
    const { batches } = installNative(['A']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);
    await expect(editor.applyTextRangeEdit([{ objectId: 'p0_nope', newText: null }], W(1))).rejects.toThrow(/Unknown text object/);
    expect(batches).toHaveLength(0);
  });
});

describe('QA19 edit panel for a partial selection', () => {
  it('starts from the selected text and sends only the text when formatting is locked', () => {
    const onApply = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <PdfTextEditModal
          visible
          targetObject={obj('p0_path1', 'internship', 92)}
          initialText="inter"
          formatLockedReason="Only the text changes when part of a word is selected."
          onApply={onApply}
          onCancel={jest.fn()}
        />,
      );
    });
    const input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('inter');
    const texts = tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(''));
    expect(texts.some((t) => t.includes('Only the text changes'))).toBe(true);
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Bold' && typeof n.props.onPress === 'function')).toHaveLength(0);
    act(() => input.props.onChangeText('extern'));
    act(() => tree.root.find((n) => n.props.accessibilityLabel === 'Done' && typeof n.props.onPress === 'function').props.onPress());
    expect(onApply).toHaveBeenCalledWith('extern', {}, expect.anything());
  });
});

describe('QA19 settings', () => {
  it('remembers the selection tip', () => {
    expect(DEFAULT_SETTINGS.pdfSelectionTipSeen).toBe(false);
    expect(sanitizeSettings({ pdfSelectionTipSeen: true }).pdfSelectionTipSeen).toBe(true);
    expect(sanitizeSettings({ pdfSelectionTipSeen: 'yes' }).pdfSelectionTipSeen).toBe(false);
  });
});

describe('QA19 native fixes (source checks; behaviour verified on device with pie_cli)', () => {
  const bridge = read('android/app/src/main/cpp/pdfium/pdfium_bridge.cpp');

  it('edits inside Form XObjects are flattened into page content before editing', () => {
    expect(bridge).toMatch(/bool flattenRootForm\(FPDF_PAGE page, FPDF_PAGEOBJECT form/);
    expect(bridge).toContain('FPDFFormObj_RemoveObject');
    expect(bridge).toContain('FPDFPageObj_TransformClipPath');
    expect(bridge).toContain('FPDFPage_InsertObjectAtIndex');
  });

  it('replace / delete reflow the rest of the line, and characters are exported per page', () => {
    expect(bridge).toContain('pieFollowingRun');
    expect(bridge).toContain('pieShiftRun');
    expect(read('android/app/src/main/cpp/pdfium/pie_bridge_core.h')).toMatch(/cmd\.reflow = reflow->boolValue/);
    expect(bridge).toContain('std::string pageCharsJson(int64_t docHandle, int pageIndex)');
    expect(read('android/app/src/main/java/com/com.pdfimageeditor/pdf/NativePdfiumModule.kt')).toMatch(/fun getPageChars\(/);
    expect(read('ios/PieNative/PdfiumNativeModule.mm')).toMatch(/RCT_EXPORT_METHOD\(getPageChars/);
  });

  it('haptics use the vibrator with touch attributes (performHapticFeedback is only a fallback)', () => {
    const app = read('android/app/src/main/java/com/com.pdfimageeditor/app/PieAppModule.kt');
    expect(app).toContain('VibrationEffect.createPredefined');
    expect(app).toContain('EFFECT_TICK');
    expect(app).toContain('performHapticFeedback');
    expect(read('android/app/src/main/AndroidManifest.xml')).toContain('android.permission.VIBRATE');
  });

  it('the PDF screen uses long press + handles and no longer offers Select Line / Word', () => {
    const screen = read('src/screens/PdfEditorScreen.tsx');
    expect(screen).toContain('onLongPressDoc={charMode ? handleLongPressDoc : undefined}');
    expect(screen).toContain('selectionHandles={selectionHandles}');
    expect(screen).not.toMatch(/Select Line|Select Word|findTextLine/);
  });
});
