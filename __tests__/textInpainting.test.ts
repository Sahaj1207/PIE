/**
 * Texture-preserving background reconstruction (reference implementation of the native
 * algorithm in ImageProcessingModule.kt / .m).
 */
import {
  INPAINT_MIN_THRESHOLD,
  RgbaImage,
  fitPlane,
  reconstructTextPatch,
} from '../src/features/image/textInpainting';

type Rgb = [number, number, number];

function image(width: number, height: number, bg: (x: number, y: number) => Rgb): RgbaImage & { data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = bg(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function paint(img: RgbaImage & { data: Uint8ClampedArray }, rect: { x: number; y: number; w: number; h: number }, c: Rgb) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
    }
  }
}

/** Three "letters" (vertical + horizontal strokes) inside the OCR box. */
function drawText(img: RgbaImage & { data: Uint8ClampedArray }, color: Rgb) {
  paint(img, { x: 14, y: 12, w: 3, h: 16 }, color);
  paint(img, { x: 14, y: 26, w: 10, h: 2 }, color);
  paint(img, { x: 30, y: 12, w: 3, h: 16 }, color);
  paint(img, { x: 30, y: 12, w: 10, h: 2 }, color);
  paint(img, { x: 46, y: 12, w: 3, h: 16 }, color);
  paint(img, { x: 52, y: 12, w: 3, h: 16 }, color);
}

// Region 72 x 40: border ring of 4 px around the target (4..68, 4..36); OCR box inside it.
const TARGET = { x: 4, y: 4, width: 64, height: 32 };
const BOX = { x: 9, y: 9, width: 54, height: 22 };

const px = (img: { width: number; data: ArrayLike<number> }, x: number, y: number): Rgb => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const patchPx = (res: { patch: Uint8ClampedArray; width: number }, x: number, y: number) =>
  px({ width: res.width, data: res.patch }, x - TARGET.x, y - TARGET.y);

describe('fitPlane', () => {
  it('recovers an exact linear gradient', () => {
    const xs = [0, 10, 0, 10, 5], ys = [0, 0, 10, 10, 5];
    const cs = xs.map((x, i) => 20 + 3 * x - 2 * ys[i]);
    const p = fitPlane(xs, ys, cs, xs.length);
    expect(p.c0).toBeCloseTo(20, 6);
    expect(p.a).toBeCloseTo(3, 6);
    expect(p.b).toBeCloseTo(-2, 6);
  });
});

describe('texture-preserving reconstruction', () => {
  it('flat background: text pixels become the background, nothing else changes', () => {
    const img = image(72, 40, () => [250, 250, 250]);
    drawText(img, [20, 20, 20]);
    const res = reconstructTextPatch(img, TARGET, BOX);
    expect(res.method).toBe('inpaint');
    expect(res.threshold).toBe(INPAINT_MIN_THRESHOLD);
    for (let y = TARGET.y; y < TARGET.y + TARGET.height; y++) {
      for (let x = TARGET.x; x < TARGET.x + TARGET.width; x++) {
        for (const c of patchPx(res, x, y)) expect(Math.abs(c - 250)).toBeLessThanOrEqual(1);
      }
    }
    expect(res.textColor).toBe('#141414');
  });

  it('textured background: the texture around and between letters is kept exactly', () => {
    // Vertical stripes (paper / fabric texture), dark text on top
    const stripe = (x: number): Rgb => (Math.floor(x / 2) % 2 === 0 ? [200, 180, 150] : [230, 210, 180]);
    const clean = image(72, 40, (x) => stripe(x));
    const img = image(72, 40, (x) => stripe(x));
    drawText(img, [10, 10, 10]);

    const res = reconstructTextPatch(img, TARGET, BOX);
    expect(res.method).toBe('inpaint');
    // Noisy background raises the threshold above the stripe contrast
    expect(res.threshold).toBeGreaterThan(INPAINT_MIN_THRESHOLD);

    let unchanged = 0;
    let total = 0;
    let maxError = 0;
    for (let y = TARGET.y; y < TARGET.y + TARGET.height; y++) {
      for (let x = TARGET.x; x < TARGET.x + TARGET.width; x++) {
        total++;
        const out = patchPx(res, x, y);
        const orig = px(img, x, y);
        if (out[0] === orig[0] && out[1] === orig[1] && out[2] === orig[2]) unchanged++;
        const truth = px(clean, x, y);
        maxError = Math.max(maxError, ...out.map((c, i) => Math.abs(c - truth[i])));
      }
    }
    // Most of the box keeps the real texture (the old plane fill repainted 100%)
    expect(unchanged / total).toBeGreaterThan(0.6);
    // Reconstructed strokes land within the texture's own range (no dark remnants)
    expect(maxError).toBeLessThanOrEqual(31);
    // No pixel of the text remains
    for (let y = TARGET.y; y < TARGET.y + TARGET.height; y++) {
      for (let x = TARGET.x; x < TARGET.x + TARGET.width; x++) {
        expect(patchPx(res, x, y)[0]).toBeGreaterThanOrEqual(190);
      }
    }
  });

  it('gradient background is continued smoothly through the strokes', () => {
    const grad = (x: number, y: number): Rgb => [100 + x * 2, 80 + y, 160];
    const img = image(72, 40, grad);
    drawText(img, [250, 250, 250]);
    const res = reconstructTextPatch(img, TARGET, BOX);
    expect(res.method).toBe('inpaint');
    for (let y = TARGET.y; y < TARGET.y + TARGET.height; y++) {
      for (let x = TARGET.x; x < TARGET.x + TARGET.width; x++) {
        const out = patchPx(res, x, y);
        const truth = grad(x, y);
        out.forEach((c, i) => expect(Math.abs(c - truth[i])).toBeLessThanOrEqual(6));
      }
    }
  });

  it('falls back to the plane fill when almost nothing is detected', () => {
    const img = image(72, 40, () => [240, 240, 240]);
    paint(img, { x: 30, y: 15, w: 1, h: 1 }, [235, 235, 235]); // invisible "text"
    const res = reconstructTextPatch(img, TARGET, BOX);
    expect(res.method).toBe('plane');
  });

  it('falls back to the plane fill when most of the box is flagged (unreliable mask)', () => {
    const img = image(72, 40, () => [255, 255, 255]);
    paint(img, { x: 4, y: 4, w: 64, h: 32 }, [0, 0, 0]); // the whole target is dark
    const res = reconstructTextPatch(img, TARGET, BOX);
    expect(res.method).toBe('plane');
    // The plane (white border) still erases it
    expect(patchPx(res, 36, 20)).toEqual([255, 255, 255]);
  });

  it('is deterministic', () => {
    const img = image(72, 40, (x, y) => [(x * 7 + y * 3) % 60 + 150, 170, 160]);
    drawText(img, [30, 40, 50]);
    const a = reconstructTextPatch(img, TARGET, BOX);
    const b = reconstructTextPatch(img, TARGET, BOX);
    expect(Array.from(a.patch)).toEqual(Array.from(b.patch));
    expect(a.method).toBe(b.method);
  });

  it('output is opaque and target-sized', () => {
    const img = image(72, 40, () => [128, 128, 128]);
    drawText(img, [0, 0, 0]);
    const res = reconstructTextPatch(img, TARGET, BOX);
    expect(res.width).toBe(64);
    expect(res.height).toBe(32);
    for (let k = 3; k < res.patch.length; k += 4) expect(res.patch[k]).toBe(255);
  });
});

