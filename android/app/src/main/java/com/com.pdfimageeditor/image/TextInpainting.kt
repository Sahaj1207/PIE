package com.pdfimageeditor.image

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Texture-preserving background reconstruction for image text edits.
 *
 * Port of the reference implementation `src/features/image/textInpainting.ts` (unit-tested;
 * keep both in sync). Deterministic, on-device:
 *  1. plane fit per channel on the border ring around the target;
 *  2. adaptive threshold T = clamp(3 * sigma, 20, 110) from the border noise;
 *  3. text mask = target pixels farther than T from the plane, dilated by
 *     r = clamp(round(0.06 * box height), 1, 4);
 *  4. only masked pixels are filled, outside-in (8-connected distance layers), from the
 *     inverse-squared-distance weighted average of known pixels in a 9x9 window;
 *  5. fallback to the plane fill (2 px feathered edge) when < 0.2% or > 60% of the target is
 *     flagged.
 * All coordinates are region-local (the region = target + border ring).
 */
object TextInpainting {
    private const val MIN_THRESHOLD = 20.0
    private const val MAX_THRESHOLD = 110.0
    private const val WINDOW_RADIUS = 4
    private const val MIN_MASK_FRACTION = 0.002
    private const val MAX_MASK_FRACTION = 0.6

    class Result(
        /** ARGB patch of the target rectangle (opaque). */
        val patch: IntArray,
        val width: Int,
        val height: Int,
        val method: String,
        val filledPixels: Int,
        val threshold: Double,
        val sigma: Double,
        val textColor: String,
        val backgroundColor: String,
        val confidence: Double,
    )

    private class Plane(val c0: Double, val a: Double, val b: Double) {
        fun at(x: Int, y: Int): Double = clamp255(c0 + a * x + b * y)
    }

    private fun clamp255(v: Double): Double = if (v < 0.0) 0.0 else if (v > 255.0) 255.0 else v

    private fun hex(r: Double, g: Double, b: Double): String =
        String.format(
            java.util.Locale.US,
            "#%02X%02X%02X",
            clamp255(r).roundToInt(),
            clamp255(g).roundToInt(),
            clamp255(b).roundToInt()
        )

