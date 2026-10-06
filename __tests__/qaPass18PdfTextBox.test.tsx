/**
 * QA pass 18 — PDF Add Text as movable / resizable text boxes, standard font family mapping,
 * baseline-aware underline / strikethrough, and inline markup colours.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules, TextInput } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import {
  DEFAULT_PDF_TEXT_STYLE,
  PdfTextBoxDraft,
  clampDraftToPage,
  displayBaselineY,
  draftForRect,
  draftFromTextObject,
  effectiveFontSize,
  isMovableTextObject,
  layoutPdfTextBox,
  standardFontFamily,
  standardTextWidth,
  textBoxLines,
  textBoxRect,
  unsupportedTextBoxChars,
} from '../src/features/pdf/pdfTextBox';
import { resolveStandardFontName, PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { markRectsForStyle, textMarkOperation } from '../src/features/pdf/pdfTextSelection';
import { rotationDisplayMatrix } from '../src/features/pdf/pdfPageGeometry';
import { PdfTextObject } from '../src/features/pdf/types';
import { PdfTextEditModal } from '../src/features/pdf/components/PdfTextEditModal';
import { EditMenu } from '../src/ui/EditMenu';

const PAGE = rotationDisplayMatrix(0, { left: 0, bottom: 0, width: 612, height: 792 });

const obj = (text: string, extra: Partial<PdfTextObject> = {}): PdfTextObject => ({
  id: `p0_${text}`,
  pageIndex: 0,
  objectIndex: 0,
  objectPath: [0],
  text,
  bounds: { x: 72, y: 100, width: 60, height: 16.4 },
  pdfBounds: { left: 72, bottom: 675.6, right: 132, top: 692 },
  fontSize: 14,
  fontName: 'Helvetica',
  color: '#000000',
  colorRgba: null,
  // baseline at display y = 792 - 680 = 112
  matrix: { a: 1, b: 0, c: 0, d: 1, e: 72, f: 680 },
  fontDetails: { baseFontName: 'Helvetica', familyName: 'Helvetica', isEmbedded: false, isSubset: false, weight: 400, flags: 0 },
  isEditable: true,
  ...extra,
});

const findPressable = (root: ReactTestRenderer.ReactTestInstance, label: string) =>
  root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');

// ---------------------------------------------------------------------------
// Font families (Serif / Mono used to produce Helvetica; "sans-serif" could become Times)
// ---------------------------------------------------------------------------

describe('QA18 standard font families', () => {
  it('maps UI and PDF family names to the standard-14 families', () => {
    expect(standardFontFamily('sans-serif')).toBe('Helvetica');
    expect(standardFontFamily('serif')).toBe('Times-Roman');
    expect(standardFontFamily('monospace')).toBe('Courier');
    expect(standardFontFamily('TimesNewRomanPSMT')).toBe('Times-Roman');
    expect(standardFontFamily('ABCDEF+OpenSans')).toBe('Helvetica');
  });

  it('resolves the standard font name for the panel family values', () => {
    expect(resolveStandardFontName({ fontFamily: 'serif', isBold: true })).toBe('Times-Bold');
    expect(resolveStandardFontName({ fontFamily: 'monospace', isItalic: true })).toBe('Courier-Oblique');
    expect(resolveStandardFontName({ fontFamily: 'sans-serif', isBold: true, isItalic: true })).toBe('Helvetica-BoldOblique');
    expect(resolveStandardFontName({ fontFamily: 'Times-Roman' })).toBe('Times-Roman');
  });
});

// ---------------------------------------------------------------------------
// Text box layout
// ---------------------------------------------------------------------------

describe('QA18 text box layout', () => {
  const draft = (text: string, alignment: 'left' | 'center' | 'right' = 'left'): PdfTextBoxDraft => ({
    text,
    style: { ...DEFAULT_PDF_TEXT_STYLE, fontSize: 10, alignment },
    origin: { x: 100, y: 200 },
  });

  it('measures with the standard-14 metrics', () => {
    expect(standardTextWidth('Hello', 'Helvetica', 10)).toBeCloseTo(22.78, 5);
    expect(standardTextWidth('abc', 'Courier', 12)).toBeCloseTo(21.6, 5);
    expect(standardTextWidth('A', 'Times-Roman', 10, true)).toBeCloseTo(7.22, 5);
  });

  it('keeps explicit lines (outer blank lines dropped) one line height apart', () => {
    expect(textBoxLines('\n  Line one  \nLine two\n\n')).toEqual(['  Line one', 'Line two']);
    const layout = layoutPdfTextBox(draft('Line one\nLine two'));
    expect(layout.lines.map((l) => [l.text, l.y])).toEqual([
      ['Line one', 200],
      ['Line two', 212],
    ]);
  });

  it('aligns lines inside the box (centre / right)', () => {
    const centred = layoutPdfTextBox(draft('Wide line here\nab', 'center'));
    const [wide, short] = centred.lines;
    expect(wide.x).toBe(100);
    expect(short.x + short.width / 2).toBeCloseTo(wide.x + wide.width / 2, 6);
    const right = layoutPdfTextBox(draft('Wide line here\nab', 'right'));
    expect(right.lines[1].x + right.lines[1].width).toBeCloseTo(100 + right.width, 6);
  });

  it('pinch: the font size follows the box height; drag moves the origin; the box stays on the page', () => {
    const d = draft('Hello');
    const r = textBoxRect(d);
    const bigger = draftForRect(d, { x: 50, y: 60, width: r.width * 2, height: r.height * 2 });
    expect(bigger.style.fontSize).toBe(20);
    expect(bigger.origin).toEqual({ x: 50, y: 60 });
    const huge = draftForRect(d, { x: 0, y: 0, width: r.width * 50, height: r.height * 50 });
    expect(huge.style.fontSize).toBe(96);
    const clamped = clampDraftToPage({ ...d, origin: { x: 600, y: -20 } }, { width: 612, height: 792 });
    expect(clamped.origin.y).toBe(0);
    expect(clamped.origin.x + textBoxRect(clamped).width).toBeLessThanOrEqual(612);
  });

  it('reports characters the standard fonts cannot draw before anything is written', () => {
    expect(unsupportedTextBoxChars('Total ₹ 500')).toEqual(['₹']);
    expect(unsupportedTextBoxChars('Total € 500 – café')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Existing text: move / resize eligibility, baseline
// ---------------------------------------------------------------------------

describe('QA18 move / resize of existing standard-font text', () => {
  it('only top-level, upright, standard non-embedded fonts are movable', () => {
    expect(isMovableTextObject(obj('Hello'))).toBe(true);
    expect(isMovableTextObject(obj('Hello', { fontName: 'Times-Bold' }))).toBe(true);
    expect(isMovableTextObject(obj('Hello', { fontDetails: { baseFontName: 'X', familyName: 'Arial', isEmbedded: true, isSubset: true, weight: 400, flags: 0 }, fontName: 'ABCDEF+ArialMT' }))).toBe(false);
    expect(isMovableTextObject(obj('Hello', { objectPath: [2, 0] }))).toBe(false);
    expect(isMovableTextObject(obj('Hello', { matrix: { a: 0, b: 1, c: -1, d: 0, e: 72, f: 680 } }))).toBe(false);
    expect(isMovableTextObject(obj('₹ 500'))).toBe(false);
  });

  it('derives the baseline from the text matrix and rebuilds an equivalent draft', () => {
    const o = obj('Hello', { fontName: 'Helvetica-Bold' });
    expect(displayBaselineY(o, PAGE)).toBe(112);
    const d = draftFromTextObject(o, PAGE)!;
    expect(d.style).toMatchObject({ fontFamily: 'Helvetica', isBold: true, fontSize: 14 });
    // Re-inserted with its baseline exactly where it was (top-left = baseline - size)
    expect(d.origin).toEqual({ x: 72, y: 112 - 14 });
  });

  it('a baseline inconsistent with the glyph box is not trusted', () => {
    expect(displayBaselineY(obj('Hello', { matrix: { a: 1, b: 0, c: 0, d: 1, e: 72, f: 300 } }), PAGE)).toBeNull();
    expect(displayBaselineY(obj('Hello', { objectPath: [1, 0] }), PAGE)).toBeNull();
  });

  it('effective size includes the text-matrix scale (Tf 1 scaled to 12 pt)', () => {
    expect(effectiveFontSize(obj('x', { fontSize: 1, matrix: { a: 12, b: 0, c: 0, d: 12, e: 0, f: 0 } }))).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Underline / strikethrough placement
// ---------------------------------------------------------------------------

describe('QA18 baseline-aware markup', () => {
  const word = obj('Hello');
  const baselineOf = (o: PdfTextObject) => displayBaselineY(o, PAGE);

  it('underline lands just below the baseline (native draws at y + h - w/2)', () => {
    const [r] = markRectsForStyle('underline', [word], baselineOf);
    const em = word.bounds.height / 1.17;
    const lineW = Math.max(0.75, r.height * 0.07);
    const drawnAt = r.y + r.height - lineW / 2;
    expect(drawnAt).toBeCloseTo(112 + em * 0.1, 6);
    expect(r.x).toBe(72);
    expect(r.width).toBe(60);
  });

  it('strikethrough crosses the lower-case letters (native draws at y + 0.55h)', () => {
    const [r] = markRectsForStyle('strikeout', [word], baselineOf);
    const em = word.bounds.height / 1.17;
    expect(r.y + r.height * 0.55).toBeCloseTo(112 - em * 0.3, 6);
  });

  it('without a reliable baseline the glyph box is used (previous behaviour)', () => {
    const near = (r: { x: number; y: number; width: number; height: number }) => {
      expect(r.x).toBeCloseTo(word.bounds.x, 6);
      expect(r.y).toBeCloseTo(word.bounds.y, 6);
      expect(r.width).toBeCloseTo(word.bounds.width, 6);
      expect(r.height).toBeCloseTo(word.bounds.height, 6);
    };
    near(markRectsForStyle('underline', [word])[0]);
    near(markRectsForStyle('highlight', [word], baselineOf)[0]);
    const op = textMarkOperation('underline', 0, [word], '#34C759', baselineOf);
    expect(op.type === 'addHighlight' && op.color).toBe('#34C759');
  });
});

// ---------------------------------------------------------------------------
// Editor: one batch, one undo step
// ---------------------------------------------------------------------------

describe('QA18 PdfDocumentEditor.applyTextBoxInsertion', () => {
  const SOURCE = '/app/files/pie/documents/pdf-1/source.pdf';
  const W = (n: number) => `/app/files/pie/sessions/pdf-1/working/working_${n}.pdf`;

  function installNative(initial: string[]) {
    const files = new Map<string, string[]>([[SOURCE, initial]]);
    const handles = new Map<number, string>();
    let next = 1;
    const batches: any[][] = [];
    const objects = (texts: string[]) =>
      texts.map((t, i) => ({ ...obj(t), id: `p0_path${i}`, objectIndex: i, objectPath: [i], bounds: { x: 72, y: 100 + i * 20, width: 60, height: 16 } }));
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (path: string) => {
        const h = next++;
        handles.set(h, path);
        return { docHandle: h, pageCount: 1, filePath: path, fileSizeBytes: 100 };
      }),
      closeDocument: jest.fn(async () => true),
      getPageCount: jest.fn(async () => 1),
      getPageSize: jest.fn(async () => ({ pageIndex: 0, width: 612, height: 792 })),
      getTextObjects: jest.fn(async (h: number) => JSON.stringify(objects(files.get(handles.get(h)!)!))),
      applyBatchEdits: jest.fn(async (input: string, output: string, editsJson: string) => {
        const edits = JSON.parse(editsJson);
        batches.push(edits);
        const removed = new Set(edits.filter((e: any) => e.type === 'delete').map((e: any) => e.objectPath[0]));
        const kept = files.get(input)!.filter((_, i) => !removed.has(i));
        files.set(output, [...kept, ...edits.filter((e: any) => e.type === 'insert').map((e: any) => e.text)]);
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
            objectIndex: e.objectIndex ?? 0,
            originalText: e.originalText ?? '',
            newText: e.text ?? '',
            applied: true,
            verifiedInReopened: true,
            fontStrategy: e.type === 'insert' ? 'LOADED_STANDARD' : '',
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

  it('writes every line of a text box in one batch (one undo step) with the chosen standard font', async () => {
    const { files, batches } = installNative(['Existing']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);

    const { insertedObjects } = await editor.applyTextBoxInsertion(
      0,
      [
        { text: 'First line', position: { x: 100, y: 200 } },
        { text: '   ', position: { x: 100, y: 212 } },
        { text: 'Second line', position: { x: 100, y: 224 } },
      ],
      W(1),
      { fontFamily: 'Times-Roman', fontSize: 10, isBold: true, color: '#007AFF' },
    );

    expect(batches).toHaveLength(1);
    expect(batches[0].map((e: any) => [e.type, e.text, e.fontName, e.fontSize])).toEqual([
      ['insert', 'First line', 'Times-Bold', 10],
      ['insert', 'Second line', 'Times-Bold', 10],
    ]);
    // Baselines: display y + size -> PDF y = 792 - (y + size)
    expect(batches[0][0].y).toBe(792 - 210);
    expect(batches[0][1].y).toBe(792 - 234);
    expect(files.get(W(1))).toEqual(['Existing', 'First line', 'Second line']);
    expect(insertedObjects.map((o) => o.text)).toEqual(['First line', 'Second line']);

    await editor.undo();
    expect((await editor.getTextObjects(0)).map((o) => o.text)).toEqual(['Existing']);
    expect(editor.canUndo()).toBe(false);
  });

  it('Move: deletes the original and re-inserts it in the same batch', async () => {
    const { files, batches } = installNative(['Keep', 'Hello']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);

    await editor.applyTextBoxInsertion(0, [{ text: 'Hello', position: { x: 300, y: 400 } }], W(1), { fontFamily: 'Helvetica', fontSize: 14 }, ['p0_path1']);

    expect(batches).toHaveLength(1);
    expect(batches[0].map((e: any) => e.type)).toEqual(['delete', 'insert']);
    expect(files.get(W(1))).toEqual(['Keep', 'Hello']);
    expect(files.get(SOURCE)).toEqual(['Keep', 'Hello']); // source untouched
  });

  it('refuses characters the standard fonts cannot draw (nothing applied)', async () => {
    const { batches } = installNative(['A']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);
    await expect(editor.applyTextBoxInsertion(0, [{ text: 'Price ₹', position: { x: 10, y: 10 } }], W(1))).rejects.toThrow();
    expect(batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edit panel + inline colour row
// ---------------------------------------------------------------------------

describe('QA18 PDF Edit Text panel', () => {
  it('Add Text: Serif + centre alignment keep the lines and send Times', () => {
    const onApply = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal visible isInsertMode targetObject={null} onApply={onApply} onCancel={jest.fn()} />);
    });
    act(() => tree.root.findByType(TextInput).props.onChangeText('Line one\nLine two'));
    act(() => tree.root.find((n) => n.props.accessibilityLabel === 'Serif' && typeof n.props.onPress === 'function').props.onPress());
    act(() => findPressable(tree.root, 'Align Center').props.onPress());
    act(() => findPressable(tree.root, 'Add').props.onPress());
    expect(onApply).toHaveBeenCalledWith(
      'Line one\nLine two',
      expect.objectContaining({ fontFamily: 'Times-Roman' }),
      expect.objectContaining({ alignment: 'center', style: expect.objectContaining({ fontFamily: 'Times-Roman', alignment: 'center' }) }),
    );
  });

  it('re-editing a text box starts from its text and style', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    const draft = { text: 'Draft', style: { ...DEFAULT_PDF_TEXT_STYLE, fontFamily: 'Courier' as const, fontSize: 20 } };
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal visible isInsertMode draft={draft} targetObject={null} onApply={jest.fn()} onCancel={jest.fn()} />);
    });
    expect(tree.root.findByType(TextInput).props.value).toBe('Draft');
    expect(findPressable(tree.root, 'Done')).toBeTruthy();
  });

  it('Edit: an untouched style is not sent (the original font is kept)', () => {
    const onApply = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal visible targetObject={obj('Hello')} onApply={onApply} onCancel={jest.fn()} />);
    });
    act(() => tree.root.findByType(TextInput).props.onChangeText('Hello\nworld'));
    act(() => findPressable(tree.root, 'Done').props.onPress());
    const [text, format] = onApply.mock.calls[0];
    expect(text).toBe('Hello world');
    expect(format).toEqual({ color: '#000000', fontSize: 14 });
  });

  it('Edit: the visible size is shown and changes scale the font size (Tf 1 x matrix 12)', () => {
    const onApply = jest.fn();
    const scaled = obj('Hello', { fontSize: 1, matrix: { a: 12, b: 0, c: 0, d: 12, e: 72, f: 680 } });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal visible targetObject={scaled} onApply={onApply} onCancel={jest.fn()} />);
    });
    expect(findPressable(tree.root, '12 pt')).toBeTruthy();
    act(() => findPressable(tree.root, 'Larger').props.onPress());
    act(() => findPressable(tree.root, 'Done').props.onPress());
    expect(onApply.mock.calls[0][1].fontSize).toBeCloseTo(13 / 12, 2);
  });

  it('typing is not reset by re-renders of the parent', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    const props = { visible: true, isInsertMode: true, targetObject: null, onApply: jest.fn(), onCancel: jest.fn() };
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal {...props} draft={{ text: '', style: DEFAULT_PDF_TEXT_STYLE }} />);
    });
    act(() => tree.root.findByType(TextInput).props.onChangeText('typed'));
    act(() => tree.update(<PdfTextEditModal {...props} draft={{ text: '', style: DEFAULT_PDF_TEXT_STYLE }} />));
    expect(tree.root.findByType(TextInput).props.value).toBe('typed');
  });
});

describe('QA18 inline markup colour row', () => {
  it('shows the swatches for the chosen style and applies the picked colour', () => {
    const onPick = jest.fn();
    const onBack = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <EditMenu
          items={[{ key: 'x', label: 'Hidden', onPress: jest.fn() }]}
          onClose={jest.fn()}
          colorChooser={{ label: 'Underline', colors: ['#007AFF', '#FF3B30'], value: '#007AFF', onPick, onBack }}
        />,
      );
    });
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Hidden')).toHaveLength(0);
    act(() => findPressable(tree.root, 'Underline #FF3B30').props.onPress());
    expect(onPick).toHaveBeenCalledWith('#FF3B30');
    act(() => findPressable(tree.root, 'Back to actions').props.onPress());
    expect(onBack).toHaveBeenCalled();
  });
});
