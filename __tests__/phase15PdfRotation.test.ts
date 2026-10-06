/**
 * Phase 15 — rotated PDF pages: user space <-> displayed page mapping for /Rotate
 * 0/90/180/270, rotated extraction/hit-testing, rotation-aware insertion (upright text) and
 * unchanged behaviour for unrotated pages.
 */
import { NativeModules } from 'react-native';
import {
  displayMatrixForPage,
  displayRectToUserBounds,
  displayToUserPoint,
  normalizeRotation,
  placeInsertedText,
  rotationDisplayMatrix,
  uprightTextMatrix,
  userBoundsToDisplayRect,
  userToDisplayPoint,
} from '../src/features/pdf/pdfPageGeometry';
import { PdfiumEngine, hitTestTextObjects } from '../src/features/pdf/pdfiumEngine';
import { PdfDocumentEditor } from '../src/features/pdf/pdfDocumentEditor';
import { PdfDisplayMatrix, PdfPageRotation, PdfTextObject } from '../src/features/pdf/types';

// Letter page in user space: 612 x 792 (portrait).
const BOX = { left: 0, bottom: 0, width: 612, height: 792 };

/** Display direction of a user-space vector (linear part only; -0 normalized to 0). */
const dir = (m: PdfDisplayMatrix, x: number, y: number) => ({
  x: m.a * x + m.c * y + 0,
  y: m.b * x + m.d * y + 0,
});

describe('Phase 15 — rotation mapping (clockwise /Rotate as displayed)', () => {
  it('rotation 0 is exactly the previous mapping: u = x, v = height - y', () => {
    const m = rotationDisplayMatrix(0, BOX);
    expect(userToDisplayPoint(m, 72, 700)).toEqual({ x: 72, y: 92 });
    expect(userToDisplayPoint(m, 0, 0)).toEqual({ x: 0, y: 792 });
  });

  it.each<[PdfPageRotation, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]>([
    // rotation, user (0,0) bottom-left, user (612,0) bottom-right, user (0,792) top-left
    [0, { x: 0, y: 792 }, { x: 612, y: 792 }, { x: 0, y: 0 }],
    [90, { x: 0, y: 0 }, { x: 0, y: 612 }, { x: 792, y: 0 }],
    [180, { x: 612, y: 0 }, { x: 0, y: 0 }, { x: 612, y: 792 }],
    [270, { x: 792, y: 612 }, { x: 792, y: 0 }, { x: 0, y: 612 }],
  ])('rotation %i maps the page corners like a clockwise turn', (rotation, bl, br, tl) => {
    const m = rotationDisplayMatrix(rotation, BOX);
    expect(userToDisplayPoint(m, 0, 0)).toEqual(bl);
    expect(userToDisplayPoint(m, 612, 0)).toEqual(br);
    expect(userToDisplayPoint(m, 0, 792)).toEqual(tl);
  });

  it.each<PdfPageRotation>([0, 90, 180, 270])('rotation %i round-trips display <-> user', (rotation) => {
    const m = rotationDisplayMatrix(rotation, { left: 10, bottom: 20, width: 612, height: 792 });
    for (const [x, y] of [[10, 20], [300.5, 411.25], [622, 812]]) {
      const d = userToDisplayPoint(m, x, y);
      const u = displayToUserPoint(m, d.x, d.y);
      expect(u.x).toBeCloseTo(x, 9);
      expect(u.y).toBeCloseTo(y, 9);
    }
  });

  it('display size swaps for odd rotations; the fallback matrix uses the display size', () => {
    // Native getPageSize reports the DISPLAYED size (792 x 612 for a rotated portrait page)
    const m = displayMatrixForPage({ width: 792, height: 612, rotation: 90 });
    expect(m).toEqual(rotationDisplayMatrix(90, BOX));
    const d = userBoundsToDisplayRect(m, { left: 0, bottom: 0, right: 612, top: 792 });
    expect(d).toEqual({ x: 0, y: 0, width: 792, height: 612 });
  });

  it('prefers the native (PDFium) display matrix, e.g. with a crop-box offset', () => {
    const native = { a: 1, b: 0, c: 0, d: -1, e: -36, f: 756 };
    expect(displayMatrixForPage({ width: 540, height: 720, rotation: 0, displayMatrix: native })).toBe(native);
    // A degenerate native matrix is ignored in favour of the rotation fallback
    const degenerate = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
    expect(displayMatrixForPage({ width: 612, height: 792, displayMatrix: degenerate })).toEqual(rotationDisplayMatrix(0, BOX));
  });

  it('normalizes rotation values', () => {
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation('180')).toBe(180);
    expect(normalizeRotation(undefined)).toBe(0);
  });
});

