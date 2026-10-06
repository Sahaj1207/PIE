package com.pdfimageeditor.image

import android.app.ActivityManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.*
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
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

    /**
     * Imports an image into durable app-private document storage.
     *
     * - The source (content:// or file) is only read, never modified.
     * - Enforces the pixel budget before any full decode (OOM guard).
     * - Applies EXIF orientation so the working copy is stored upright; upright
     *   JPEG/PNG/WebP files are byte-copied (no re-encode, no quality loss). Rotated or
     *   other formats (e.g. HEIF) are decoded and re-encoded once (PNG for PNG/WebP sources,
     *   otherwise JPEG quality 100).
     * - Writes a downsampled display preview when the image exceeds previewMaxDimension.
     */
    @ReactMethod
    fun importImageDocument(
        sourceUri: String,
        destDirPath: String,
        maxPixels: Double,
        previewMaxDimension: Double,
        promise: Promise
    ) {
        scope.launch {
            var tmpFile: File? = null
            try {
                val destDir = File(destDirPath.removePrefix("file://"))
                if (!destDir.exists()) destDir.mkdirs()

                val tmp = File(destDir, ".import_${System.currentTimeMillis()}.tmp")
                tmpFile = tmp
                val input = openImageStream(sourceUri)
                    ?: throw IllegalArgumentException("Could not open image for import: $sourceUri")
                input.use { inp ->
                    FileOutputStream(tmp).use { out -> inp.copyTo(out) }
                }

                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(tmp.absolutePath, bounds)
                val rawW = bounds.outWidth
                val rawH = bounds.outHeight
                if (rawW <= 0 || rawH <= 0) {
                    tmp.delete()
                    promise.reject("IMAGE_DECODE_FAILED", "The selected file could not be decoded as an image.")
                    return@launch
                }
                if (rawW.toLong() * rawH.toLong() > maxPixels.toLong()) {
                    tmp.delete()
                    promise.reject(
                        "IMAGE_TOO_LARGE",
                        "Image is too large to edit on this device (${rawW}x${rawH})."
                    )
                    return@launch
                }

                val mime = bounds.outMimeType ?: "image/jpeg"
                val orientation = readExifOrientation(tmp)
                val needsRotation = orientation in 2..8
                val passthroughFormat = mime == "image/jpeg" || mime == "image/png" || mime == "image/webp"

                val working: File
                val outW: Int
                val outH: Int
                val outMime: String

                if (!needsRotation && passthroughFormat) {
                    val ext = when (mime) {
                        "image/png" -> "png"
                        "image/webp" -> "webp"
                        else -> "jpg"
                    }
                    working = File(destDir, "working.$ext")
                    if (working.exists()) working.delete()
                    if (!tmp.renameTo(working)) {
                        tmp.copyTo(working, overwrite = true)
                        tmp.delete()
                    }
                    outW = rawW
                    outH = rawH
                    outMime = mime
                } else {
                    val bytesNeeded = rawW.toLong() * rawH.toLong() * 4L * (if (needsRotation) 2L else 1L)
                    if (!canAllocateBitmaps(bytesNeeded)) {
                        tmp.delete()
                        promise.reject(
                            "IMAGE_TOO_LARGE",
                            "This ${megapixels(rawW, rawH)} MP image needs more memory than is free on this device. Close other apps and try again, or use a smaller image."
                        )
                        return@launch
                    }
                    val decoded = BitmapFactory.decodeFile(
                        tmp.absolutePath,
                        BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
                    )
                    if (decoded == null) {
                        tmp.delete()
                        promise.reject("IMAGE_DECODE_FAILED", "The selected image could not be decoded.")
                        return@launch
                    }
                    val upright = if (needsRotation) {
                        val rotated = Bitmap.createBitmap(
                            decoded, 0, 0, decoded.width, decoded.height, exifMatrix(orientation), true
                        )
                        if (rotated !== decoded) decoded.recycle()
                        rotated
                    } else {
                        decoded
                    }
                    val asPng = mime == "image/png" || mime == "image/webp"
                    working = File(destDir, if (asPng) "working.png" else "working.jpg")
                    FileOutputStream(working).use { out ->
                        upright.compress(
                            if (asPng) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,
                            100,
                            out
                        )
                    }
                    outW = upright.width
                    outH = upright.height
                    outMime = if (asPng) "image/png" else "image/jpeg"
                    upright.recycle()
                    tmp.delete()
                }

                val previewUri = writeDisplayPreview(working, outW, outH, previewMaxDimension.toInt(), destDir)

                val result = Arguments.createMap().apply {
                    putString("workingUri", "file://" + working.absolutePath)
                    putString("previewUri", previewUri ?: ("file://" + working.absolutePath))
                    putDouble("width", outW.toDouble())
                    putDouble("height", outH.toDouble())
                    putString("mimeType", outMime)
                    putDouble("exifOrientation", orientation.toDouble())
                    putDouble("fileSizeBytes", working.length().toDouble())
                }
                promise.resolve(result)
            } catch (oom: OutOfMemoryError) {
                tmpFile?.delete()
                promise.reject("IMAGE_TOO_LARGE", "Not enough memory to import this image.", oom)
            } catch (e: Exception) {
                tmpFile?.delete()
                promise.reject("IMAGE_IMPORT_FAILED", "Failed to import image: " + e.message, e)
            }
        }
    }

    /**
     * True when `bytes` of bitmap memory can be allocated without risking an out-of-memory kill.
     * Android 8+ keeps bitmap pixels in native memory (bounded by free device RAM); older
     * versions keep them on the Java heap (bounded by the app's heap limit).
     */
    private fun canAllocateBitmaps(bytes: Long): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val am = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return true
            val info = ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            val usable = (info.availMem - info.threshold).coerceAtLeast(0L)
            bytes <= (usable * 0.6).toLong()
        } else {
            val rt = Runtime.getRuntime()
            val free = rt.maxMemory() - (rt.totalMemory() - rt.freeMemory())
            bytes <= (free * 0.85).toLong()
        }
    }

    /** Megapixels for user-facing messages. */
    private fun megapixels(w: Int, h: Int): String = String.format(java.util.Locale.US, "%.0f", w.toLong() * h.toLong() / 1_000_000.0)

    /** Writes a downsampled preview (longest side <= maxDim). Returns its URI, or null if not needed. */
    private fun writeDisplayPreview(working: File, width: Int, height: Int, maxDim: Int, destDir: File): String? {
        if (maxDim <= 0 || max(width, height) <= maxDim) return null
        return try {
            var sample = 1
            while (max(width, height) / (sample * 2) >= maxDim) {
                sample *= 2
            }
            val sampled = BitmapFactory.decodeFile(
                working.absolutePath,
                BitmapFactory.Options().apply {
                    inSampleSize = sample
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
            ) ?: return null
            val longest = max(sampled.width, sampled.height)
            val preview = if (longest > maxDim) {
                val s = maxDim.toFloat() / longest
                Bitmap.createScaledBitmap(
                    sampled,
                    max(1, (sampled.width * s).roundToInt()),
                    max(1, (sampled.height * s).roundToInt()),
                    true
                )
            } else {
                sampled
            }
            if (preview !== sampled) sampled.recycle()
            val hasAlpha = preview.hasAlpha()
            val previewFile = File(destDir, if (hasAlpha) "preview.png" else "preview.jpg")
            FileOutputStream(previewFile).use { out ->
                preview.compress(
                    if (hasAlpha) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,
                    90,
                    out
                )
            }
            preview.recycle()
            "file://" + previewFile.absolutePath
        } catch (oom: OutOfMemoryError) {
            null
        } catch (e: Exception) {
            null
        }
    }

    private fun readExifOrientation(file: File): Int {
        return try {
            ExifInterface(file.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    /** Matrix that transforms raw sensor pixels into the upright image for an EXIF orientation. */
    private fun exifMatrix(orientation: Int): Matrix {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                m.setRotate(180f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.setRotate(90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.setRotate(-90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
        }
        return m
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
        runReconstruction(imageUri, x, y, width, height, reactContext.cacheDir, promise)
    }

    /**
     * Same deterministic reconstruction, writing the patch PNG into an app-private
     * directory (the editing session's patch directory) instead of the purgeable cache.
     */
    @ReactMethod
    fun reconstructBackgroundToDirectory(
        imageUri: String,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        outputDir: String,
        promise: Promise
    ) {
        val dir = File(outputDir.removePrefix("file://"))
        runReconstruction(imageUri, x, y, width, height, dir, promise)
    }

    private fun runReconstruction(
        imageUri: String,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        outputDir: File,
        promise: Promise
    ) {
        scope.launch {
            var sourceBitmap: Bitmap? = null
            var patchBitmap: Bitmap? = null
            try {
                // Image dimensions without decoding pixels (full decode only if the header is unreadable)
                val headerBounds = decodeImageBounds(imageUri)
                val preDecoded: Bitmap? = if (headerBounds.first <= 0 || headerBounds.second <= 0) {
                    decodeBitmap(imageUri)
                        ?: throw IllegalArgumentException("Could not load bitmap from URI: $imageUri")
                } else {
                    null
                }
                if (preDecoded != null) sourceBitmap = preDecoded
                val imgW = preDecoded?.width ?: headerBounds.first
                val imgH = preDecoded?.height ?: headerBounds.second

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

                // Decode only the region needed (target + sampling border). Falls back to a
                // full decode (offset 0,0) if region decoding is unsupported for the format.
                val regionBitmap: Bitmap? = if (preDecoded == null && maxX >= minX && maxY >= minY) {
                    decodeImageRegion(imageUri, Rect(minX, minY, maxX + 1, maxY + 1))
                } else {
                    null
                }
                val offsetX: Int
                val offsetY: Int
                val bitmap: Bitmap
                if (regionBitmap != null) {
                    bitmap = regionBitmap
                    offsetX = minX
                    offsetY = minY
                } else {
                    bitmap = preDecoded
                        ?: decodeBitmap(imageUri)
                        ?: throw IllegalArgumentException("Could not load bitmap from URI: $imageUri")
                    offsetX = 0
                    offsetY = 0
                }
                sourceBitmap = bitmap

                // Region pixels (target + sampling border) in one bulk read
                val regW = maxX - minX + 1
                val regH = maxY - minY + 1
                if (regW <= 0 || regH <= 0) throw IllegalArgumentException("Invalid reconstruction region")
                val regionPixels = IntArray(regW * regH)
                bitmap.getPixels(regionPixels, 0, regW, minX - offsetX, minY - offsetY, regW, regH)

                // Texture-preserving reconstruction (TextInpainting.kt; reference: textInpainting.ts)
                val origX = max(0, x.toInt())
                val origY = max(0, y.toInt())
                val origRight = min(imgW, (x + width).toInt())
                val origBottom = min(imgH, (y + height).toInt())
                val recon = TextInpainting.reconstruct(
                    regionPixels, regW, regH,
                    targetX - minX, targetY - minY, targetW, targetH,
                    origX - minX, origY - minY, max(1, origRight - origX), max(1, origBottom - origY)
                )

                val patch = Bitmap.createBitmap(recon.patch, recon.width, recon.height, Bitmap.Config.ARGB_8888)
                patchBitmap = patch

                // Save patch into the requested directory
                if (!outputDir.exists()) outputDir.mkdirs()
                val patchFile = File(outputDir, "patch_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.png")
                FileOutputStream(patchFile).use { fos ->
                    patch.compress(Bitmap.CompressFormat.PNG, 100, fos)
                    fos.flush()
                }

                val result = Arguments.createMap()
                result.putString("patchUri", "file://${patchFile.absolutePath}")

                val boundsMap = Arguments.createMap()
                boundsMap.putDouble("x", targetX.toDouble())
                boundsMap.putDouble("y", targetY.toDouble())
                boundsMap.putDouble("width", targetW.toDouble())
                boundsMap.putDouble("height", targetH.toDouble())
                result.putMap("bounds", boundsMap)

                result.putString("estimatedBackgroundColor", recon.backgroundColor)
                result.putString("estimatedTextColor", recon.textColor)
                result.putDouble("confidence", recon.confidence)
                result.putString("method", recon.method)
                result.putInt("filledPixels", recon.filledPixels)

                promise.resolve(result)
            } catch (oom: OutOfMemoryError) {
                promise.reject("BACKGROUND_RECONSTRUCTION_FAILED", "Not enough memory to reconstruct this region.", oom)
            } catch (e: Exception) {
                promise.reject("BACKGROUND_RECONSTRUCTION_FAILED", e.message, e)
            } finally {
                sourceBitmap?.recycle()
                patchBitmap?.recycle()
            }
        }
    }

    /**
     * Composites a full-resolution image page (source image + reconstructed patches + replacement text)
     * strictly in 1:1 document coordinates without quality loss or viewport distortion.
     *
     * Optional params: destination ("file" | "gallery"), displayName, maxPixels.
     * The export file is always written to cacheDir/exports (used by Share). With
     * destination "gallery" on Android 10+ it is additionally published to MediaStore
     * Pictures/PIE without any storage permission. On older Android versions the result
     * reports savedToGallery=false and the caller offers Share instead.
     */
    @ReactMethod
    fun exportImagePage(params: ReadableMap, promise: Promise) {
        scope.launch {
            var exportBitmap: Bitmap? = null
            try {
                val sourceImageUri = params.getString("sourceImageUri")
                    ?: throw IllegalArgumentException("Missing sourceImageUri parameter")
                val format = params.getString("format") ?: "png"
                val quality = if (params.hasKey("quality")) params.getDouble("quality") else 95.0
                val destination = if (params.hasKey("destination")) params.getString("destination") ?: "file" else "file"
                val rawDisplayName = if (params.hasKey("displayName")) params.getString("displayName") else null
                val maxPixels = if (params.hasKey("maxPixels")) params.getDouble("maxPixels").toLong() else Long.MAX_VALUE

                // 0. Pixel budget check before allocating the full-resolution canvas
                val (srcW, srcH) = decodeImageBounds(sourceImageUri)
                if (srcW > 0 && srcH > 0 && srcW.toLong() * srcH.toLong() > maxPixels) {
                    promise.reject("EXPORT_TOO_LARGE", "Image is too large to export on this device (${srcW}x${srcH}).")
                    return@launch
                }
                if (srcW > 0 && srcH > 0 && !canAllocateBitmaps(srcW.toLong() * srcH.toLong() * 5L)) {
                    promise.reject(
                        "EXPORT_TOO_LARGE",
                        "Exporting this ${megapixels(srcW, srcH)} MP image at full resolution needs more memory than is free right now. Close other apps and try again."
                    )
                    return@launch
                }

                // 1. Decode original immutable base image directly into a mutable bitmap (no extra copy)
                val decodeOpts = BitmapFactory.Options().apply {
                    inMutable = true
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                var base = decodeBitmap(sourceImageUri, decodeOpts)
                    ?: throw IllegalArgumentException("Could not load source bitmap from: $sourceImageUri")
                if (!base.isMutable) {
                    val mutableCopy = base.copy(Bitmap.Config.ARGB_8888, true)
                    base.recycle()
                    base = mutableCopy
                }
                exportBitmap = base

                val width = base.width
                val height = base.height

                // 2. Create compositing canvas
                val canvas = Canvas(base)

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
                                patchBitmap.recycle()
                            }
                        }
                    }
                }

                // 4. Layer 3: Draw replacement / added text layer (values from the shared render plan)
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
                            val fontStyle = if (el.hasKey("fontStyle")) el.getString("fontStyle") else "normal"
                            val fontFamily = if (el.hasKey("fontFamily")) el.getString("fontFamily") else null

                            val isBold = fontWeight == "bold" || (fontWeight?.toIntOrNull() ?: 400) >= 600
                            val isItalic = fontStyle == "italic"
                            val typefaceStyle = when {
                                isBold && isItalic -> Typeface.BOLD_ITALIC
                                isBold -> Typeface.BOLD
                                isItalic -> Typeface.ITALIC
                                else -> Typeface.NORMAL
                            }

                            val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = try {
                                    Color.parseColor(colorHex)
                                } catch (e: Exception) {
                                    Color.BLACK
                                }
                                textSize = fittedFontSize
                                typeface = Typeface.create(fontFamily ?: "sans-serif", typefaceStyle)
                            }

                            // Multi-line layers: draw exactly the lines the shared render plan
                            // laid out (same breaks and positions as the on-screen canvas).
                            val lines = if (el.hasKey("lines")) el.getArray("lines") else null
                            if (lines != null && lines.size() > 0) {
                                for (li in 0 until lines.size()) {
                                    val line = lines.getMap(li) ?: continue
                                    val lineText = line.getString("text") ?: continue
                                    if (lineText.isEmpty()) continue
                                    canvas.drawText(
                                        lineText,
                                        line.getDouble("x").toFloat(),
                                        line.getDouble("baselineY").toFloat(),
                                        textPaint,
                                    )
                                }
                                continue
                            }

                            val tx = if (el.hasKey("drawX")) {
                                el.getDouble("drawX").toFloat()
                            } else {
                                bounds.getDouble("x").toFloat() + 1f
                            }
                            canvas.drawText(text, tx, baselineY, textPaint)
                        }
                    }
                }

                // 4b. Markup layer: ink, highlighter, shapes and signatures (shared path commands)
                if (params.hasKey("drawings")) {
                    val drawings = params.getArray("drawings")
                    if (drawings != null) drawMarkup(canvas, drawings)
                }

                // 5. Save composited result to exports directory (used for Share)
                val exportDir = File(reactContext.cacheDir, "exports").apply { mkdirs() }
                val isPng = format.equals("png", ignoreCase = true)
                val ext = if (isPng) "png" else "jpg"
                val mimeType = if (isPng) "image/png" else "image/jpeg"
                val exportFile = File(exportDir, "export_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.$ext")

                FileOutputStream(exportFile).use { fos ->
                    if (isPng) {
                        base.compress(Bitmap.CompressFormat.PNG, 100, fos)
                    } else {
                        val compQuality = quality.toInt().coerceIn(1, 100)
                        base.compress(Bitmap.CompressFormat.JPEG, compQuality, fos)
                    }
                    fos.flush()
                }

                // 6. Optionally publish to the photo library (Android 10+, no permission needed)
                var galleryUri: String? = null
                var galleryError: String? = null
                if (destination == "gallery" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    try {
                        val safeName = (rawDisplayName ?: "PIE_Export").replace("[^A-Za-z0-9._-]".toRegex(), "_")
                        galleryUri = publishToGallery(exportFile, "${safeName}_${System.currentTimeMillis()}.$ext", mimeType)
                    } catch (e: Exception) {
                        galleryError = e.message ?: "Could not save to the photo library"
                    }
                }

                val result = Arguments.createMap()
                result.putString("destinationUri", "file://${exportFile.absolutePath}")
                result.putString("format", if (isPng) "png" else "jpeg")
                result.putDouble("fileSizeBytes", exportFile.length().toDouble())
                result.putDouble("width", width.toDouble())
                result.putDouble("height", height.toDouble())
                result.putBoolean("savedToGallery", galleryUri != null)
                if (galleryUri != null) result.putString("galleryUri", galleryUri)
                if (galleryError != null) result.putString("galleryError", galleryError)

                promise.resolve(result)
            } catch (oom: OutOfMemoryError) {
                promise.reject("EXPORT_OUT_OF_MEMORY", "Not enough memory to export this image at full resolution.", oom)
            } catch (e: Exception) {
                promise.reject("EXPORT_FAILED", e.message, e)
            } finally {
                exportBitmap?.recycle()
            }
        }
    }

    /**
     * Draws markup paths (document pixel coordinates). Commands: ["M",x,y] ["L",x,y]
     * ["Q",cx,cy,x,y] ["C",x1,y1,x2,y2,x,y] ["Z"] — the same commands the Skia canvas draws.
     */
    private fun drawMarkup(canvas: Canvas, drawings: ReadableArray) {
        for (i in 0 until drawings.size()) {
            val d = drawings.getMap(i) ?: continue
            val commands = d.getArray("commands") ?: continue
            val path = Path()
            for (c in 0 until commands.size()) {
                val cmd = commands.getArray(c) ?: continue
                if (cmd.size() == 0) continue
                val op = cmd.getString(0)
                fun n(k: Int): Float = cmd.getDouble(k).toFloat()
                when (op) {
                    "M" -> if (cmd.size() >= 3) path.moveTo(n(1), n(2))
                    "L" -> if (cmd.size() >= 3) path.lineTo(n(1), n(2))
                    "Q" -> if (cmd.size() >= 5) path.quadTo(n(1), n(2), n(3), n(4))
                    "C" -> if (cmd.size() >= 7) path.cubicTo(n(1), n(2), n(3), n(4), n(5), n(6))
                    "Z" -> path.close()
                }
            }
            val fill = d.hasKey("fill") && d.getBoolean("fill")
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = try { Color.parseColor(d.getString("color") ?: "#000000") } catch (e: Exception) { Color.BLACK }
                val opacity = if (d.hasKey("opacity")) d.getDouble("opacity") else 1.0
                alpha = (opacity.coerceIn(0.0, 1.0) * 255).roundToInt()
                style = if (fill) Paint.Style.FILL else Paint.Style.STROKE
                strokeWidth = if (d.hasKey("width")) d.getDouble("width").toFloat() else 2f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
                if (d.hasKey("multiply") && d.getBoolean("multiply")) {
                    xfermode = PorterDuffXfermode(PorterDuff.Mode.MULTIPLY)
                }
            }
            canvas.drawPath(path, paint)
        }
    }

    /**
     * Rotates / flips / crops an image into a NEW upright PNG working image (the input is only
     * read). params: sourceUri, outputDir, quarterTurns (0-3, clockwise), flipHorizontal,
     * flipVertical, crop {x, y, width, height} in source pixels (applied before rotation),
     * maxPixels, previewMaxDimension. Resolves {assetUri, previewUri?, width, height}.
     */
    @ReactMethod
    fun transformImage(params: ReadableMap, promise: Promise) {
        scope.launch {
            var source: Bitmap? = null
            var result: Bitmap? = null
            try {
                val sourceUri = params.getString("sourceUri") ?: throw IllegalArgumentException("Missing sourceUri")
                val outputDir = File((params.getString("outputDir") ?: throw IllegalArgumentException("Missing outputDir")).removePrefix("file://"))
                val quarterTurns = ((if (params.hasKey("quarterTurns")) params.getInt("quarterTurns") else 0) % 4 + 4) % 4
                val flipH = params.hasKey("flipHorizontal") && params.getBoolean("flipHorizontal")
                val flipV = params.hasKey("flipVertical") && params.getBoolean("flipVertical")
                val maxPixels = if (params.hasKey("maxPixels")) params.getDouble("maxPixels").toLong() else 50_000_000L
                val previewMax = if (params.hasKey("previewMaxDimension")) params.getDouble("previewMaxDimension").toInt() else 4096

                val (srcW, srcH) = decodeImageBounds(sourceUri)
                if (srcW <= 0 || srcH <= 0) throw IllegalArgumentException("The image could not be read")
                if (srcW.toLong() * srcH.toLong() > maxPixels) {
                    promise.reject("IMAGE_TOO_LARGE", "Image is too large to transform on this device (${srcW}x${srcH}).")
                    return@launch
                }

                if (!canAllocateBitmaps(srcW.toLong() * srcH.toLong() * 8L)) {
                    promise.reject(
                        "IMAGE_TOO_LARGE",
                        "This ${megapixels(srcW, srcH)} MP image needs more memory than is free on this device to rotate or crop. Close other apps and try again."
                    )
                    return@launch
                }

                var cropRect: Rect? = null
                if (params.hasKey("crop") && !params.isNull("crop")) {
                    val c = params.getMap("crop")!!
                    val x = c.getDouble("x").roundToInt().coerceIn(0, srcW - 1)
                    val y = c.getDouble("y").roundToInt().coerceIn(0, srcH - 1)
                    val w = c.getDouble("width").roundToInt().coerceIn(1, srcW - x)
                    val h = c.getDouble("height").roundToInt().coerceIn(1, srcH - y)
                    if (w < 2 || h < 2) throw IllegalArgumentException("The crop area is too small")
                    cropRect = Rect(x, y, x + w, y + h)
                }

                source = (if (cropRect != null) decodeImageRegion(sourceUri, cropRect) else null)
                    ?: decodeBitmap(sourceUri, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 })?.let { full ->
                        if (cropRect != null) {
                            val cropped = Bitmap.createBitmap(full, cropRect.left, cropRect.top, cropRect.width(), cropRect.height())
                            if (cropped !== full) full.recycle()
                            cropped
                        } else full
                    }
                    ?: throw IllegalArgumentException("The image could not be decoded")

                val m = Matrix()
                if (quarterTurns != 0) m.postRotate(90f * quarterTurns)
                if (flipH || flipV) m.postScale(if (flipH) -1f else 1f, if (flipV) -1f else 1f)
                result = if (m.isIdentity) source else Bitmap.createBitmap(source!!, 0, 0, source!!.width, source!!.height, m, true)

                if (!outputDir.exists()) outputDir.mkdirs()
                val stamp = System.currentTimeMillis().toString() + "_" + UUID.randomUUID().toString().take(6)
                val asset = File(outputDir, "asset_$stamp.png")
                FileOutputStream(asset).use { out -> result!!.compress(Bitmap.CompressFormat.PNG, 100, out) }
                val outW = result!!.width
                val outH = result!!.height

                // Display preview with a unique name (documents copy assets by file name).
                var previewUri: String? = null
                val previewDir = File(outputDir, ".preview_$stamp")
                val written = writeDisplayPreview(asset, outW, outH, previewMax, previewDir.apply { mkdirs() })
                if (written != null) {
                    val tmp = File(written.removePrefix("file://"))
                    val ext = tmp.extension.ifEmpty { "jpg" }
                    val dest = File(outputDir, "preview_$stamp.$ext")
                    if (tmp.renameTo(dest)) previewUri = "file://" + dest.absolutePath
                }
                previewDir.deleteRecursively()

                val map = Arguments.createMap()
                map.putString("assetUri", "file://" + asset.absolutePath)
                if (previewUri != null) map.putString("previewUri", previewUri)
                map.putInt("width", outW)
                map.putInt("height", outH)
                promise.resolve(map)
            } catch (oom: OutOfMemoryError) {
                promise.reject("IMAGE_TOO_LARGE", "Not enough memory to transform this image.", oom)
            } catch (e: Exception) {
                promise.reject("IMAGE_TRANSFORM_FAILED", e.message ?: "The image could not be transformed", e)
            } finally {
                if (result != null && result !== source) result?.recycle()
                source?.recycle()
            }
        }
    }

    /** Inserts an exported file into MediaStore Pictures/PIE (API 29+). Returns the content URI. */
    @RequiresApi(Build.VERSION_CODES.Q)
    private fun publishToGallery(file: File, displayName: String, mimeType: String): String {
        val resolver = reactContext.contentResolver
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, mimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/PIE")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val itemUri = resolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore insert failed")
        try {
            val out = resolver.openOutputStream(itemUri)
                ?: throw IllegalStateException("Could not open MediaStore output stream")
            out.use { o -> file.inputStream().use { it.copyTo(o) } }
            val done = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
            resolver.update(itemUri, done, null, null)
        } catch (e: Exception) {
            resolver.delete(itemUri, null, null)
            throw e
        }
        return itemUri.toString()
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

    private fun openImageStream(uriStr: String): InputStream? {
        val uri = Uri.parse(uriStr)
        return when (uri.scheme) {
            "content" -> reactContext.contentResolver.openInputStream(uri)
            "file" -> File(uri.path ?: "").let { if (it.exists()) it.inputStream() else null }
            else -> {
                val file = File(uriStr)
                if (file.exists()) file.inputStream() else null
            }
        }
    }

    private fun decodeBitmap(uriStr: String, options: BitmapFactory.Options? = null): Bitmap? {
        return openImageStream(uriStr)?.use { BitmapFactory.decodeStream(it, null, options) }
    }

    /** Reads pixel dimensions from the image header only (no pixel allocation). */
    private fun decodeImageBounds(uriStr: String): Pair<Int, Int> {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            openImageStream(uriStr)?.use { BitmapFactory.decodeStream(it, null, opts) }
        } catch (e: Exception) {
            return Pair(-1, -1)
        }
        return Pair(opts.outWidth, opts.outHeight)
    }

    /** Decodes only `rect` of the image. Returns null if the format/region is unsupported. */
    @Suppress("DEPRECATION")
    private fun decodeImageRegion(uriStr: String, rect: Rect): Bitmap? {
        return try {
            openImageStream(uriStr)?.use { input ->
                val decoder = BitmapRegionDecoder.newInstance(input, false) ?: return@use null
                try {
                    decoder.decodeRegion(
                        rect,
                        BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
                    )
                } finally {
                    decoder.recycle()
                }
            }
        } catch (e: Exception) {
            null
        }
    }
}
