// Texture-preserving background reconstruction for image text edits (iOS).
//
// C port of the reference implementation src/features/image/textInpainting.ts (unit-tested)
// and of android/.../image/TextInpainting.kt; keep all three in sync. Dependency-free C99
// (compiler builtins only) so the same code is verified off-device. Deterministic, on-device:
//  1. plane fit per channel on the border ring around the target;
//  2. adaptive threshold T = clamp(3 * sigma, 20, 110) from the border noise;
//  3. text mask = target pixels farther than T from the plane, dilated by
//     r = clamp(round(0.06 * box height), 1, 4);
//  4. only masked pixels are filled, outside-in (8-connected distance layers), from the
//     inverse-squared-distance weighted average of known pixels in a 9x9 window;
//  5. fallback to the plane fill (2 px feathered edge) when < 0.2% or > 60% of the target is
//     flagged.
// All coordinates are region-local (region = target + border ring). RGBA 8-bit buffers.
#ifndef PIE_TEXT_INPAINTING_H
#define PIE_TEXT_INPAINTING_H

#include <stddef.h>
#include <stdint.h>

#define PIE_INPAINT_MIN_THRESHOLD 20.0
#define PIE_INPAINT_MAX_THRESHOLD 110.0
#define PIE_INPAINT_WINDOW_RADIUS 4
#define PIE_INPAINT_MIN_MASK_FRACTION 0.002
#define PIE_INPAINT_MAX_MASK_FRACTION 0.6

typedef struct {
  int method;          // 1 = inpaint, 0 = plane fill (fallback)
  int filledPixels;
  double threshold;
  double sigma;
  double confidence;
  int hasTextColor;    // text colour measured inside the OCR box
  double textR, textG, textB;
  double meanR, meanG, meanB;  // background (border ring) mean
} PieInpaintResult;

typedef struct { double c0, a, b; } PieInpaintPlane;

static inline double pie_inp_clamp255(double v) { return v < 0.0 ? 0.0 : (v > 255.0 ? 255.0 : v); }
static inline int pie_inp_round(double v) { return (int)__builtin_floor(v + 0.5); }
static inline double pie_inp_plane_at(const PieInpaintPlane *p, int x, int y) {
  return pie_inp_clamp255(p->c0 + p->a * x + p->b * y);
}

