/**
 * Texture-preserving background reconstruction for image text edits (reference implementation).
 *
 * The native modules (Android ImageProcessingModule.kt, iOS ImageProcessingModule.m) implement
 * exactly this algorithm on the decoded image region; this module is the specification and is
 * unit-tested. Everything is deterministic and on-device.
 *
 *  1. Background model: a plane C(x, y) = c0 + a*x + b*y per channel, least-squares fitted to the
 *     border ring around the target (the region outside the target rectangle).
 *  2. Adaptive threshold: T = clamp(3 * sigma, 20, 110), sigma = RMS colour distance of the
 *     border ring from the plane. Textured / photo backgrounds raise T, so texture is not
 *     mistaken for text.
 *  3. Text mask: target pixels farther than T from the plane. Dilated by r = clamp(round(0.06 *
 *     box height), 1, 4) pixels (Chebyshev) to include anti-aliased glyph edges.
 *  4. Fill ONLY masked pixels, from the outside in (8-connected distance layers), each from the
 *     inverse-squared-distance weighted average of already-known pixels within a 9x9 window.
 *     All other pixels keep their original values, so the background texture between and
 *     around the letters is preserved exactly.
 *  5. Fallback to the previous plane fill (2 px feathered edge) when the mask is unreliable:
 *     almost nothing detected (< 0.2% of the target) or most of the target flagged (> 60%).
 *
 * Coordinates: the region is the decoded rectangle (target + border ring); the target and the
 * OCR box are given in region coordinates.
 */

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, row-major, 4 per pixel. */
  readonly data: Uint8ClampedArray | Uint8Array;
}

export interface IntRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type InpaintMethod = 'inpaint' | 'plane';

export interface TextPatchResult {
  /** RGBA patch of the target rectangle (opaque). */
  readonly patch: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly method: InpaintMethod;
  /** Number of pixels that were reconstructed (masked). */
  readonly filledPixels: number;
  readonly threshold: number;
  /** Background noise (RMS distance of the border ring from the fitted plane). */
  readonly sigma: number;
  readonly textColor: string;
  readonly backgroundColor: string;
  /** 0..1, lower on noisy backgrounds and for the fallback. */
  readonly confidence: number;
}

export const INPAINT_MIN_THRESHOLD = 20;
export const INPAINT_MAX_THRESHOLD = 110;
export const INPAINT_WINDOW_RADIUS = 4;
export const INPAINT_MIN_MASK_FRACTION = 0.002;
export const INPAINT_MAX_MASK_FRACTION = 0.6;

interface Plane {
  c0: number;
  a: number;
  b: number;
}

/** Least-squares plane through (x, y, c) samples (Cramer's rule, same as the native code). */
export function fitPlane(xs: ArrayLike<number>, ys: ArrayLike<number>, cs: ArrayLike<number>, n: number): Plane {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sc = 0, sxc = 0, syc = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], c = cs[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sc += c; sxc += x * c; syc += y * c;
  }
  const det = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (n === 0) return { c0: 0, a: 0, b: 0 };
  if (Math.abs(det) < 1e-6) return { c0: sc / n, a: 0, b: 0 };
  const d0 = sc * (sxx * syy - sxy * sxy) - sx * (sxc * syy - sxy * syc) + sy * (sxc * sxy - sxx * syc);
  const da = n * (sxc * syy - sxy * syc) - sc * (sx * syy - sxy * sy) + sy * (sx * syc - sxc * sy);
  const db = n * (sxx * syc - sxc * sxy) - sx * (sx * syc - sxc * sy) + sc * (sx * sxy - sxx * sy);
  return { c0: d0 / det, a: da / det, b: db / det };
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(clamp255(v)).toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * Builds the reconstruction patch for `target` (region coordinates). `box` is the OCR text box
 * (region coordinates) used for the dilation radius and the text colour estimate.
 */
