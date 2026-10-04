package com.pdfimageeditor.image

import android.content.Intent
import android.graphics.*
import android.net.Uri
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import kotlin.math.*

class ImageProcessingModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val REQUEST_CODE_PICK_IMAGE = 4243
    }

    private val scope = CoroutineScope(Dispatchers.Default)
    private var pendingImagePickerPromise: Promise? = null

    private val activityEventListener: ActivityEventListener = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: android.app.Activity, requestCode: Int, resultCode: Int, data: Intent?) {
            if (requestCode == REQUEST_CODE_PICK_IMAGE) {
                val promise = pendingImagePickerPromise ?: return
                pendingImagePickerPromise = null

                if (resultCode != android.app.Activity.RESULT_OK || data == null || data.data == null) {
                    promise.resolve(null)
                    return
                }

                val uri: Uri = data.data!!
                scope.launch {
                    try {
                        var fileName = "image_" + System.currentTimeMillis() + ".png"
                        var fileSize = 0L

                        reactContext.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                            val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                            val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                            if (cursor.moveToFirst()) {
                                if (nameIndex >= 0) {
                                    val n = cursor.getString(nameIndex)
                                    if (!n.isNullOrBlank()) fileName = n
                                }
                                if (sizeIndex >= 0) fileSize = cursor.getLong(sizeIndex)
                            }
                        }

                        val cacheDir = File(reactContext.cacheDir, "imported_images").apply { if (!exists()) mkdirs() }
                        val safeName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
                        val destFile = File(cacheDir, System.currentTimeMillis().toString() + "_" + safeName)

                        reactContext.contentResolver.openInputStream(uri)?.use { input ->
                            FileOutputStream(destFile).use { output ->
                                input.copyTo(output)
                            }
                        }

                        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeFile(destFile.absolutePath, opts)
                        val width = opts.outWidth
                        val height = opts.outHeight

                        val map = Arguments.createMap().apply {
                            putString("uri", "file://" + destFile.absolutePath)
                            putString("fileName", fileName)
                            putDouble("width", width.toDouble())
                            putDouble("height", height.toDouble())
                            putDouble("fileSize", destFile.length().toDouble())
                        }
                        promise.resolve(map)
                    } catch (e: Exception) {
                        promise.reject("PICK_IMAGE_ERROR", e.message, e)
                    }
                }
            }
        }
    }

    init {
        reactContext.addActivityEventListener(activityEventListener)
    }

    @ReactMethod
    fun pickImageDocument(promise: Promise) {
        val currentActivity = reactContext.currentActivity
        if (currentActivity == null) {
            promise.reject("ACTIVITY_NOT_FOUND", "Cannot launch file picker without active activity")
            return
        }
        pendingImagePickerPromise = promise
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/*"
            }
            currentActivity.startActivityForResult(intent, REQUEST_CODE_PICK_IMAGE)
        } catch (e: Exception) {
            pendingImagePickerPromise = null
            promise.reject("PICK_IMAGE_ERROR", "Failed to launch image picker: " + e.message, e)
        }
    }

    override fun getName(): String = "ImageProcessingModule"

    private data class RGB(val r: Double, val g: Double, val b: Double)

    private data class PlaneFit(val c0: Double, val a: Double, val b: Double)

    @ReactMethod
    fun resolveLocalImageUri(uriString: String, promise: Promise) {
        scope.launch {
            try {
                val uri = Uri.parse(uriString)
                if (uri.scheme == "file") {
                    val path = uri.path ?: uriString.removePrefix("file://")
                    val f = File(path)
                    if (f.exists()) {
                        promise.resolve("file://" + f.absolutePath)
                        return@launch
                    }
                }

                val cacheDir = File(reactContext.cacheDir, "imported_images")
                if (!cacheDir.exists()) cacheDir.mkdirs()

                var fileName = "imported_" + System.currentTimeMillis() + ".png"
                if (uri.scheme == "content") {
                    try {
                        reactContext.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                            val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                            if (cursor.moveToFirst() && nameIndex >= 0) {
                                val n = cursor.getString(nameIndex)
                                if (!n.isNullOrBlank()) fileName = n
                            }
                        }
                    } catch (_: Exception) {}
                }
                if (!fileName.contains(".")) {
                    val mime = if (uri.scheme == "content") reactContext.contentResolver.getType(uri) else null
                    val ext = when (mime) {
                        "image/jpeg", "image/jpg" -> ".jpg"
                        "image/webp" -> ".webp"
                        "image/png" -> ".png"
                        else -> ".png"
                    }
                    fileName += ext
                }
                val safeName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
                val destFile = File(cacheDir, System.currentTimeMillis().toString() + "_" + safeName)

                val inputStream: InputStream = when (uri.scheme) {
                    "content" -> reactContext.contentResolver.openInputStream(uri)
                    "file" -> File(uri.path ?: "").inputStream()
                    else -> {
                        val file = File(uriString)
                        if (file.exists()) file.inputStream() else null
                    }
                } ?: throw IllegalArgumentException("Could not open stream for URI: " + uriString)

                destFile.outputStream().use { out ->
                    inputStream.use { inp ->
                        inp.copyTo(out)
                    }
                }

                promise.resolve("file://" + destFile.absolutePath)
            } catch (e: Exception) {
                promise.reject("RESOLVE_URI_FAILED", "Failed to resolve image URI: " + e.message, e)
            }
        }
    }

    @ReactMethod
    fun reconstructBackground(
        imageUri: String,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        promise: Promise
    ) {
        scope.launch {
            try {
                val bitmap = decodeBitmap(imageUri)
                    ?: throw IllegalArgumentException("Could not load bitmap from URI: $imageUri")

                val imgW = bitmap.width
                val imgH = bitmap.height

                // Expand bounding box with 5px padding for anti-aliasing
                val padding = 5
                val targetX = max(0, (x - padding).toInt())
                val targetY = max(0, (y - padding).toInt())
                val targetRight = min(imgW, (x + width + padding).toInt())
                val targetBottom = min(imgH, (y + height + padding).toInt())
                val targetW = max(1, targetRight - targetX)
                val targetH = max(1, targetBottom - targetY)

                val borderThickness = 4
                val minX = max(0, targetX - borderThickness)
                val maxX = min(imgW - 1, targetRight + borderThickness - 1)
                val minY = max(0, targetY - borderThickness)
                val maxY = min(imgH - 1, targetBottom + borderThickness - 1)

                // Sample perimeter border pixels
                val samplesX = ArrayList<Double>()
                val samplesY = ArrayList<Double>()
                val samplesR = ArrayList<Double>()
                val samplesG = ArrayList<Double>()
                val samplesB = ArrayList<Double>()

                for (py in minY..maxY) {
                    for (px in minX..maxX) {
                        val isInsideTarget = px in targetX until targetRight && py in targetY until targetBottom
                        if (!isInsideTarget) {
                            val pixel = bitmap.getPixel(px, py)
                            samplesX.add(px.toDouble())
                            samplesY.add(py.toDouble())
                            samplesR.add(Color.red(pixel).toDouble())
                            samplesG.add(Color.green(pixel).toDouble())
                            samplesB.add(Color.blue(pixel).toDouble())
                        }
                    }
                }

                val n = samplesX.size
                if (n == 0) {
                    throw IllegalStateException("No surrounding pixels found to reconstruct background")
                }

                val meanR = samplesR.sum() / n
                val meanG = samplesG.sum() / n
                val meanB = samplesB.sum() / n

                val fitR = fitPlane(samplesX, samplesY, samplesR)
                val fitG = fitPlane(samplesX, samplesY, samplesG)
                val fitB = fitPlane(samplesX, samplesY, samplesB)

                // Analyze text color inside original box by contrast against background
                var textCount = 0
                var textSumR = 0.0
                var textSumG = 0.0
                var textSumB = 0.0

                val origX = max(0, x.toInt())
                val origY = max(0, y.toInt())
                val origRight = min(imgW, (x + width).toInt())
                val origBottom = min(imgH, (y + height).toInt())

                for (py in origY until origBottom) {
                    for (px in origX until origRight) {
                        val pixel = bitmap.getPixel(px, py)
                        val pr = Color.red(pixel).toDouble()
                        val pg = Color.green(pixel).toDouble()
                        val pb = Color.blue(pixel).toDouble()

                        val bgR = clampColor(fitR.c0 + fitR.a * px + fitR.b * py)
                        val bgG = clampColor(fitG.c0 + fitG.a * px + fitG.b * py)
                        val bgB = clampColor(fitB.c0 + fitB.a * px + fitB.b * py)

                        val dist = sqrt((pr - bgR).pow(2) + (pg - bgG).pow(2) + (pb - bgB).pow(2))
                        if (dist > 35.0) {
                            textSumR += pr
                            textSumG += pg
                            textSumB += pb
                            textCount++
                        }
                    }
                }

                val estimatedTextColor = if (textCount > 0) {
                    toHex(textSumR / textCount, textSumG / textCount, textSumB / textCount)
                } else {
                    val lum = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB
                    if (lum > 128) "#111827" else "#F9FAFB"
                }

                // Create patch bitmap
                val patchBitmap = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888)

                for (py in targetY until targetBottom) {
                    val localY = py - targetY
                    for (px in targetX until targetRight) {
                        val localX = px - targetX

                        val recR = clampColor(fitR.c0 + fitR.a * px + fitR.b * py)
                        val recG = clampColor(fitG.c0 + fitG.a * px + fitG.b * py)
                        val recB = clampColor(fitB.c0 + fitB.a * px + fitB.b * py)

                        // Feathering at the outer 2px boundary for smooth transition
                        val distToEdge = min(min(localX, targetW - 1 - localX), min(localY, targetH - 1 - localY))
                        val alpha = if (distToEdge < 2) (distToEdge + 1) / 3.0 else 1.0

                        val origPixel = bitmap.getPixel(px, py)
                        val finalR = (recR * alpha + Color.red(origPixel) * (1.0 - alpha)).toInt()
                        val finalG = (recG * alpha + Color.green(origPixel) * (1.0 - alpha)).toInt()
                        val finalB = (recB * alpha + Color.blue(origPixel) * (1.0 - alpha)).toInt()

                        patchBitmap.setPixel(localX, localY, Color.rgb(finalR, finalG, finalB))
                    }
                }

                // Save patch to local cache directory
                val cacheDir = reactContext.cacheDir
                val patchFile = File(cacheDir, "patch_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.png")
                val fos = FileOutputStream(patchFile)
                patchBitmap.compress(Bitmap.CompressFormat.PNG, 100, fos)
                fos.flush()
                fos.close()

                val result = Arguments.createMap()
                result.putString("patchUri", "file://${patchFile.absolutePath}")

                val boundsMap = Arguments.createMap()
                boundsMap.putDouble("x", targetX.toDouble())
                boundsMap.putDouble("y", targetY.toDouble())
                boundsMap.putDouble("width", targetW.toDouble())
                boundsMap.putDouble("height", targetH.toDouble())
                result.putMap("bounds", boundsMap)

                result.putString("estimatedBackgroundColor", toHex(meanR, meanG, meanB))
                result.putString("estimatedTextColor", estimatedTextColor)
                result.putDouble("confidence", 0.92)

                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("BACKGROUND_RECONSTRUCTION_FAILED", e.message, e)
            }
        }
    }

    /**
     * Composites a full-resolution image page (source image + reconstructed patches + replacement text)
     * strictly in 1:1 document coordinates without quality loss or viewport distortion.
     */
    @ReactMethod
    fun exportImagePage(params: ReadableMap, promise: Promise) {
        scope.launch {
            try {
                val sourceImageUri = params.getString("sourceImageUri")
                    ?: throw IllegalArgumentException("Missing sourceImageUri parameter")
                val format = params.getString("format") ?: "png"
                val quality = if (params.hasKey("quality")) params.getDouble("quality") else 95.0

                // 1. Decode original immutable base bitmap at full resolution
                val baseBitmap = decodeBitmap(sourceImageUri)
                    ?: throw IllegalArgumentException("Could not load source bitmap from: $sourceImageUri")

                val width = baseBitmap.width
                val height = baseBitmap.height

                // 2. Create mutable compositing canvas
                val exportBitmap = baseBitmap.copy(Bitmap.Config.ARGB_8888, true)
                val canvas = Canvas(exportBitmap)

                // 3. Layer 2: Draw reconstructed background patches
                if (params.hasKey("patches")) {
                    val patches = params.getArray("patches")
                    if (patches != null) {
                        for (i in 0 until patches.size()) {
                            val patch = patches.getMap(i) ?: continue
                            val patchUri = patch.getString("patchUri") ?: continue
                            val bounds = patch.getMap("bounds") ?: continue

                            val px = bounds.getDouble("x").toFloat()
                            val py = bounds.getDouble("y").toFloat()
                            val pw = bounds.getDouble("width").toFloat()
                            val ph = bounds.getDouble("height").toFloat()

                            val patchBitmap = decodeBitmap(patchUri)
                            if (patchBitmap != null) {
                                val destRect = RectF(px, py, px + pw, py + ph)
                                canvas.drawBitmap(patchBitmap, null, destRect, null)
                            }
                        }
                    }
                }

                // 4. Layer 3: Draw replacement text layer
                if (params.hasKey("textElements")) {
                    val textElements = params.getArray("textElements")
                    if (textElements != null) {
                        for (i in 0 until textElements.size()) {
                            val el = textElements.getMap(i) ?: continue
                            val text = el.getString("text") ?: continue
                            val bounds = el.getMap("bounds") ?: continue
                            val fittedFontSize = el.getDouble("fittedFontSize").toFloat()
                            val baselineY = el.getDouble("baselineY").toFloat()
                            val colorHex = if (el.hasKey("color")) el.getString("color") else "#111827"
                            val fontWeight = if (el.hasKey("fontWeight")) el.getString("fontWeight") else "normal"

                            val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = try {
                                    Color.parseColor(colorHex)
                                } catch (e: Exception) {
                                    Color.BLACK
                                }
                                textSize = fittedFontSize
                                typeface = if (fontWeight == "bold" || fontWeight == "700") {
                                    Typeface.DEFAULT_BOLD
                                } else {
                                    Typeface.DEFAULT
                                }
                            }

                            val tx = bounds.getDouble("x").toFloat() + 1f
                            canvas.drawText(text, tx, baselineY, textPaint)
                        }
                    }
                }

                // 5. Save composited result to exports directory
                val exportDir = File(reactContext.cacheDir, "exports").apply { mkdirs() }
                val isPng = format.equals("png", ignoreCase = true)
                val ext = if (isPng) "png" else "jpg"
                val exportFile = File(exportDir, "export_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.$ext")

                val fos = FileOutputStream(exportFile)
                if (isPng) {
                    exportBitmap.compress(Bitmap.CompressFormat.PNG, 100, fos)
                } else {
                    val compQuality = quality.toInt().coerceIn(1, 100)
                    exportBitmap.compress(Bitmap.CompressFormat.JPEG, compQuality, fos)
                }
                fos.flush()
                fos.close()

                val result = Arguments.createMap()
                result.putString("destinationUri", "file://${exportFile.absolutePath}")
                result.putString("format", if (isPng) "png" else "jpeg")
                result.putDouble("fileSizeBytes", exportFile.length().toDouble())
                result.putDouble("width", width.toDouble())
                result.putDouble("height", height.toDouble())

                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("EXPORT_FAILED", e.message, e)
            }
        }
    }

    /**
     * Native share sheet integration using Android Intent.ACTION_SEND and FileProvider.
     */
    @ReactMethod
    fun shareFile(fileUriString: String, mimeType: String, title: String, promise: Promise) {
        try {
            val uri = Uri.parse(fileUriString)
            val filePath = uri.path ?: fileUriString
            val file = File(filePath)

            if (!file.exists()) {
                promise.reject("EXPORT_FAILED", "File does not exist: $filePath")
                return
            }

            val authority = "${reactContext.packageName}.provider"
            val contentUri = FileProvider.getUriForFile(reactContext, authority, file)

            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, contentUri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            val chooser = Intent.createChooser(sendIntent, title).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            reactContext.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("EXPORT_FAILED", e.message, e)
        }
    }

    private fun fitPlane(xs: List<Double>, ys: List<Double>, cs: List<Double>): PlaneFit {
        val n = xs.size.toDouble()
        var sumX = 0.0
        var sumY = 0.0
        var sumXX = 0.0
        var sumYY = 0.0
        var sumXY = 0.0
        var sumC = 0.0
        var sumXC = 0.0
        var sumYC = 0.0

        for (i in xs.indices) {
            val x = xs[i]
            val y = ys[i]
            val c = cs[i]
            sumX += x
            sumY += y
            sumXX += x * x
            sumYY += y * y
            sumXY += x * y
            sumC += c
            sumXC += x * c
            sumYC += y * c
        }

        val det = n * (sumXX * sumYY - sumXY * sumXY) -
                sumX * (sumX * sumYY - sumXY * sumY) +
                sumY * (sumX * sumXY - sumXX * sumY)

        if (abs(det) < 1e-6) {
            return PlaneFit(sumC / n, 0.0, 0.0)
        }

        val detC0 = sumC * (sumXX * sumYY - sumXY * sumXY) -
                sumX * (sumXC * sumYY - sumXY * sumYC) +
                sumY * (sumXC * sumXY - sumXX * sumYC)

        val detA = n * (sumXC * sumYY - sumXY * sumYC) -
                sumC * (sumX * sumYY - sumXY * sumY) +
                sumY * (sumX * sumYC - sumXC * sumY)

        val detB = n * (sumXX * sumYC - sumXC * sumXY) -
                sumX * (sumX * sumYC - sumXC * sumY) +
                sumC * (sumX * sumXY - sumXX * sumY)

        return PlaneFit(detC0 / det, detA / det, detB / det)
    }

    private fun clampColor(v: Double): Double {
        return max(0.0, min(255.0, v))
    }

    private fun toHex(r: Double, g: Double, b: Double): String {
        val ir = max(0, min(255, r.roundToInt()))
        val ig = max(0, min(255, g.roundToInt()))
        val ib = max(0, min(255, b.roundToInt()))
        return String.format("#%02X%02X%02X", ir, ig, ib)
    }

    private fun decodeBitmap(uriStr: String): Bitmap? {
        val uri = Uri.parse(uriStr)
        val inputStream: InputStream? = when (uri.scheme) {
            "content" -> reactContext.contentResolver.openInputStream(uri)
            "file" -> File(uri.path ?: "").inputStream()
            else -> {
                val file = File(uriStr)
                if (file.exists()) file.inputStream() else null
            }
        }
        return inputStream?.use { BitmapFactory.decodeStream(it) }
    }
}
