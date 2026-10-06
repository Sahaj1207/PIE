/**
 * Phase 15 — glyph coverage safety: PDF edits never claim success for text the font cannot
 * draw (CJK / non-Latin in standard fonts, emoji, control characters, glyphs missing from the
 * original font). Latin editing keeps working.
 */
import { NativeModules } from 'react-native';
import {
  assertInsertableText,
  assertReplaceableText,
  describeChars,
  findUndrawableChars,
  findUnsupportedStandardFontChars,
  isWinAnsiEncodable,
  unsupportedGlyphsErrorFromNative,
} from '../src/features/pdf/pdfGlyphCoverage';
import { PdfiumEngine, nativeFailureToError } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfFontLimitationError, PdfUnsupportedGlyphsError } from '../src/errors';

describe('Phase 15 — glyph coverage helpers', () => {
  it('standard fonts cover ASCII, Latin-1 and the Windows-1252 extras only', () => {
    for (const ch of ['A', 'z', '0', ' ', '~', 'é', 'ü', 'ß', '€', '—', '™', '“', '”']) {
      expect(isWinAnsiEncodable(ch.codePointAt(0)!)).toBe(true);
    }
    for (const ch of ['東', 'Ж', 'क', 'ע', '😀', '\n', '\t']) {
      expect(isWinAnsiEncodable(ch.codePointAt(0)!)).toBe(false);
    }
  });

  it('lists distinct unsupported characters in order of appearance', () => {
    expect(findUnsupportedStandardFontChars('Total: 100 €')).toEqual([]);
    expect(findUnsupportedStandardFontChars('東京東 Ж 😀😀')).toEqual(['東', '京', 'Ж', '😀']);
    expect(findUndrawableChars('Line\nBreak 😀 東京')).toEqual(['\n', '😀']);
  });

  it('describes characters with code points for users', () => {
    expect(describeChars(['東', '😀', '\n'])).toBe("'東' (U+6771), '😀' (U+1F600), (U+000A)");
    expect(describeChars(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toMatch(/, …$/);
  });

  it('typed errors carry the offending characters', () => {
    try {
      assertInsertableText('Invoice 東京 😀');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfUnsupportedGlyphsError);
      expect(err).toBeInstanceOf(PdfFontLimitationError);
      expect((err as PdfUnsupportedGlyphsError).characters).toEqual(['東', '京', '😀']);
      expect((err as PdfUnsupportedGlyphsError).code).toBe('PDF_UNSUPPORTED_GLYPHS');
    }
    expect(() => assertInsertableText('Approved – Café 50€')).not.toThrow();
    expect(() => assertReplaceableText('東京 café')).not.toThrow(); // native checks the font
    expect(() => assertReplaceableText('Rocket 🚀')).toThrow(PdfUnsupportedGlyphsError);
    expect(() => assertReplaceableText('two\nlines')).toThrow(PdfUnsupportedGlyphsError);
  });

  it('maps native missing-glyph failures to the typed error', () => {
    const native =
      "UNSUPPORTED_GLYPHS: The original font (ABCDEF+Arial) cannot display '東' (U+6771), '京' (U+4EAC). The text was not changed.";
    const err = unsupportedGlyphsErrorFromNative(native)!;
    expect(err).toBeInstanceOf(PdfUnsupportedGlyphsError);
    expect(err.characters).toEqual(['東', '京']);
    expect(err.message).toMatch(/^The original font/);
    expect(unsupportedGlyphsErrorFromNative('Object locator path could not be resolved')).toBeNull();

    const single = nativeFailureToError('UNSUPPORTED_GLYPHS', native);
    expect(single).toBeInstanceOf(PdfUnsupportedGlyphsError);
  });
});

describe('Phase 15 — editor never queues or applies undrawable text', () => {
  const SOURCE = '/data/files/pie/documents/pdf-g/source.pdf';
  const W = (n: number) => `/data/files/pie/sessions/pdf-g/working/working_${n}.pdf`;
  let nativeFailure: string | null = null;

  function install() {
    nativeFailure = null;
    const files = new Map<string, string[]>([[SOURCE, ['Header', 'Body']]]);
    let handle = 1;
    const handles = new Map<number, string>();
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (path: string) => {
        const h = handle++;
        handles.set(h, path);
        return { docHandle: h, pageCount: 1, filePath: path };
      }),
      closeDocument: jest.fn(async () => true),
      getPageSize: jest.fn(async (_h: number, pageIndex: number) => ({ pageIndex, width: 612, height: 792 })),
      getTextObjects: jest.fn(async (h: number) =>
        JSON.stringify(
          files.get(handles.get(h)!)!.map((text, i) => ({
            id: `p0_path${i}`, pageIndex: 0, objectIndex: i, objectPath: [i], text,
            bounds: { x: 50, y: 60 + 30 * i, width: 120, height: 16 },
            pdfBounds: { left: 50, bottom: 716 - 30 * i, right: 170, top: 732 - 30 * i },
            fontSize: 12, fontName: 'ABCDEF+Arial', color: '#000000',
            colorRgba: { r: 0, g: 0, b: 0, a: 255 },
            matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 716 - 30 * i }, isEditable: true,
          })),
        ),
      ),
      applyBatchEdits: jest.fn(async (input: string, output: string, json: string) => {
        const edits = JSON.parse(json);
        const texts = [...files.get(input)!];
        const results = edits.map((c: any) => {
          if (nativeFailure) {
            return { type: c.type, objectId: c.objectId, pageIndex: 0, objectIndex: c.objectIndex ?? 0, originalText: '', newText: c.newText ?? c.text ?? '', applied: false, verifiedInReopened: false, verificationError: '', fontStrategy: '', fontReused: false, error: nativeFailure };
          }
          if (c.type === 'replace') texts[c.objectIndex] = c.newText;
          if (c.type === 'insert') texts.push(c.text);
          return { type: c.type, objectId: c.objectId, pageIndex: 0, objectIndex: c.objectIndex ?? 0, originalText: '', newText: c.newText ?? c.text, applied: true, verifiedInReopened: true, verificationError: '', fontStrategy: 'REUSED_ORIGINAL', fontReused: true, error: '' };
        });
        files.set(output, texts);
        return JSON.stringify({ success: true, inputPath: input, outputPath: output, commandsApplied: edits.length, sourceUnchanged: true, sourceShaBefore: 's', sourceShaAfter: 's', pageCountBefore: 1, pageCountAfter: 1, commandResults: results });
      }),
    };
    return files;
  }

  afterEach(() => {
    delete (NativeModules as any).PdfiumNativeModule;
  });

  async function openEditor() {
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open(SOURCE);
    await editor.getTextObjects(0);
    return editor;
  }

  it('refuses CJK / emoji inserts (standard fonts) before anything is queued or written', async () => {
    install();
    const editor = await openEditor();
    expect(() => editor.insertText(0, '東京', { x: 100, y: 100 })).toThrow(PdfUnsupportedGlyphsError);
    expect(() => editor.insertText(0, 'Party 🎉', { x: 100, y: 100 })).toThrow(PdfUnsupportedGlyphsError);
    expect(editor.getPendingEdits()).toHaveLength(0);
    await expect(editor.applyNewTextInsertion(0, 'Привет', { x: 10, y: 10 }, W(1))).rejects.toBeInstanceOf(
      PdfUnsupportedGlyphsError,
    );
    expect((NativeModules as any).PdfiumNativeModule.applyBatchEdits).not.toHaveBeenCalled();
    expect(editor.isDirty()).toBe(false);
  });

  it('refuses emoji / newline replacements but lets the native font check decide for CJK', async () => {
    install();
    const editor = await openEditor();
    expect(() => editor.replaceText('p0_path0', 'Launch 🚀')).toThrow(PdfUnsupportedGlyphsError);
    expect(() => editor.replaceText('p0_path0', 'a\nb')).toThrow(PdfUnsupportedGlyphsError);
    expect(editor.getPendingEdits()).toHaveLength(0);
    expect(() => editor.replaceText('p0_path0', '東京')).not.toThrow();
  });

  it('a native missing-glyph failure is typed and leaves the document unchanged', async () => {
    install();
    const editor = await openEditor();
    nativeFailure = "UNSUPPORTED_GLYPHS: The original font (ABCDEF+Arial) cannot display '東' (U+6771). The text was not changed.";
    const attempt = editor.applyExistingTextReplacement('p0_path0', '東', W(1));
    await expect(attempt).rejects.toBeInstanceOf(PdfUnsupportedGlyphsError);
    expect(editor.getCurrentFilePath()).toBe(SOURCE);
    expect(editor.canUndo()).toBe(false);
    expect(editor.isDirty()).toBe(false);
  });

  it('a queued edit failing on glyphs at Save keeps the edit and reports the typed error', async () => {
    install();
    const editor = await openEditor();
    editor.replaceText('p0_path0', '東京');
    nativeFailure = "UNSUPPORTED_GLYPHS: The original font cannot display '東' (U+6771), '京' (U+4EAC). The text was not changed.";
    await expect(editor.saveDocument('/data/files/pie/documents/pdf-g/rev_1.pdf')).rejects.toBeInstanceOf(
      PdfUnsupportedGlyphsError,
    );
    expect(editor.getSaveState()).toBe('SAVE_FAILED');
    expect(editor.getPendingEdits()).toHaveLength(1);
  });

  it('Latin edits with accents, euro and dashes still work end to end', async () => {
    const files = install();
    const editor = await openEditor();
    await editor.applyExistingTextReplacement('p0_path0', 'Résumé – 50 €', W(1));
    await editor.applyNewTextInsertion(0, 'Approuvé “OK”', { x: 60, y: 300 }, W(2));
    expect(files.get(W(2))).toEqual(['Résumé – 50 €', 'Body', 'Approuvé “OK”']);
  });
});
