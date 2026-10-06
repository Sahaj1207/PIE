import com.pdfimageeditor.image.TextInpainting

// Same five cases as parityCase() in __tests__/textInpainting.test.ts.
fun makeCase(name: String): IntArray {
    val w = 72; val h = 40
    val img = IntArray(w * h)
    fun set(x: Int, y: Int, r: Int, g: Int, b: Int) { img[y * w + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b }
    for (y in 0 until h) for (x in 0 until w) {
        when (name) {
            "flat" -> set(x, y, 250, 250, 250)
            "stripes" -> if ((x / 2) % 2 == 0) set(x, y, 200, 180, 150) else set(x, y, 230, 210, 180)
            "gradient" -> set(x, y, 100 + x * 2, 80 + y, 160)
            "noise" -> set(x, y, (x * 7 + y * 3) % 60 + 150, (x * 13 + y * 5) % 40 + 160, (x * 3 + y * 11) % 50 + 140)
            "blank" -> set(x, y, 240, 240, 240)
        }
    }
    fun paint(x0: Int, y0: Int, ww: Int, hh: Int, r: Int, g: Int, b: Int) {
        for (y in y0 until y0 + hh) for (x in x0 until x0 + ww) set(x, y, r, g, b)
    }
    val c = when (name) { "gradient" -> intArrayOf(250, 250, 250); "noise" -> intArrayOf(30, 40, 50); else -> intArrayOf(10, 10, 10) }
    if (name != "blank") {
        paint(14, 12, 3, 16, c[0], c[1], c[2]); paint(14, 26, 10, 2, c[0], c[1], c[2])
        paint(30, 12, 3, 16, c[0], c[1], c[2]); paint(30, 12, 10, 2, c[0], c[1], c[2])
        paint(46, 12, 3, 16, c[0], c[1], c[2]); paint(52, 12, 3, 16, c[0], c[1], c[2])
    } else {
        paint(30, 15, 1, 1, 235, 235, 235)
    }
    return img
}

fun main() {
    val sb = StringBuilder()
    for (name in listOf("flat", "stripes", "gradient", "noise", "blank")) {
        val r = TextInpainting.reconstruct(makeCase(name), 72, 40, 4, 4, 64, 32, 9, 9, 54, 22)
        sb.append(name).append(' ').append(r.method).append(' ').append(r.filledPixels)
            .append(' ').append(String.format(java.util.Locale.US, "%.6f %.6f", r.threshold, r.sigma))
            .append(' ').append(r.textColor).append(' ').append(r.backgroundColor)
            .append(' ').append(String.format(java.util.Locale.US, "%.6f", r.confidence)).append('\n')
        for (p in r.patch) sb.append(String.format("%06X", p and 0xFFFFFF)).append(' ')
        sb.append('\n')
    }
    print(sb)
}
