/**
 * Fix pass — image editor direct manipulation and selection:
 * - finger-sized, zoom-aware hit targets (added text vs existing OCR text never confused)
 * - one-finger move of any added layer (grabbing selects it)
 * - two-finger resize of the selected layer (scale around centre, clamped font size)
 * - one completed manipulation = one undo step; persistence-ready document state
 * - readable default text size on high-resolution images
 */
import { AddedTextElement, Document, TextRegion } from '../src/types/document';
import {
  DRAG_TOUCH_SLOP_PT,
  MIN_ADDED_TEXT_FONT_SIZE,
  PINCH_TARGET_SLOP_PT,
  TAP_TOLERANCE_PT,
  clampManipulationScale,
  distanceToRect,
  hitTestImageCanvas,
  hitTestManipulableLayer,
  maxAddedTextFontSize,
  pinchTargetsLayer,
  screenToDocumentTolerance,
  toManipulableLayers,
} from '../src/features/image/imageCanvasInteraction';
import { createAddedText, manipulateAddedText } from '../src/features/image/addedTextLayers';
import { TextMeasurer } from '../src/features/text/textLayout';
import { DocumentHistoryManager } from '../src/features/history/historyManager';
import { fingerprintImageDocument, isImageDocumentDirty } from '../src/features/image/imageDocumentState';
import { documentPixelsPerPoint } from '../src/components/TextEditModal';
import { buildImageRenderPlan } from '../src/features/image/imageRenderPlan';

// 12 MP photo, as shown on a phone at fit (~0.09 screen points per image pixel)
const PAGE = { width: 4000, height: 3000 };
const FIT = 0.09;
const fixedMeasure: TextMeasurer = (text) => Array.from(text).length * 10;

function photoDoc(): Document {
  return {
    id: 'img-p',
    metadata: { id: 'img-p', title: 'Photo', kind: 'image', sourceUri: 'content://x', pageCount: 1, createdAt: 1, updatedAt: 1 },
    pages: [
      {
        id: 'page-0',
        pageIndex: 0,
        dimensions: PAGE,
        rotation: 0,
        originalContent: { pageIndex: 0, assetUri: 'file:///w/working.jpg', width: 4000, height: 3000 },
        editableTextRegions: [],
        addedText: [],
      },
    ],
  };
}

const region = (id: string, bounds: TextRegion['bounds'], status: TextRegion['status'] = 'detected'): TextRegion => ({
  id,
  pageIndex: 0,
  bounds,
  originalText: id,
  currentText: id,
  status,
  style: { fontSize: 40, color: '#000' },
});

const added = (id: string, bounds: AddedTextElement['bounds'], fontSize = 200): AddedTextElement => ({
  id,
  pageIndex: 0,
  text: id,
  bounds,
  style: { fontSize, color: '#000' },
});

describe('Fix — zoom-aware, finger-sized hit testing on the image canvas', () => {
  it('converts screen-point tolerances to document pixels with the zoom', () => {
    expect(screenToDocumentTolerance(TAP_TOLERANCE_PT, FIT)).toBeCloseTo(TAP_TOLERANCE_PT / FIT, 6);
    expect(screenToDocumentTolerance(TAP_TOLERANCE_PT, 2)).toBe(7);
  });

  it('a tap slightly beside OCR text on a photo still selects it (was: 6 px ≈ 0.5 pt)', () => {
    const regions = [region('Total', { x: 1000, y: 1000, width: 600, height: 120 })];
    const tap = { x: 1000 - 100, y: 1060 }; // 9 screen points left of the text at fit
    expect(hitTestImageCanvas(tap, [], regions, 6)).toBeNull(); // old fixed tolerance
    const hit = hitTestImageCanvas(tap, [], regions, screenToDocumentTolerance(TAP_TOLERANCE_PT, FIT));
    expect(hit).toEqual({ kind: 'region', region: regions[0] });
  });

  it('added text and existing OCR text are distinct hits; containment beats proximity', () => {
    const regions = [region('ocr', { x: 0, y: 0, width: 500, height: 100 })];
    const layers = [added('note', { x: 600, y: 0, width: 300, height: 100 })];
    expect(hitTestImageCanvas({ x: 700, y: 50 }, layers, regions, 200)).toEqual({ kind: 'added', element: layers[0] });
    expect(hitTestImageCanvas({ x: 450, y: 50 }, layers, regions, 200)).toEqual({ kind: 'region', region: regions[0] });
    // between them: the nearer one wins
    expect(hitTestImageCanvas({ x: 520, y: 50 }, layers, regions, 200)?.kind).toBe('region');
    expect(hitTestImageCanvas({ x: 590, y: 50 }, layers, regions, 200)?.kind).toBe('added');
  });

  it('added text drawn on top of OCR text wins a tap inside both; deleted OCR text is never hit', () => {
    const regions = [region('ocr', { x: 0, y: 0, width: 500, height: 100 }), region('gone', { x: 0, y: 200, width: 500, height: 100 }, 'deleted')];
    const layers = [added('label', { x: 100, y: 20, width: 100, height: 50 })];
    expect(hitTestImageCanvas({ x: 150, y: 40 }, layers, regions, 10)?.kind).toBe('added');
    expect(hitTestImageCanvas({ x: 100, y: 250 }, [], regions, 10)).toBeNull();
  });

  it('overlapping OCR regions: the smallest containing one is selected', () => {
    const regions = [region('big', { x: 0, y: 0, width: 1000, height: 400 }), region('word', { x: 100, y: 100, width: 80, height: 40 })];
    expect(hitTestImageCanvas({ x: 120, y: 110 }, [], regions, 50)).toEqual({ kind: 'region', region: regions[1] });
  });

  it('distanceToRect is 0 inside and Euclidean outside', () => {
    const r = { x: 0, y: 0, width: 10, height: 10 };
    expect(distanceToRect(r, { x: 5, y: 5 })).toBe(0);
    expect(distanceToRect(r, { x: 13, y: 14 })).toBe(5);
  });
});