    private fun fitPlane(xs: DoubleArray, ys: DoubleArray, cs: DoubleArray, n: Int): Plane {
        if (n == 0) return Plane(0.0, 0.0, 0.0)
        var sx = 0.0; var sy = 0.0; var sxx = 0.0; var syy = 0.0; var sxy = 0.0
        var sc = 0.0; var sxc = 0.0; var syc = 0.0
        for (i in 0 until n) {
            val x = xs[i]; val y = ys[i]; val c = cs[i]
            sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sc += c; sxc += x * c; syc += y * c
        }
        val nn = n.toDouble()
        val det = nn * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy)
        if (abs(det) < 1e-6) return Plane(sc / nn, 0.0, 0.0)
        val d0 = sc * (sxx * syy - sxy * sxy) - sx * (sxc * syy - sxy * syc) + sy * (sxc * sxy - sxx * syc)
        val da = nn * (sxc * syy - sxy * syc) - sc * (sx * syy - sxy * sy) + sy * (sx * syc - sxc * sy)
        val db = nn * (sxx * syc - sxc * sxy) - sx * (sx * syc - sxc * sy) + sc * (sx * sxy - sxx * sy)
        return Plane(d0 / det, da / det, db / det)
    }

    /**
     * @param argb region pixels (ARGB, row-major, width w, height h)
     * @param tX..tH target rectangle, @param bX..bH OCR box (region coordinates)
     */
    fun reconstruct(
        argb: IntArray, w: Int, h: Int,
        tX: Int, tY: Int, tW: Int, tH: Int,
        bX: Int, bY: Int, bW: Int, bH: Int,
    ): Result {
        val tx0 = max(0, tX); val ty0 = max(0, tY)
        val tx1 = min(w, tX + tW); val ty1 = min(h, tY + tH)
        val tw = max(1, tx1 - tx0); val th = max(1, ty1 - ty0)
        fun inTarget(x: Int, y: Int) = x in tx0 until tx1 && y in ty0 until ty1
        fun red(k: Int) = (argb[k] shr 16) and 0xFF
        fun green(k: Int) = (argb[k] shr 8) and 0xFF
        fun blue(k: Int) = argb[k] and 0xFF

        // 1. Plane fit on the border ring
        val cap = w * h
        // Border-ring samples only (the region minus the target)
        val ring = max(0, cap - (tx1 - tx0) * (ty1 - ty0))
        val xs = DoubleArray(ring); val ys = DoubleArray(ring)
        val rs = DoubleArray(ring); val gs = DoubleArray(ring); val bs = DoubleArray(ring)
        var n = 0
        var sumR = 0.0; var sumG = 0.0; var sumB = 0.0
        for (y in 0 until h) {
            for (x in 0 until w) {
                if (inTarget(x, y)) continue
                val k = y * w + x
                xs[n] = x.toDouble(); ys[n] = y.toDouble()
                rs[n] = red(k).toDouble(); gs[n] = green(k).toDouble(); bs[n] = blue(k).toDouble()
                sumR += rs[n]; sumG += gs[n]; sumB += bs[n]
                n++
            }
        }
        if (n == 0) throw IllegalStateException("No surrounding pixels found to reconstruct background")
        val pr = fitPlane(xs, ys, rs, n)
        val pg = fitPlane(xs, ys, gs, n)
        val pb = fitPlane(xs, ys, bs, n)
        fun distToPlane(x: Int, y: Int): Double {
            val k = y * w + x
            val dr = red(k) - pr.at(x, y)
            val dg = green(k) - pg.at(x, y)
            val db = blue(k) - pb.at(x, y)
            return sqrt(dr * dr + dg * dg + db * db)
        }

        // 2. Adaptive threshold
        var sq = 0.0
        for (i in 0 until n) {
            val d = distToPlane(xs[i].toInt(), ys[i].toInt())
            sq += d * d
        }
        val sigma = sqrt(sq / n)
        val threshold = min(MAX_THRESHOLD, max(MIN_THRESHOLD, 3.0 * sigma))

        // 3. Strong mask + text colour inside the OCR box
        val strong = BooleanArray(cap)
        var strongCount = 0
        var tr = 0.0; var tg = 0.0; var tb = 0.0; var tc = 0
        for (y in ty0 until ty1) {
            for (x in tx0 until tx1) {
                if (distToPlane(x, y) > threshold) {
                    val k = y * w + x
                    strong[k] = true
                    strongCount++
                    if (x >= bX && x < bX + bW && y >= bY && y < bY + bH) {
                        tr += red(k); tg += green(k); tb += blue(k); tc++
                    }
                }
            }
        }
        val meanR = sumR / n; val meanG = sumG / n; val meanB = sumB / n
        val lum = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB
        val textColor = if (tc > 0) hex(tr / tc, tg / tc, tb / tc) else if (lum > 128) "#111827" else "#F9FAFB"
        val backgroundColor = hex(meanR, meanG, meanB)

        val area = tw * th
        val patch = IntArray(tw * th)
        val fraction = strongCount.toDouble() / area

        // 5. Fallback: plane fill with a 2 px feathered edge
        if (strongCount < max(1.0, area * MIN_MASK_FRACTION) || fraction > MAX_MASK_FRACTION) {
            for (y in ty0 until ty1) {
                for (x in tx0 until tx1) {
                    val lx = x - tx0; val ly = y - ty0
                    val edge = min(min(lx, tw - 1 - lx), min(ly, th - 1 - ly))
                    val alpha = if (edge < 2) (edge + 1) / 3.0 else 1.0
                    val k = y * w + x
                    val r = floor(pr.at(x, y) * alpha + red(k) * (1 - alpha)).toInt()
                    val g = floor(pg.at(x, y) * alpha + green(k) * (1 - alpha)).toInt()
                    val b = floor(pb.at(x, y) * alpha + blue(k) * (1 - alpha)).toInt()
                    patch[ly * tw + lx] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
                }
            }
            return Result(
                patch, tw, th, "plane", area, threshold, sigma, textColor, backgroundColor,
                max(0.3, min(0.75, 0.75 - sigma / 200))
            )
        }

        // 3b. Dilate (Chebyshev radius r) inside the target
        val r = min(4, max(1, (bH * 0.06).roundToInt()))
        val mask = BooleanArray(cap)
        for (y in ty0 until ty1) {
            for (x in tx0 until tx1) {
                var hit = false
                var dy = -r
                while (dy <= r && !hit) {
                    val yy = y + dy
                    if (yy in ty0 until ty1) {
                        for (dx in -r..r) {
                            val xx = x + dx
                            if (xx in tx0 until tx1 && strong[yy * w + xx]) {
                                hit = true
                                break
                            }
                        }
                    }
                    dy++
                }
                if (hit) mask[y * w + x] = true
            }
        }

        // 4a. Distance layers (8-connected BFS), seeded row-major
        val layer = IntArray(cap) { if (mask[it]) -1 else 0 }
        val queue = IntArray(cap)
        var head = 0
        var tail = 0
        for (y in 0 until h) {
            for (x in 0 until w) {
                val k = y * w + x
                if (layer[k] != -1) continue
                var nearKnown = false
                loop@ for (dy in -1..1) {
                    for (dx in -1..1) {
                        val xx = x + dx; val yy = y + dy
                        if ((dx != 0 || dy != 0) && xx in 0 until w && yy in 0 until h && layer[yy * w + xx] == 0) {
                            nearKnown = true
                            break@loop
                        }
                    }
                }
                if (nearKnown) {
                    layer[k] = 1
                    queue[tail++] = k
                }
            }
        }
        while (head < tail) {
            val k = queue[head++]
            val x = k % w; val y = k / w
            for (dy in -1..1) {
                for (dx in -1..1) {
                    val xx = x + dx; val yy = y + dy
                    if ((dx != 0 || dy != 0) && xx in 0 until w && yy in 0 until h) {
                        val kk = yy * w + xx
                        if (layer[kk] == -1) {
                            layer[kk] = layer[k] + 1
                            queue[tail++] = kk
                        }
                    }
                }
            }
        }

        // 4b. Fill in layer order
        val work = DoubleArray(cap * 3)
        for (k in 0 until cap) {
            work[k * 3] = red(k).toDouble()
            work[k * 3 + 1] = green(k).toDouble()
            work[k * 3 + 2] = blue(k).toDouble()
        }
        val rad = WINDOW_RADIUS
        for (q in 0 until tail) {
            val k = queue[q]
            val x = k % w; val y = k / w
            val lvl = layer[k]
            var sw = 0.0; var ar = 0.0; var ag = 0.0; var ab = 0.0
            for (dy in -rad..rad) {
                val yy = y + dy
                if (yy < 0 || yy >= h) continue
                for (dx in -rad..rad) {
                    val xx = x + dx
                    if ((dx == 0 && dy == 0) || xx < 0 || xx >= w) continue
                    val kk = yy * w + xx
                    val lk = layer[kk]
                    if (lk < 0 || lk >= lvl) continue
                    val wgt = 1.0 / (dx * dx + dy * dy)
                    sw += wgt
                    ar += wgt * work[kk * 3]
                    ag += wgt * work[kk * 3 + 1]
                    ab += wgt * work[kk * 3 + 2]
                }
            }
            if (sw > 0) {
                work[k * 3] = ar / sw
                work[k * 3 + 1] = ag / sw
                work[k * 3 + 2] = ab / sw
            } else {
                work[k * 3] = pr.at(x, y)
                work[k * 3 + 1] = pg.at(x, y)
                work[k * 3 + 2] = pb.at(x, y)
            }
        }

        var filled = 0
        for (y in ty0 until ty1) {
            for (x in tx0 until tx1) {
                val k = y * w + x
                val o = (y - ty0) * tw + (x - tx0)
                patch[o] = if (mask[k]) {
                    filled++
                    val rr = clamp255(work[k * 3]).roundToInt()
                    val gg = clamp255(work[k * 3 + 1]).roundToInt()
                    val bb = clamp255(work[k * 3 + 2]).roundToInt()
                    (0xFF shl 24) or (rr shl 16) or (gg shl 8) or bb
                } else {
                    argb[k] or (0xFF shl 24)
                }
            }
        }
        return Result(
            patch, tw, th, "inpaint", filled, threshold, sigma, textColor, backgroundColor,
            max(0.5, min(0.95, 0.95 - sigma / 150))
        )
    }
}
