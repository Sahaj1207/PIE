import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { composePdfMatrices, pdfObjectPathId } from '../src/features/pdf/pdfObjectLocator';
import { viewportPointToDocumentPoint, documentPointToViewportPoint } from '../src/features/pdf/pdfViewportMath';

describe('PDF Form XObject locator and transform contracts', () => {
  test('formats a stable path across nested Forms', () => {
    expect(pdfObjectPathId(2, [4, 1, 3])).toBe('p2_path4_1_3');
  });

  test('composes nested Form matrices in page space', () => {
    const form = { a: 2, b: 0, c: 0, d: 2, e: 40, f: 60 };
    const child = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 15 };
    expect(composePdfMatrices(form, child)).toEqual({
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: 60,
      f: 90,
    });
  });

  test('retains the native object path in replacement and deletion commands', async () => {
    const engine: any = {
      openDocument: jest.fn().mockResolvedValue({ docHandle: 7, pageCount: 1, filePath: '/nested.pdf' }),
      closeDocument: jest.fn().mockResolvedValue(true),
      getPageSize: jest.fn().mockResolvedValue({ pageIndex: 0, width: 300, height: 200 }),
      getTextObjects: jest.fn().mockResolvedValue([
        {
          id: 'p0_path0_2', pageIndex: 0, objectIndex: 2, objectPath: [0, 2], text: 'Nested Form Text',
          bounds: { x: 40, y: 82, width: 150, height: 18 },
          pdfBounds: { left: 40, bottom: 100, right: 190, top: 118 },
          fontSize: 18, fontName: 'Helvetica', color: '#000000', colorRgba: null,
          matrix: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 100 }, isEditable: true,
        },
      ]),
    };
    const editor = new PdfDocumentEditor(engine);
    await editor.open('/nested.pdf');
    await editor.getTextObjects(0);

    editor.replaceText('p0_path0_2', 'Edited');
    expect(editor.getPendingEdits()[0]).toMatchObject({ objectPath: [0, 2] });

    editor.deleteText('p0_path0_2');
    expect(editor.getPendingEdits()[0]).toMatchObject({ objectPath: [0, 2] });
  });
});

describe('PDF viewport coordinate conversion', () => {
  const transform = {
    baseScale: 0.5,
    pageOriginX: 40,
    pageOriginY: 100,
    zoom: 2,
    translateX: 30,
    translateY: -20,
  };

  test('accounts for centering, pan, fit scale, and zoom', () => {
    expect(viewportPointToDocumentPoint({ x: 170, y: 180 }, transform)).toEqual({ x: 100, y: 100 });
  });

  test('round-trips a placement point after pan and zoom', () => {
    const original = { x: 125, y: 70 };
    expect(viewportPointToDocumentPoint(documentPointToViewportPoint(original, transform), transform)).toEqual(original);
  });
});