describe('Phase 15 — upright inserted text on rotated pages', () => {
  it.each<PdfPageRotation>([0, 90, 180, 270])('rotation %i: baseline runs left->right and glyphs point up on screen', (rotation) => {
    const m = rotationDisplayMatrix(rotation, BOX);
    const t = uprightTextMatrix(m, 100, 200);
    // text x-axis (a, b) must map to display +u; text y-axis (c, d) to display "up" (-v)
    expect(dir(m, t.a, t.b)).toEqual({ x: 1, y: 0 });
    expect(dir(m, t.c, t.d)).toEqual({ x: 0, y: -1 });
    expect([t.e, t.f]).toEqual([100, 200]);
  });

  it('rotation 0 placement equals the previous formula exactly', () => {
    const placed = placeInsertedText({ width: 612, height: 792 }, { x: 75, y: 100 }, 16, { width: 80, height: 20 });
    expect(placed.pdfX).toBe(75);
    expect(placed.pdfY).toBe(792 - (100 + 16));
    expect(placed.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 75, f: 676 });
    expect(placed.pdfBounds).toEqual({ left: 75, bottom: 676, right: 155, top: 696 });
  });

  it('rotation 90 placement lands where the user tapped on screen', () => {
    const size = { width: 792, height: 612, rotation: 90 as PdfPageRotation };
    const placed = placeInsertedText(size, { x: 300, y: 100 }, 20, { width: 120, height: 25 });
    const m = displayMatrixForPage(size);
    // The baseline origin is displayed at (300, 120): tap point + font size
    expect(userToDisplayPoint(m, placed.pdfX, placed.pdfY)).toEqual({ x: 300, y: 120 });
    // and the box covers the displayed text area above the baseline
    expect(userBoundsToDisplayRect(m, placed.pdfBounds)).toEqual({ x: 300, y: 95, width: 120, height: 25 });
    expect(displayRectToUserBounds(m, { x: 300, y: 95, width: 120, height: 25 })).toEqual(placed.pdfBounds);
  });
});