// ---------------------------------------------------------------------------------------------
// Golden output shared with the native ports. scripts/inpainting-parity/ runs the same five
// cases through android/.../TextInpainting.kt (JVM) and ios/PieNative/PieTextInpainting.h
// (WebAssembly) and compares byte for byte. If this hash changes, update all three
// implementations and re-run that script.
// ---------------------------------------------------------------------------------------------

function parityCase(name: string): RgbaImage {
  const w = 72, h = 40;
  const data = new Uint8ClampedArray(w * h * 4);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (name === 'flat') set(x, y, 250, 250, 250);
      else if (name === 'stripes') { if (Math.floor(x / 2) % 2 === 0) set(x, y, 200, 180, 150); else set(x, y, 230, 210, 180); }
      else if (name === 'gradient') set(x, y, 100 + x * 2, 80 + y, 160);
      else if (name === 'noise') set(x, y, (x * 7 + y * 3) % 60 + 150, (x * 13 + y * 5) % 40 + 160, (x * 3 + y * 11) % 50 + 140);
      else set(x, y, 240, 240, 240);
    }
  }
  const paintRect = (x0: number, y0: number, ww: number, hh: number, c: number[]) => {
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) set(x, y, c[0], c[1], c[2]);
  };
  const c = name === 'gradient' ? [250, 250, 250] : name === 'noise' ? [30, 40, 50] : [10, 10, 10];
  if (name !== 'blank') {
    paintRect(14, 12, 3, 16, c); paintRect(14, 26, 10, 2, c);
    paintRect(30, 12, 3, 16, c); paintRect(30, 12, 10, 2, c);
    paintRect(46, 12, 3, 16, c); paintRect(52, 12, 3, 16, c);
  } else {
    paintRect(30, 15, 1, 1, [235, 235, 235]);
  }
  return { width: w, height: h, data };
}

function parityOutput(): string {
  let out = '';
  for (const name of ['flat', 'stripes', 'gradient', 'noise', 'blank']) {
    const r = reconstructTextPatch(parityCase(name), { x: 4, y: 4, width: 64, height: 32 }, { x: 9, y: 9, width: 54, height: 22 });
    out += `${name} ${r.method} ${r.filledPixels} ${r.threshold.toFixed(6)} ${r.sigma.toFixed(6)} ${r.textColor} ${r.backgroundColor} ${r.confidence.toFixed(6)}\n`;
    for (let k = 0; k < r.patch.length; k += 4) {
      out += [r.patch[k], r.patch[k + 1], r.patch[k + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() + ' ';
    }
    out += '\n';
  }
  return out;
}

describe('golden output (parity with the Kotlin and C ports)', () => {
  it('matches the output verified against TextInpainting.kt and PieTextInpainting.h', () => {
    const crypto: { createHash(a: string): { update(s: string): { digest(e: string): string } } } = require('crypto');
    const out = parityOutput();
    if (process.env.PARITY_OUT) {
      require('fs').writeFileSync(process.env.PARITY_OUT, out);
    }
    expect(crypto.createHash('sha256').update(out).digest('hex')).toBe(
      '72a62ced5106abba52eb575a690fc5088d6d5bb2f77588dd8afd573eb7796cd9',
    );
  });
});