static inline PieInpaintPlane pie_inp_fit_plane(const double *xs, const double *ys, const double *cs, size_t n) {
  PieInpaintPlane p = {0.0, 0.0, 0.0};
  if (n == 0) return p;
  double sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sc = 0, sxc = 0, syc = 0;
  for (size_t i = 0; i < n; i++) {
    double x = xs[i], y = ys[i], c = cs[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sc += c; sxc += x * c; syc += y * c;
  }
  double nn = (double)n;
  double det = nn * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (__builtin_fabs(det) < 1e-6) { p.c0 = sc / nn; return p; }
  double d0 = sc * (sxx * syy - sxy * sxy) - sx * (sxc * syy - sxy * syc) + sy * (sxc * sxy - sxx * syc);
  double da = nn * (sxc * syy - sxy * syc) - sc * (sx * syy - sxy * sy) + sy * (sx * syc - sxc * sy);
  double db = nn * (sxx * syc - sxc * sxy) - sx * (sx * syc - sxc * sy) + sc * (sx * sxy - sxx * sy);
  p.c0 = d0 / det; p.a = da / det; p.b = db / det;
  return p;
}

/** Colour distance of pixel (x, y) from the fitted background planes. */
static inline double pie_inp_dist(const uint8_t *px, int w, const PieInpaintPlane *pr, const PieInpaintPlane *pg,
                                  const PieInpaintPlane *pb, int x, int y) {
  const uint8_t *q = px + ((size_t)y * w + x) * 4;
  double dr = q[0] - pie_inp_plane_at(pr, x, y);
  double dg = q[1] - pie_inp_plane_at(pg, x, y);
  double db = q[2] - pie_inp_plane_at(pb, x, y);
  return __builtin_sqrt(dr * dr + dg * dg + db * db);
}

/** Bytes of scratch memory PieReconstructTextPatch needs for a w x h region. */
static inline size_t PieInpaintScratchSize(int w, int h) {
  size_t cap = (size_t)w * (size_t)h;
  // work(3) + border ring xs, ys, rs, gs, bs doubles (ring <= cap; sized for the worst case so
  // the caller does not need the target) | layer, queue int32 | strong, mask bytes
  return cap * 3 * sizeof(double) + cap * 5 * sizeof(double) + cap * 2 * sizeof(int32_t) + cap * 2 + 64;
}

/** Scratch bytes when the target rectangle (clamped to the region) is known: smaller ring. */
static inline size_t PieInpaintScratchSizeForTarget(int w, int h, int tW, int tH) {
  size_t cap = (size_t)w * (size_t)h;
  size_t inner = (size_t)(tW > 0 ? tW : 0) * (size_t)(tH > 0 ? tH : 0);
  size_t ring = cap > inner ? cap - inner : 0;
  return cap * 3 * sizeof(double) + ring * 5 * sizeof(double) + cap * 2 * sizeof(int32_t) + cap * 2 + 64;
}

/**
 * Writes the RGBA patch of the target rectangle into `patchOut` (tW' x tH' x 4 bytes, where the
 * target is clamped to the region). `scratch` must hold PieInpaintScratchSize(w, h) bytes.
 * Returns 0 on success, -1 when the region has no border ring to sample.
 */
static inline int PieReconstructTextPatch(const uint8_t *px, int w, int h,
                                          int tX, int tY, int tW, int tH,
                                          int bX, int bY, int bW, int bH,
                                          uint8_t *patchOut, void *scratch, PieInpaintResult *res) {
  const int tx0 = tX > 0 ? tX : 0, ty0 = tY > 0 ? tY : 0;
  const int tx1 = (tX + tW) < w ? (tX + tW) : w, ty1 = (tY + tH) < h ? (tY + tH) : h;
  const int tw = (tx1 - tx0) > 1 ? (tx1 - tx0) : 1, th = (ty1 - ty0) > 1 ? (ty1 - ty0) : 1;
  const size_t cap = (size_t)w * (size_t)h;

  const size_t inner = (size_t)(tx1 > tx0 ? tx1 - tx0 : 0) * (size_t)(ty1 > ty0 ? ty1 - ty0 : 0);
  const size_t ring = cap > inner ? cap - inner : 0;
  double *work = (double *)scratch;
  double *xs = work + cap * 3;
  double *ys = xs + ring, *rs = ys + ring, *gs = rs + ring, *bs = gs + ring;
  int32_t *layer = (int32_t *)(bs + ring);
  int32_t *queue = layer + cap;
  uint8_t *strong = (uint8_t *)(queue + cap);
  uint8_t *mask = strong + cap;

  // 1. Plane fit on the border ring
  size_t n = 0;
  double sumR = 0, sumG = 0, sumB = 0;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      if (x >= tx0 && x < tx1 && y >= ty0 && y < ty1) continue;
      const uint8_t *p = px + ((size_t)y * w + x) * 4;
      xs[n] = x; ys[n] = y; rs[n] = p[0]; gs[n] = p[1]; bs[n] = p[2];
      sumR += p[0]; sumG += p[1]; sumB += p[2];
      n++;
    }
  }
  if (n == 0) return -1;
  PieInpaintPlane pr = pie_inp_fit_plane(xs, ys, rs, n);
  PieInpaintPlane pg = pie_inp_fit_plane(xs, ys, gs, n);
  PieInpaintPlane pb = pie_inp_fit_plane(xs, ys, bs, n);

  // 2. Adaptive threshold
  double sq = 0;
  for (size_t k = 0; k < n; k++) {
    double d = pie_inp_dist(px, w, &pr, &pg, &pb, (int)xs[k], (int)ys[k]);
    sq += d * d;
  }
  const double sigma = __builtin_sqrt(sq / (double)n);
  double threshold = 3.0 * sigma;
  if (threshold < PIE_INPAINT_MIN_THRESHOLD) threshold = PIE_INPAINT_MIN_THRESHOLD;
  if (threshold > PIE_INPAINT_MAX_THRESHOLD) threshold = PIE_INPAINT_MAX_THRESHOLD;

  // 3. Strong mask + text colour inside the OCR box
  for (size_t k = 0; k < cap; k++) { strong[k] = 0; mask[k] = 0; }
  int strongCount = 0, tc = 0;
  double tr = 0, tg = 0, tb = 0;
  for (int y = ty0; y < ty1; y++) {
    for (int x = tx0; x < tx1; x++) {
      if (pie_inp_dist(px, w, &pr, &pg, &pb, x, y) > threshold) {
        size_t k = (size_t)y * w + x;
        strong[k] = 1;
        strongCount++;
        if (x >= bX && x < bX + bW && y >= bY && y < bY + bH) {
          tr += px[k * 4]; tg += px[k * 4 + 1]; tb += px[k * 4 + 2]; tc++;
        }
      }
    }
  }
  res->threshold = threshold;
  res->sigma = sigma;
  res->meanR = sumR / (double)n; res->meanG = sumG / (double)n; res->meanB = sumB / (double)n;
  res->hasTextColor = tc > 0;
  res->textR = tc > 0 ? tr / tc : 0; res->textG = tc > 0 ? tg / tc : 0; res->textB = tc > 0 ? tb / tc : 0;

  const int area = tw * th;
  const double fraction = (double)strongCount / (double)area;
  const double minCount = area * PIE_INPAINT_MIN_MASK_FRACTION > 1.0 ? area * PIE_INPAINT_MIN_MASK_FRACTION : 1.0;

  // 5. Fallback: plane fill with a 2 px feathered edge
  if ((double)strongCount < minCount || fraction > PIE_INPAINT_MAX_MASK_FRACTION) {
    for (int y = ty0; y < ty1; y++) {
      for (int x = tx0; x < tx1; x++) {
        int lx = x - tx0, ly = y - ty0;
        int e1 = lx < (tw - 1 - lx) ? lx : (tw - 1 - lx);
        int e2 = ly < (th - 1 - ly) ? ly : (th - 1 - ly);
        int edge = e1 < e2 ? e1 : e2;
        double alpha = edge < 2 ? (edge + 1) / 3.0 : 1.0;
        const uint8_t *p = px + ((size_t)y * w + x) * 4;
        uint8_t *o = patchOut + ((size_t)ly * tw + lx) * 4;
        o[0] = (uint8_t)__builtin_floor(pie_inp_plane_at(&pr, x, y) * alpha + p[0] * (1 - alpha));
        o[1] = (uint8_t)__builtin_floor(pie_inp_plane_at(&pg, x, y) * alpha + p[1] * (1 - alpha));
        o[2] = (uint8_t)__builtin_floor(pie_inp_plane_at(&pb, x, y) * alpha + p[2] * (1 - alpha));
        o[3] = 255;
      }
    }
    double conf = 0.75 - sigma / 200.0;
    res->method = 0;
    res->filledPixels = area;
    res->confidence = conf < 0.3 ? 0.3 : (conf > 0.75 ? 0.75 : conf);
    return 0;
  }

  // 3b. Dilate (Chebyshev radius r) inside the target
  int r = pie_inp_round(bH * 0.06);
  if (r < 1) r = 1;
  if (r > 4) r = 4;
  for (int y = ty0; y < ty1; y++) {
    for (int x = tx0; x < tx1; x++) {
      int hit = 0;
      for (int dy = -r; dy <= r && !hit; dy++) {
        int yy = y + dy;
        if (yy < ty0 || yy >= ty1) continue;
        for (int dx = -r; dx <= r; dx++) {
          int xx = x + dx;
          if (xx >= tx0 && xx < tx1 && strong[(size_t)yy * w + xx]) { hit = 1; break; }
        }
      }
      if (hit) mask[(size_t)y * w + x] = 1;
    }
  }

  // 4a. Distance layers (8-connected BFS), seeded row-major
  size_t head = 0, tail = 0;
  for (size_t k = 0; k < cap; k++) layer[k] = mask[k] ? -1 : 0;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      size_t k = (size_t)y * w + x;
      if (layer[k] != -1) continue;
      int nearKnown = 0;
      for (int dy = -1; dy <= 1 && !nearKnown; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          int xx = x + dx, yy = y + dy;
          if ((dx || dy) && xx >= 0 && xx < w && yy >= 0 && yy < h && layer[(size_t)yy * w + xx] == 0) { nearKnown = 1; break; }
        }
      }
      if (nearKnown) { layer[k] = 1; queue[tail++] = (int32_t)k; }
    }
  }
  while (head < tail) {
    size_t k = (size_t)queue[head++];
    int x = (int)(k % (size_t)w), y = (int)(k / (size_t)w);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        int xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && xx < w && yy >= 0 && yy < h) {
          size_t kk = (size_t)yy * w + xx;
          if (layer[kk] == -1) { layer[kk] = layer[k] + 1; queue[tail++] = (int32_t)kk; }
        }
      }
    }
  }

  // 4b. Fill in layer order
  for (size_t k = 0; k < cap; k++) {
    work[k * 3] = px[k * 4]; work[k * 3 + 1] = px[k * 4 + 1]; work[k * 3 + 2] = px[k * 4 + 2];
  }
  const int R = PIE_INPAINT_WINDOW_RADIUS;
  for (size_t q = 0; q < tail; q++) {
    size_t k = (size_t)queue[q];
    int x = (int)(k % (size_t)w), y = (int)(k / (size_t)w);
    int32_t L = layer[k];
    double sw = 0, ar = 0, ag = 0, ab = 0;
    for (int dy = -R; dy <= R; dy++) {
      int yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (int dx = -R; dx <= R; dx++) {
        int xx = x + dx;
        if ((!dx && !dy) || xx < 0 || xx >= w) continue;
        size_t kk = (size_t)yy * w + xx;
        int32_t lk = layer[kk];
        if (lk < 0 || lk >= L) continue;
        double wt = 1.0 / (double)(dx * dx + dy * dy);
        sw += wt; ar += wt * work[kk * 3]; ag += wt * work[kk * 3 + 1]; ab += wt * work[kk * 3 + 2];
      }
    }
    if (sw > 0) {
      work[k * 3] = ar / sw; work[k * 3 + 1] = ag / sw; work[k * 3 + 2] = ab / sw;
    } else {
      work[k * 3] = pie_inp_plane_at(&pr, x, y);
      work[k * 3 + 1] = pie_inp_plane_at(&pg, x, y);
      work[k * 3 + 2] = pie_inp_plane_at(&pb, x, y);
    }
  }

  int filled = 0;
  for (int y = ty0; y < ty1; y++) {
    for (int x = tx0; x < tx1; x++) {
      size_t k = (size_t)y * w + x;
      uint8_t *o = patchOut + ((size_t)(y - ty0) * tw + (x - tx0)) * 4;
      if (mask[k]) {
        filled++;
        o[0] = (uint8_t)pie_inp_round(pie_inp_clamp255(work[k * 3]));
        o[1] = (uint8_t)pie_inp_round(pie_inp_clamp255(work[k * 3 + 1]));
        o[2] = (uint8_t)pie_inp_round(pie_inp_clamp255(work[k * 3 + 2]));
      } else {
        o[0] = px[k * 4]; o[1] = px[k * 4 + 1]; o[2] = px[k * 4 + 2];
      }
      o[3] = 255;
    }
  }
  double conf = 0.95 - sigma / 150.0;
  res->method = 1;
  res->filledPixels = filled;
  res->confidence = conf < 0.5 ? 0.5 : (conf > 0.95 ? 0.95 : conf);
  return 0;
}

#endif  // PIE_TEXT_INPAINTING_H