describe('Fix — one-finger move target selection', () => {
  const layers = toManipulableLayers([
    added('a', { x: 100, y: 100, width: 400, height: 150 }),
    added('b', { x: 300, y: 120, width: 400, height: 150 }), // overlaps a, drawn on top
    added('c', { x: 2000, y: 2000, width: 400, height: 150 }),
  ]);
  const slop = screenToDocumentTolerance(DRAG_TOUCH_SLOP_PT, FIT);

  it('grabs the top-most layer under the finger even when nothing is selected', () => {
    expect(hitTestManipulableLayer(layers, { x: 350, y: 150 }, slop, null)).toBe('b');
    expect(hitTestManipulableLayer(layers, { x: 150, y: 150 }, slop, null)).toBe('a');
  });

  it('prefers the selected layer under the finger', () => {
    expect(hitTestManipulableLayer(layers, { x: 350, y: 150 }, slop, 'a')).toBe('a');
  });

  it('grabs a nearby small layer within the finger slop and ignores far drags', () => {
    expect(hitTestManipulableLayer(layers, { x: 2000 - 120, y: 2050 }, slop, null)).toBe('c'); // 11 pt away
    expect(hitTestManipulableLayer(layers, { x: 1200, y: 1200 }, slop, null)).toBeNull();
  });
});

describe('Fix — two-finger resize', () => {
  const layer = toManipulableLayers([added('t', { x: 1000, y: 1000, width: 500, height: 200 }, 160)])[0];

  it('a pinch centred on or near the selected layer resizes it (else the page zooms)', () => {
    const slop = screenToDocumentTolerance(PINCH_TARGET_SLOP_PT, FIT);
    expect(pinchTargetsLayer(layer, { x: 1250, y: 1100 }, slop)).toBe(true);
    expect(pinchTargetsLayer(layer, { x: 1000 - 500, y: 1100 }, slop)).toBe(true); // 45 pt away
    expect(pinchTargetsLayer(layer, { x: 3500, y: 2800 }, slop)).toBe(false);
  });

  it('clamps the pinch scale to the minimum / maximum font size', () => {
    const max = maxAddedTextFontSize(PAGE);
    expect(max).toBe(3000);
    expect(clampManipulationScale(160, 2, MIN_ADDED_TEXT_FONT_SIZE, max)).toBe(2);
    expect(clampManipulationScale(160, 100, MIN_ADDED_TEXT_FONT_SIZE, max)).toBeCloseTo(3000 / 160, 9);
    expect(clampManipulationScale(160, 0.001, MIN_ADDED_TEXT_FONT_SIZE, max)).toBeCloseTo(MIN_ADDED_TEXT_FONT_SIZE / 160, 9);
    expect(clampManipulationScale(0, 2, 4, 100)).toBe(1);
    expect(maxAddedTextFontSize({ width: 30, height: 20 })).toBe(64);
  });
});