export function reconstructTextPatch(region: RgbaImage, target: IntRect, box: IntRect): TextPatchResult {
  const W = region.width;
  const H = region.height;
  const px = region.data;
  const tx0 = Math.max(0, target.x);
  const ty0 = Math.max(0, target.y);
  const tx1 = Math.min(W, target.x + target.width);
  const ty1 = Math.min(H, target.y + target.height);
  const tw = Math.max(1, tx1 - tx0);
  const th = Math.max(1, ty1 - ty0);
  const inTarget = (x: number, y: number) => x >= tx0 && x < tx1 && y >= ty0 && y < ty1;

  // 1. Plane fit on the border ring
  const cap = W * H;
  // Border-ring samples only (the region minus the target)
  const ring = Math.max(0, cap - (tx1 - tx0) * (ty1 - ty0));
  const xs = new Float64Array(ring), ys = new Float64Array(ring);
  const rs = new Float64Array(ring), gs = new Float64Array(ring), bs = new Float64Array(ring);
  let n = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inTarget(x, y)) continue;
      const i = (y * W + x) * 4;
      xs[n] = x; ys[n] = y; rs[n] = px[i]; gs[n] = px[i + 1]; bs[n] = px[i + 2];
      sumR += px[i]; sumG += px[i + 1]; sumB += px[i + 2];
      n++;
    }
  }
  if (n === 0) throw new Error('No surrounding pixels found to reconstruct background');
  const pr = fitPlane(xs, ys, rs, n), pg = fitPlane(xs, ys, gs, n), pb = fitPlane(xs, ys, bs, n);
  const planeAt = (x: number, y: number): [number, number, number] => [
    clamp255(pr.c0 + pr.a * x + pr.b * y),
    clamp255(pg.c0 + pg.a * x + pg.b * y),
    clamp255(pb.c0 + pb.a * x + pb.b * y),
  ];
  const distToPlane = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    const [r, g, b] = planeAt(x, y);
    const dr = px[i] - r, dg = px[i + 1] - g, db = px[i + 2] - b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  // 2. Adaptive threshold from the background noise
  let sq = 0;
  for (let k = 0; k < n; k++) {
    const d = distToPlane(xs[k], ys[k]);
    sq += d * d;
  }
  const sigma = Math.sqrt(sq / n);
  const threshold = Math.min(INPAINT_MAX_THRESHOLD, Math.max(INPAINT_MIN_THRESHOLD, 3 * sigma));

  // 3. Strong text mask (target only) + text colour inside the OCR box
  const strong = new Uint8Array(cap);
  let strongCount = 0;
  let tr = 0, tg = 0, tb = 0, tc = 0;
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (distToPlane(x, y) > threshold) {
        strong[y * W + x] = 1;
        strongCount++;
        if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) {
          const i = (y * W + x) * 4;
          tr += px[i]; tg += px[i + 1]; tb += px[i + 2]; tc++;
        }
      }
    }
  }
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
  const lum = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB;
  const textColor = tc > 0 ? hex(tr / tc, tg / tc, tb / tc) : lum > 128 ? '#111827' : '#F9FAFB';
  const backgroundColor = hex(meanR, meanG, meanB);

  const area = tw * th;
  const patch = new Uint8ClampedArray(tw * th * 4);
  const fraction = strongCount / area;

  // 5. Fallback: plane fill with a 2 px feathered edge (previous behaviour)
  if (strongCount < Math.max(1, area * INPAINT_MIN_MASK_FRACTION) || fraction > INPAINT_MAX_MASK_FRACTION) {
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        const lx = x - tx0, ly = y - ty0;
        const edge = Math.min(Math.min(lx, tw - 1 - lx), Math.min(ly, th - 1 - ly));
        const alpha = edge < 2 ? (edge + 1) / 3 : 1;
        const [r, g, b] = planeAt(x, y);
        const i = (y * W + x) * 4, o = (ly * tw + lx) * 4;
        patch[o] = Math.floor(r * alpha + px[i] * (1 - alpha));
        patch[o + 1] = Math.floor(g * alpha + px[i + 1] * (1 - alpha));
        patch[o + 2] = Math.floor(b * alpha + px[i + 2] * (1 - alpha));
        patch[o + 3] = 255;
      }
    }
    return {
      patch, width: tw, height: th, method: 'plane', filledPixels: area, threshold, sigma, textColor, backgroundColor,
      confidence: Math.max(0.3, Math.min(0.75, 0.75 - sigma / 200)),
    };
  }

  // 3b. Dilate the mask (Chebyshev radius r) inside the target
  const r = Math.min(4, Math.max(1, Math.round(box.height * 0.06)));
  const mask = new Uint8Array(cap);
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      let hit = false;
      for (let dy = -r; dy <= r && !hit; dy++) {
        const yy = y + dy;
        if (yy < ty0 || yy >= ty1) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= tx0 && xx < tx1 && strong[yy * W + xx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) mask[y * W + x] = 1;
    }
  }

  // 4a. Distance layers (8-connected BFS from the known pixels), seeded in row-major order
  const layer = new Int32Array(cap); // 0 = known, -1 = masked & unassigned
  const queue = new Int32Array(cap);
  let head = 0, tail = 0;
  for (let k = 0; k < cap; k++) layer[k] = mask[k] ? -1 : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (layer[k] !== -1) continue;
      let nearKnown = false;
      for (let dy = -1; dy <= 1 && !nearKnown; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((dx || dy) && xx >= 0 && xx < W && yy >= 0 && yy < H && layer[yy * W + xx] === 0) {
            nearKnown = true;
            break;
          }
        }
      }
      if (nearKnown) {
        layer[k] = 1;
        queue[tail++] = k;
      }
    }
  }
  while (head < tail) {
    const k = queue[head++];
    const x = k % W, y = (k - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && xx < W && yy >= 0 && yy < H) {
          const kk = yy * W + xx;
          if (layer[kk] === -1) {
            layer[kk] = layer[k] + 1;
            queue[tail++] = kk;
          }
        }
      }
    }
  }

  // 4b. Fill in layer order (the BFS queue is already ordered by layer)
  const work = new Float64Array(cap * 3);
  for (let k = 0; k < cap; k++) {
    work[k * 3] = px[k * 4];
    work[k * 3 + 1] = px[k * 4 + 1];
    work[k * 3 + 2] = px[k * 4 + 2];
  }
  const R = INPAINT_WINDOW_RADIUS;
  for (let q = 0; q < tail; q++) {
    const k = queue[q];
    const x = k % W, y = (k - x) / W;
    const L = layer[k];
    let sw = 0, ar = 0, ag = 0, ab = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        if ((!dx && !dy) || xx < 0 || xx >= W) continue;
        const kk = yy * W + xx;
        const lk = layer[kk];
        if (lk < 0 || lk >= L) continue;
        const w = 1 / (dx * dx + dy * dy);
        sw += w;
        ar += w * work[kk * 3];
        ag += w * work[kk * 3 + 1];
        ab += w * work[kk * 3 + 2];
      }
    }
    if (sw > 0) {
      work[k * 3] = ar / sw;
      work[k * 3 + 1] = ag / sw;
      work[k * 3 + 2] = ab / sw;
    } else {
      const [pr0, pg0, pb0] = planeAt(x, y);
      work[k * 3] = pr0;
      work[k * 3 + 1] = pg0;
      work[k * 3 + 2] = pb0;
    }
  }

  // Patch: reconstructed pixels where masked, original pixels elsewhere
  let filled = 0;
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const k = y * W + x, o = ((y - ty0) * tw + (x - tx0)) * 4;
      if (mask[k]) {
        filled++;
        patch[o] = Math.round(clamp255(work[k * 3]));
        patch[o + 1] = Math.round(clamp255(work[k * 3 + 1]));
        patch[o + 2] = Math.round(clamp255(work[k * 3 + 2]));
      } else {
        patch[o] = px[k * 4];
        patch[o + 1] = px[k * 4 + 1];
        patch[o + 2] = px[k * 4 + 2];
      }
      patch[o + 3] = 255;
    }
  }
  return {
    patch, width: tw, height: th, method: 'inpaint', filledPixels: filled, threshold, sigma, textColor, backgroundColor,
    confidence: Math.max(0.5, Math.min(0.95, 0.95 - sigma / 150)),
  };
}
