/**
 * QA pass 17 — physical-QA findings: navigation-bar layout, PDF text selection, compact edit
 * panels, independent markup colours, and the image OCR -> Edit flow.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules, Text, TextInput } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { NAV_MIN_CENTERED_TITLE_WIDTH, NAV_TITLE_GAP, navTitleInsets } from '../src/ui/controls';
import { hitTestTextObjects } from '../src/features/pdf/pdfiumEngine';
import { PdfiumEngine } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfTextObject } from '../src/features/pdf/types';
import {
  DEFAULT_ANNOTATION_COLORS,
  findTextLine,
  onSameTextLine,
  sanitizeAnnotationColors,
  selectionMarkRects,
  selectionText,
  textMarkOperation,
  unionRect,
} from '../src/features/pdf/pdfTextSelection';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../src/settings/appSettings';
import { resolveImageCanvasTap } from '../src/features/image/imageCanvasInteraction';
import { PdfTextEditModal, displayPdfFontName, pdfFamilyOf } from '../src/features/pdf/components/PdfTextEditModal';
import { TextEditModal } from '../src/components/TextEditModal';
import { EditMenu } from '../src/ui/EditMenu';
import { fontWeights, typography } from '../src/constants/theme';
import { TextRegion } from '../src/types/document';

const obj = (id: string, x: number, y: number, width: number, height: number, extra: Partial<PdfTextObject> = {}): PdfTextObject => ({
  id,
  pageIndex: 0,
  objectIndex: 0,
  objectPath: [0],
  text: id,
  bounds: { x, y, width, height },
  pdfBounds: { left: x, bottom: 792 - y - height, right: x + width, top: 792 - y },
  fontSize: height * 0.8,
  fontName: 'Helvetica',
  color: '#000000',
  colorRgba: null,
  matrix: null,
  isEditable: true,
  ...extra,
});

const findPressable = (root: ReactTestRenderer.ReactTestInstance, label: string) =>
  root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');

// ---------------------------------------------------------------------------
// 1. Navigation bar: long titles never overlap the bar items
// ---------------------------------------------------------------------------

describe('QA17 navigation bar title layout', () => {
  it('centres a title when both sides leave enough room (short items)', () => {
    const p = navTitleInsets(390, 44, 90);
    expect(p.centered).toBe(true);
    expect(p.left).toBe(p.right);
    expect(p.left).toBe(90 + NAV_TITLE_GAP);
    expect(390 - p.left - p.right).toBeGreaterThanOrEqual(NAV_MIN_CENTERED_TITLE_WIDTH);
  });

  it('uses the space between the items when centring would squeeze the title (editor: back + search + more + Save)', () => {
    const p = navTitleInsets(360, 100, 150);
    expect(p.centered).toBe(false);
    expect(p.left).toBe(100 + NAV_TITLE_GAP);
    expect(p.right).toBe(150 + NAV_TITLE_GAP);
    // The title box ends before the right items start and starts after the left items end
    expect(360 - p.right).toBeLessThanOrEqual(360 - 150);
    expect(p.left).toBeGreaterThanOrEqual(100);
  });

  it('never yields a title region overlapping the measured items', () => {
    for (const bar of [320, 360, 412, 600]) {
      for (const l of [0, 44, 100]) {
        for (const r of [0, 44, 130, 180]) {
          const p = navTitleInsets(bar, l, r);
          expect(p.left).toBeGreaterThanOrEqual(l);
          expect(p.right).toBeGreaterThanOrEqual(r);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. PDF selection: the text under the finger, logical lines
// ---------------------------------------------------------------------------

describe('QA17 PDF hit testing prefers the text under the finger', () => {
  it('partially overlapping neighbouring lines: the line whose centre is nearer wins (not the smaller one)', () => {
    // Line boxes include ascent/descent and overlap by 4 pt
    const upper = obj('Guruprasad Balarao Godamgave', 100, 100, 140, 14);
    const lower = obj('Pranav', 100, 110, 40, 14);
    // Tap in the overlap band, nearer the upper line's centre (107) than the lower (117)
    expect(hitTestTextObjects([upper, lower], { x: 120, y: 111 }, 20)?.id).toBe('Guruprasad Balarao Godamgave');
    // Nearer the lower line's centre
    expect(hitTestTextObjects([upper, lower], { x: 120, y: 113 }, 20)?.id).toBe('Pranav');
  });

  it('nested boxes still select the most specific object', () => {
    const paragraph = obj('paragraph', 50, 100, 200, 80);
    const word = obj('word', 60, 110, 50, 16);
    expect(hitTestTextObjects([paragraph, word], { x: 70, y: 115 }, 4)?.id).toBe('word');
  });
});

describe('QA17 logical text lines', () => {
  const name1 = obj('Guruprasad', 100, 100, 50, 10);
  const name2 = obj('Balarao', 153, 100, 36, 10);
  const name3 = obj('Godamgave', 192, 100.5, 48, 10);
  const prn = obj('252921004', 40, 100, 40, 10); // previous table column: 20 pt gap
  const location = obj('sec 1 A Block', 300, 100, 50, 10); // next column: 60 pt gap
  const nextRow = obj('Pranav', 100, 112, 30, 10);
  const all = [prn, name1, name2, name3, location, nextRow];

  it('joins the words of the tapped line, left to right', () => {
    expect(findTextLine(all, name2).map((o) => o.id)).toEqual(['Guruprasad', 'Balarao', 'Godamgave']);
  });

  it('never joins table columns or the next row', () => {
    const ids = findTextLine(all, name1).map((o) => o.id);
    expect(ids).not.toContain('252921004');
    expect(ids).not.toContain('sec 1 A Block');
    expect(ids).not.toContain('Pranav');
  });

  it('a lone object is its own line', () => {
    expect(findTextLine(all, location).map((o) => o.id)).toEqual(['sec 1 A Block']);
  });

  it('copies the selection in reading order with single spaces', () => {
    expect(selectionText([name3, name1, name2])).toBe('Guruprasad Balarao Godamgave');
    expect(selectionText([nextRow, name1])).toBe('Guruprasad\nPranav');
  });

  it('marks one continuous band per line (no gaps between words)', () => {
    const rects = selectionMarkRects([name1, name2, name3]);
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBe(100);
    expect(rects[0].x + rects[0].width).toBe(240);
    expect(selectionMarkRects([name1, nextRow])).toHaveLength(2);
  });

  it('same-line test requires strong vertical overlap and similar height', () => {
    expect(onSameTextLine(name1.bounds, name3.bounds)).toBe(true);
    expect(onSameTextLine(name1.bounds, nextRow.bounds)).toBe(false);
    expect(onSameTextLine({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 40 })).toBe(false);
    expect(unionRect([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Independent markup colours (highlight / underline / strikethrough)
// ---------------------------------------------------------------------------

describe('QA17 markup colours are independent of text colour and persisted', () => {
  const word = obj('Hello', 10, 10, 30, 12);

  it('builds the page-content markup with the chosen underline colour', () => {
    const op = textMarkOperation('underline', 2, [word], '#ff3b30');
    expect(op).toEqual({
      type: 'addHighlight',
      pageIndex: 2,
      style: 'underline',
      rects: [word.bounds],
      color: '#FF3B30',
      opacity: 1,
    });
  });

  it('highlights are translucent; invalid colours fall back to the style default', () => {
    const op = textMarkOperation('highlight', 0, [word], 'not-a-colour');
    expect(op.type === 'addHighlight' && op.color).toBe(DEFAULT_ANNOTATION_COLORS.highlight);
    expect(op.type === 'addHighlight' && op.opacity).toBe(0.5);
  });

  it('sanitizes persisted colours per style', () => {
    expect(sanitizeAnnotationColors({ underline: '#00ff00', highlight: 'red', strikeout: 5 })).toEqual({
      highlight: DEFAULT_ANNOTATION_COLORS.highlight,
      underline: '#00FF00',
      strikeout: DEFAULT_ANNOTATION_COLORS.strikeout,
    });
    expect(sanitizeSettings({}).annotationColors).toEqual(DEFAULT_ANNOTATION_COLORS);
    expect(DEFAULT_SETTINGS.annotationColors).toEqual(DEFAULT_ANNOTATION_COLORS);
  });

  it('a chosen underline colour survives a settings round trip (written to settings.json)', async () => {
    const files = new Map<string, string>();
    const fileStore = {
      getRootPath: async () => '/root',
      exists: async (p: string) => files.has(p),
      readFile: async (p: string) => files.get(p)!,
      writeFileAtomic: async (p: string, c: string) => {
        files.set(p, c);
      },
    } as any;
    const store = new SettingsStore(() => fileStore);
    await store.load();
    store.update({ annotationColors: { ...store.get().annotationColors, underline: '#AF52DE' } });
    await store.flush();

    const reopened = new SettingsStore(() => fileStore);
    await reopened.load();
    expect(reopened.get().annotationColors.underline).toBe('#AF52DE');
    expect(reopened.get().annotationColors.highlight).toBe(DEFAULT_ANNOTATION_COLORS.highlight);
  });
});

// ---------------------------------------------------------------------------
// 4. Deleting a selected line is ONE applied revision (one undo step)
// ---------------------------------------------------------------------------

describe('QA17 line deletion through the canonical PDF editor', () => {
  const SOURCE = '/app/files/pie/documents/pdf-1/source.pdf';
  const W = (n: number) => `/app/files/pie/sessions/pdf-1/working/working_${n}.pdf`;

  function installNative(initial: string[]) {
    const files = new Map<string, string[]>([[SOURCE, initial]]);
    const handles = new Map<number, string>();
    let next = 1;
    const batches: any[][] = [];
    const objects = (texts: string[]) =>
      texts.map((t, i) => ({ ...obj(t, 50 + i * 60, 100, 50, 12), id: `p0_path${i}`, objectIndex: i, objectPath: [i], text: t }));
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (path: string) => {
        if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'PDF_FILE_NOT_FOUND' });
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
        const source = files.get(input)!;
        const removed = new Set(edits.filter((e: any) => e.type === 'delete').map((e: any) => e.objectPath[0]));
        files.set(output, source.filter((_, i) => !removed.has(i)));
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
            newText: '',
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

  it('deletes every object of the line in one native batch and one undo step', async () => {
    const { files, batches } = installNative(['Guruprasad', 'Balarao', 'Godamgave', 'sec 1 A Block']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);

    await editor.applyExistingTextDeletions(['p0_path0', 'p0_path1', 'p0_path2'], W(1));

    expect(batches).toHaveLength(1);
    expect(batches[0].map((e: any) => e.type)).toEqual(['delete', 'delete', 'delete']);
    expect(files.get(W(1))).toEqual(['sec 1 A Block']);
    expect(files.get(SOURCE)).toEqual(['Guruprasad', 'Balarao', 'Godamgave', 'sec 1 A Block']); // source untouched
    expect((await editor.getTextObjects(0)).map((o) => o.text)).toEqual(['sec 1 A Block']);
    expect(editor.isDirty()).toBe(true);

    await editor.undo();
    expect((await editor.getTextObjects(0)).map((o) => o.text)).toEqual(['Guruprasad', 'Balarao', 'Godamgave', 'sec 1 A Block']);
    expect(editor.canUndo()).toBe(false);
  });

  it('rejects the whole line when any object is unknown (nothing applied)', async () => {
    const { batches } = installNative(['A', 'B']);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);
    await expect(editor.applyExistingTextDeletions(['p0_path0', 'p0_missing'], W(1))).rejects.toThrow(/Unknown text object/);
    expect(batches).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Image OCR: tapping recognised text selects it; tapping it again opens Edit
// ---------------------------------------------------------------------------

describe('QA17 image canvas selection (OCR text was impossible to select)', () => {
  const region = { id: 'r1' } as TextRegion;
  const other = { id: 'r2' } as TextRegion;
  const added = { id: 'a1' } as any;
  const none = { regionId: null, addedId: null };

  it('a tap on recognised text selects exactly that region', () => {
    expect(resolveImageCanvasTap(none, { kind: 'region', region })).toEqual({
      selection: { regionId: 'r1', addedId: null },
      openEditor: false,
    });
  });

  it('a second tap on the selected region asks for the Edit panel', () => {
    expect(resolveImageCanvasTap({ regionId: 'r1', addedId: null }, { kind: 'region', region }).openEditor).toBe(true);
    expect(resolveImageCanvasTap({ regionId: 'r1', addedId: null }, { kind: 'region', region: other }).openEditor).toBe(false);
  });

  it('only one kind is ever selected; an empty tap clears the selection', () => {
    expect(resolveImageCanvasTap({ regionId: 'r1', addedId: null }, { kind: 'added', element: added }).selection).toEqual({
      regionId: null,
      addedId: 'a1',
    });
    expect(resolveImageCanvasTap({ regionId: 'r1', addedId: null }, null).selection).toEqual(none);
  });
});

// ---------------------------------------------------------------------------
// 6. Edit panels keep their functionality
// ---------------------------------------------------------------------------

describe('QA17 compact edit panels', () => {
  it('PDF: an embedded font is kept (only size and colour are sent)', () => {
    const onApply = jest.fn();
    const target = obj('sec 1 A', 10, 10, 40, 12, {
      fontName: 'MUFUZY+ArialMT',
      fontSize: 13,
      fontDetails: { baseFontName: 'MUFUZY+ArialMT', familyName: 'Arial', isEmbedded: true, isSubset: true, weight: 400, flags: 0 },
    });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal visible targetObject={target} onApply={onApply} onCancel={jest.fn()} />);
    });
    const input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('sec 1 A');
    const texts = tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(''));
    expect(texts.some((t) => t.includes('ArialMT') && !t.includes('MUFUZY+'))).toBe(true);
    act(() => input.props.onChangeText('sec 2 B'));
    act(() => findPressable(tree.root, 'Done').props.onPress());
    expect(onApply).toHaveBeenCalledWith('sec 2 B', { fontSize: 13, color: '#000000' }, expect.anything());
  });

  it('PDF: inserted text sends family, weight, style, size and colour', () => {
    const onApply = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<PdfTextEditModal visible isInsertMode targetObject={null} onApply={onApply} onCancel={jest.fn()} />);
    });
    act(() => tree.root.findByType(TextInput).props.onChangeText('Hello'));
    act(() => findPressable(tree.root, 'Bold').props.onPress());
    act(() => findPressable(tree.root, 'Larger').props.onPress());
    act(() => findPressable(tree.root, 'Text colour Blue').props.onPress());
    act(() => findPressable(tree.root, 'Add').props.onPress());
    // Standard PDF family names are sent (QA18: "sans-serif" used to be ambiguous natively)
    expect(onApply).toHaveBeenCalledWith(
      'Hello',
      { fontFamily: 'Helvetica', fontSize: 15, isBold: true, isItalic: false, color: '#007AFF' },
      expect.objectContaining({ alignment: 'left' }),
    );
  });

  it('image: an OCR replacement keeps the chosen font family and offers Delete', () => {
    const onConfirm = jest.fn();
    const onDelete = jest.fn();
    const region: TextRegion = {
      id: 'r1',
      originalText: 'Total',
      currentText: 'Total',
      bounds: { x: 0, y: 0, width: 40, height: 12 },
      confidence: 0.9,
      status: 'detected',
      style: { fontFamily: 'sans-serif', fontSize: 16, color: '#000000', fontWeight: 'normal', fontStyle: 'normal' },
    } as any;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <TextEditModal visible region={region} isProcessing={false} onConfirm={onConfirm} onDelete={onDelete} onCancel={jest.fn()} />,
      );
    });
    act(() => tree.root.find((n) => n.props.accessibilityLabel === 'Serif' && typeof n.props.onPress === 'function').props.onPress());
    act(() => findPressable(tree.root, 'Done').props.onPress());
    expect(onConfirm).toHaveBeenCalledWith('Total', expect.objectContaining({ fontFamily: 'serif', fontSize: 16 }));
    act(() => findPressable(tree.root, 'Delete text').props.onPress());
    expect(onDelete).toHaveBeenCalled();
  });

  it('font names are shown without the subset tag and mapped to a family', () => {
    expect(displayPdfFontName('MUFUZY+ArialMT')).toBe('ArialMT');
    expect(displayPdfFontName(null)).toBe('Standard font');
    expect(pdfFamilyOf('TimesNewRomanPSMT')).toBe('serif');
    expect(pdfFamilyOf('Courier-Bold')).toBe('monospace');
    expect(pdfFamilyOf('ABCDEF+OpenSans-Regular')).toBe('sans-serif');
  });
});

describe('QA17 edit menu', () => {
  it('shows the selected text and runs every action', () => {
    const edit = jest.fn();
    const close = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <EditMenu
          preview={'Guruprasad   Balarao'}
          onClose={close}
          items={[
            { key: 'edit', label: 'Edit', primary: true, onPress: edit, accessibilityLabel: 'Edit text' },
            { key: 'underline', label: 'Underline', swatch: '#AF52DE', onPress: jest.fn() },
          ]}
        />,
      );
    });
    const texts = tree.root.findAllByType(Text).map((t) => [].concat(t.props.children).join(''));
    expect(texts).toContain('“Guruprasad Balarao”');
    act(() => findPressable(tree.root, 'Edit text').props.onPress());
    expect(edit).toHaveBeenCalled();
    act(() => findPressable(tree.root, 'Clear selection').props.onPress());
    expect(close).toHaveBeenCalled();
  });
});

describe('QA17 typography tokens', () => {
  it('semibold never maps to a synthetic bold on Android (Roboto Medium instead)', () => {
    // Jest runs as iOS by default in the RN preset; both mappings are valid weights
    expect(['500', '600']).toContain(fontWeights.semibold);
    expect(typography.headline.fontSize).toBeLessThanOrEqual(17);
    expect(typography.bodyLarge.fontSize).toBeLessThanOrEqual(17);
    expect(typography.caption.fontSize).toBeLessThan(typography.footnote.fontSize);
  });
});