describe('Fix — committing a manipulation (document state)', () => {
  const limits = { minFontSize: MIN_ADDED_TEXT_FONT_SIZE, maxFontSize: maxAddedTextFontSize(PAGE) };

  function withLayers() {
    let doc = photoDoc();
    const a = createAddedText(doc, { text: 'Hello', origin: { x: 1000, y: 1000 }, style: { fontSize: 100 } }, fixedMeasure);
    doc = a.document;
    const b = createAddedText(doc, { text: 'Other', origin: { x: 200, y: 200 }, style: { fontSize: 100 } }, fixedMeasure);
    return { doc: b.document, a: a.element, b: b.element };
  }

  it('one-finger move: the screen delta divided by the zoom moves the layer in document pixels', () => {
    const { doc, a } = withLayers();
    const screenDx = 45; // points the finger moved
    const zoom = FIT;
    const { element, changed } = manipulateAddedText(doc, a.id, { dx: screenDx / zoom, dy: -18 / zoom, scale: 1 }, limits, fixedMeasure);
    expect(changed).toBe(true);
    expect(element.bounds.x).toBe(1000 + 500);
    expect(element.bounds.y).toBe(1000 - 200);
    expect(element.bounds.width).toBe(a.bounds.width);
    expect(element.style.fontSize).toBe(100);
  });

  it('the same finger movement at a higher zoom moves the text less in the document', () => {
    const { doc, a } = withLayers();
    const at2x = manipulateAddedText(doc, a.id, { dx: 45 / 2, dy: 0, scale: 1 }, limits, fixedMeasure).element;
    expect(at2x.bounds.x).toBe(1000 + 23); // 22.5 rounded
  });

  it('two-finger resize scales font size and wrap width around the centre', () => {
    const { doc, a } = withLayers();
    const centre = { x: a.bounds.x + a.bounds.width / 2, y: a.bounds.y + a.bounds.height / 2 };
    const { element } = manipulateAddedText(doc, a.id, { dx: 0, dy: 0, scale: 2 }, limits, fixedMeasure);
    expect(element.style.fontSize).toBe(200);
    expect(element.wrapWidth).toBe(Math.round(a.wrapWidth! * 2));
    // centre preserved (origins are whole pixels, so within 1 px)
    expect(Math.abs(element.bounds.x + element.bounds.width / 2 - centre.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(element.bounds.y + element.bounds.height / 2 - centre.y)).toBeLessThanOrEqual(1);
    // render plan draws the new size
    const layer = buildImageRenderPlan({ editableTextRegions: [], addedText: [element] }, { measureText: fixedMeasure }).textElements[0];
    expect(layer.fittedFontSize).toBe(200);
  });

  it('move + resize in one gesture is one change, other layers untouched; undo restores it', () => {
    const { doc, a, b } = withLayers();
    const history = new DocumentHistoryManager();
    history.initialize(doc);
    const saved = fingerprintImageDocument(doc);
    const result = manipulateAddedText(doc, a.id, { dx: 300, dy: 100, scale: 1.5 }, limits, fixedMeasure);
    history.push(result.document);
    expect(result.element.style.fontSize).toBe(150);
    expect(result.document.pages[0].addedText.find((l) => l.id === b.id)).toEqual(b);
    expect(isImageDocumentDirty(result.document, saved)).toBe(true);

    const undone = history.undo()!;
    expect(undone.pages[0].addedText.find((l) => l.id === a.id)).toEqual(a);
    expect(isImageDocumentDirty(undone, saved)).toBe(false);
    const redone = history.redo()!;
    expect(redone.pages[0].addedText.find((l) => l.id === a.id)?.style.fontSize).toBe(150);
  });

  it('font size is clamped and the layer stays inside the page', () => {
    const { doc, a } = withLayers();
    const huge = manipulateAddedText(doc, a.id, { dx: 0, dy: 0, scale: 1000 }, limits, fixedMeasure).element;
    expect(huge.style.fontSize).toBe(3000);
    expect(huge.bounds.x).toBeGreaterThanOrEqual(0);
    const tiny = manipulateAddedText(doc, a.id, { dx: 0, dy: 0, scale: 0.0001 }, limits, fixedMeasure).element;
    expect(tiny.style.fontSize).toBe(MIN_ADDED_TEXT_FONT_SIZE);
    const off = manipulateAddedText(doc, a.id, { dx: 99999, dy: 99999, scale: 1 }, limits, fixedMeasure).element;
    expect(off.bounds.x + off.bounds.width).toBeLessThanOrEqual(PAGE.width);
    expect(off.bounds.y + off.bounds.height).toBeLessThanOrEqual(PAGE.height);
  });

  it('a manipulation that changes nothing reports changed=false and returns the same document', () => {
    const { doc, a } = withLayers();
    const r = manipulateAddedText(doc, a.id, { dx: 0.2, dy: -0.2, scale: 1.0001 }, limits, fixedMeasure);
    expect(r.changed).toBe(false);
    expect(r.document).toBe(doc);
  });

  it('existing OCR regions and the source image are untouched by manipulations', () => {
    const { doc, a } = withLayers();
    const withOcr: Document = {
      ...doc,
      pages: [{ ...doc.pages[0], editableTextRegions: [region('ocr', { x: 0, y: 0, width: 100, height: 20 })] }],
    };
    const r = manipulateAddedText(withOcr, a.id, { dx: 10, dy: 10, scale: 1.3 }, limits, fixedMeasure);
    expect(r.document.pages[0].editableTextRegions).toEqual(withOcr.pages[0].editableTextRegions);
    expect(r.document.pages[0].originalContent).toEqual(withOcr.pages[0].originalContent);
  });
});

describe('Fix — readable text sizes on high-resolution images', () => {
  it('maps on-screen points to document pixels from the fit scale', () => {
    expect(documentPixelsPerPoint(FIT)).toBeCloseTo(1 / FIT, 6);
    expect(documentPixelsPerPoint(2)).toBe(0.5);
    expect(documentPixelsPerPoint(null)).toBe(1);
    expect(documentPixelsPerPoint(0)).toBe(1);
    expect(documentPixelsPerPoint(0.001)).toBe(64);
  });

  it('18 pt default text on a 12 MP photo is ~200 px (visible), not 18 px (~1.6 pt)', () => {
    expect(18 * documentPixelsPerPoint(FIT)).toBeCloseTo(200, 0);
  });
});