describe('Phase 15 — rotated extraction, hit testing and editor insertion', () => {
  afterEach(() => {
    delete (NativeModules as any).PdfiumNativeModule;
  });

  /** Native-shaped object whose display bounds are derived from user bounds (as C++ does). */
  function nativeObject(id: string, index: number, text: string, user: { left: number; bottom: number; right: number; top: number }, m: PdfDisplayMatrix) {
    return {
      id,
      pageIndex: 0,
      objectIndex: index,
      objectPath: [index],
      text,
      bounds: userBoundsToDisplayRect(m, user),
      pdfBounds: user,
      fontSize: 12,
      fontName: 'Helvetica',
      color: '#000000',
      colorRgba: { r: 0, g: 0, b: 0, a: 255 },
      matrix: { a: 1, b: 0, c: 0, d: 1, e: user.left, f: user.bottom },
      isEditable: true,
    };
  }

  function installRotatedNative(rotation: PdfPageRotation) {
    const m = rotationDisplayMatrix(rotation, BOX);
    const odd = rotation === 90 || rotation === 270;
    const objects = [
      nativeObject('p0_path0', 0, 'Title', { left: 72, bottom: 700, right: 272, top: 724 }, m),
      nativeObject('p0_path1', 1, 'Footer', { left: 72, bottom: 40, right: 172, top: 52 }, m),
    ];
    const applyBatchEdits = jest.fn();
    (NativeModules as any).PdfiumNativeModule = {
      openDocument: jest.fn(async (path: string) => ({ docHandle: 1, pageCount: 1, filePath: path })),
      closeDocument: jest.fn(async () => true),
      getPageSize: jest.fn(async () => ({
        pageIndex: 0,
        width: odd ? 792 : 612,
        height: odd ? 612 : 792,
        rotation,
        displayMatrix: m,
      })),
      getTextObjects: jest.fn(async () => JSON.stringify(objects)),
      applyBatchEdits,
    };
    return { m, objects, applyBatchEdits };
  }

  it.each<PdfPageRotation>([0, 90, 180, 270])('rotation %i: a tap on the displayed text selects the right object', async (rotation) => {
    const { m } = installRotatedNative(rotation);
    const engine = new PdfiumEngine();
    const objects: PdfTextObject[] = await engine.getTextObjects(1, 0);
    const titleCenterUser = { x: 172, y: 712 };
    const tap = userToDisplayPoint(m, titleCenterUser.x, titleCenterUser.y);
    expect(hitTestTextObjects(objects, tap, 2)?.id).toBe('p0_path0');
    const footerTap = userToDisplayPoint(m, 120, 46);
    expect(hitTestTextObjects(objects, footerTap, 2)?.id).toBe('p0_path1');
  });

  it('getPageSize passes rotation and the PDFium display matrix through', async () => {
    const { m } = installRotatedNative(270);
    const size = await new PdfiumEngine().getPageSize(1, 0);
    expect(size).toEqual({ pageIndex: 0, width: 792, height: 612, rotation: 270, displayMatrix: m });
  });

  it('getPageSize without geometry stays exactly as before (unrotated)', async () => {
    (NativeModules as any).PdfiumNativeModule = {
      getPageSize: jest.fn(async () => ({ pageIndex: 0, width: 612, height: 792 })),
    };
    expect(await new PdfiumEngine().getPageSize(1, 0)).toEqual({ pageIndex: 0, width: 612, height: 792 });
  });

  it('a queued insert on a 90° page carries user coordinates that display at the tap point', async () => {
    const { m } = installRotatedNative(90);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open('/data/files/pie/documents/pdf-r/source.pdf');
    await editor.getPageSize(0);
    await editor.getTextObjects(0);

    const inserted = editor.insertText(0, 'Approved', { x: 400, y: 300 }, { fontSize: 18 });
    const cmd = editor.getPendingEdits()[0] as any;
    expect(cmd.type).toBe('insert');
    expect(userToDisplayPoint(m, cmd.x, cmd.y)).toEqual({ x: 400, y: 318 });
    // optimistic object: display bounds where the user tapped, upright matrix
    expect(inserted.bounds).toMatchObject({ x: 400, y: 300 });
    expect(dir(m, inserted.matrix!.a, inserted.matrix!.b)).toEqual({ x: 1, y: 0 });

    // Moving the pending insert keeps it rotation-correct
    editor.moveInsertedText(inserted.id, { x: 100, y: 50 });
    const moved = editor.getPendingEdits()[0] as any;
    expect(userToDisplayPoint(m, moved.x, moved.y)).toEqual({ x: 100, y: 68 });
  });

  it('replacement / deletion address objects by path, independent of rotation', async () => {
    installRotatedNative(180);
    const editor = new PdfDocumentEditor(new PdfiumEngine());
    await editor.open('/data/files/pie/documents/pdf-r/source.pdf');
    await editor.getTextObjects(0);
    editor.replaceText('p0_path0', 'New Title');
    editor.deleteText('p0_path1');
    const [rep, del] = editor.getPendingEdits() as any[];
    expect(rep).toMatchObject({ type: 'replace', objectPath: [0], newText: 'New Title' });
    expect(del).toMatchObject({ type: 'delete', objectPath: [1] });
  });
});
