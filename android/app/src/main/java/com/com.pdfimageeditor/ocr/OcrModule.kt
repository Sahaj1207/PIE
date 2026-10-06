package com.pdfimageeditor.ocr

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

class OcrModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    override fun getName(): String = "OcrNativeModule"

    private companion object {
        /** Decoded-pixel budget for OCR input (mirrors OCR_MAX_PIXELS in ocrPreprocessing.ts). */
        const val MAX_OCR_PIXELS = 16_000_000L
        const val MAX_OCR_UPSCALE = 3.0
    }

    @ReactMethod
    fun recognizeText(imageUriString: String, promise: Promise) {
        executor.execute {
            try {
                val uri = parseImageUri(imageUriString)
                val (width, height) = getImageDimensions(uri)
                val inputImage = InputImage.fromFilePath(reactContext, uri)

                recognizer.process(inputImage)
                    .addOnSuccessListener { visionText ->
                        try {
                            val result = buildOcrResult(visionText, width, height)
                            promise.resolve(result)
                        } catch (e: Exception) {
                            promise.reject("OCR_PARSE_ERROR", "Failed to format OCR result: ${e.message}", e)
                        }
                    }
                    .addOnFailureListener { e ->
                        promise.reject("OCR_PROCESSING_FAILED", "On-device OCR failed: ${e.message}", e)
                    }
            } catch (e: Exception) {
                promise.reject("IMAGE_LOAD_FAILED", "Failed to load image for OCR: ${e.message}", e)
            }
        }
    }

    /**
     * OCR with deterministic on-device preprocessing (see src/features/ocr/ocrPreprocessing.ts):
     * - decodes the image itself with EXIF orientation applied, so recognized boxes are in the
     *   UPRIGHT pixel grid of the image (the document coordinate space);
     * - resamples by options.scale (bounded downscale for huge images, upscale for small ones),
     *   decoding with inSampleSize first so large images never need a full-size bitmap;
     * - flattens transparency onto an opaque background that contrasts with the content
     *   (transparent pixels decode as black, which hides dark text);
     * - maps every box back to original upright pixel coordinates; imageWidth/imageHeight are
     *   the upright original size.
     */
    @ReactMethod
    fun recognizeTextWithOptions(imageUriString: String, options: ReadableMap, promise: Promise) {
        executor.execute {
            var prepared: PreparedOcrImage? = null
            try {
                val uri = parseImageUri(imageUriString)
                val requestedScale = if (options.hasKey("scale")) options.getDouble("scale") else 1.0
                val flattenAlpha = !options.hasKey("flattenAlpha") || options.getBoolean("flattenAlpha")
                val image = prepareOcrImage(uri, requestedScale, flattenAlpha)
                prepared = image
                val inputImage = InputImage.fromBitmap(image.bitmap, 0)
                recognizer.process(inputImage)
                    .addOnSuccessListener { visionText ->
                        try {
                            promise.resolve(
                                buildOcrResult(visionText, image.uprightWidth, image.uprightHeight, image.scaleX, image.scaleY)
                            )
                        } catch (e: Exception) {
                            promise.reject("OCR_PARSE_ERROR", "Failed to format OCR result: ${e.message}", e)
                        }
                    }
                    .addOnFailureListener { e ->
                        promise.reject("OCR_PROCESSING_FAILED", "On-device OCR failed: ${e.message}", e)
                    }
                    .addOnCompleteListener {
                        if (!image.bitmap.isRecycled) image.bitmap.recycle()
                    }
            } catch (oom: OutOfMemoryError) {
                prepared?.bitmap?.recycle()
                promise.reject("IMAGE_LOAD_FAILED", "Not enough memory to prepare this image for OCR.", oom)
            } catch (e: Exception) {
                prepared?.bitmap?.recycle()
                promise.reject("IMAGE_LOAD_FAILED", "Failed to load image for OCR: ${e.message}", e)
            }
        }
    }

    private class PreparedOcrImage(
        val bitmap: Bitmap,
        val uprightWidth: Int,
        val uprightHeight: Int,
        /** processed pixels per original upright pixel */
        val scaleX: Double,
        val scaleY: Double,
    )

    private fun prepareOcrImage(uri: Uri, requestedScale: Double, flattenAlpha: Boolean): PreparedOcrImage {
        val orientation = readExifOrientation(uri)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        reactContext.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val rawW = bounds.outWidth
        val rawH = bounds.outHeight
        if (rawW <= 0 || rawH <= 0) throw IllegalArgumentException("The image could not be decoded")
        val swaps = orientation in 5..8
        val uprightW = if (swaps) rawH else rawW
        val uprightH = if (swaps) rawW else rawH

        // Bounded scale (never more than MAX_OCR_PIXELS decoded pixels)
        val budget = sqrt(MAX_OCR_PIXELS.toDouble() / (rawW.toDouble() * rawH.toDouble()))
        val scale = min(max(requestedScale, 0.05), min(MAX_OCR_UPSCALE, budget))

        var sample = 1
        while (scale <= 0.5 / sample && max(rawW, rawH) / (sample * 2) > 0) sample *= 2
        val decoded = reactContext.contentResolver.openInputStream(uri)?.use { stream ->
            BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            })
        } ?: throw IllegalArgumentException("The image could not be decoded")

        val targetW = max(1, (rawW * scale).roundToInt())
        val targetH = max(1, (rawH * scale).roundToInt())
        var bitmap = if (decoded.width != targetW || decoded.height != targetH) {
            val scaled = Bitmap.createScaledBitmap(decoded, targetW, targetH, true)
            if (scaled !== decoded) decoded.recycle()
            scaled
        } else {
            decoded
        }

        if (orientation in 2..8) {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, exifMatrix(orientation), true)
            if (rotated !== bitmap) bitmap.recycle()
            bitmap = rotated
        }

        if (flattenAlpha && bitmap.hasAlpha()) {
            val opaque = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(opaque)
            canvas.drawColor(contrastingBackground(bitmap))
            canvas.drawBitmap(bitmap, 0f, 0f, null)
            bitmap.recycle()
            bitmap = opaque
        }

        return PreparedOcrImage(
            bitmap,
            uprightW,
            uprightH,
            bitmap.width.toDouble() / uprightW.toDouble(),
            bitmap.height.toDouble() / uprightH.toDouble(),
        )
    }

    /** Black behind predominantly light content (e.g. white text), otherwise white. */
    private fun contrastingBackground(bitmap: Bitmap): Int {
        val stepX = max(1, bitmap.width / 64)
        val stepY = max(1, bitmap.height / 64)
        var sum = 0.0
        var count = 0
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val c = bitmap.getPixel(x, y)
                if (Color.alpha(c) >= 128) {
                    sum += (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255.0
                    count++
                }
                x += stepX
            }
            y += stepY
        }
        val meanLuminance = if (count > 0) sum / count else 0.0
        return if (meanLuminance > 0.6) Color.BLACK else Color.WHITE
    }

    private fun readExifOrientation(uri: Uri): Int {
        return try {
            reactContext.contentResolver.openInputStream(uri)?.use { stream ->
                ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    /** Raw pixels -> upright image for an EXIF orientation (same as ImageProcessingModule). */
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

    private fun parseImageUri(uriString: String): Uri {
        return if (uriString.startsWith("/")) {
            Uri.fromFile(File(uriString))
        } else {
            Uri.parse(uriString)
        }
    }

    private fun getImageDimensions(uri: Uri): Pair<Int, Int> {
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        reactContext.contentResolver.openInputStream(uri)?.use { stream ->
            BitmapFactory.decodeStream(stream, null, options)
        }
        return Pair(options.outWidth, options.outHeight)
    }

    private fun buildOcrResult(
        visionText: Text,
        imgWidth: Int,
        imgHeight: Int,
        scaleX: Double = 1.0,
        scaleY: Double = 1.0,
    ): WritableMap {
        // Boxes from a resampled bitmap are mapped back to the original pixel grid
        fun mapBox(rect: android.graphics.Rect): WritableMap = createBoundingBoxMap(
            rect.left / scaleX,
            rect.top / scaleY,
            rect.width() / scaleX,
            rect.height() / scaleY,
        )
        val resultMap = Arguments.createMap().apply {
            putString("fullText", visionText.text)
            putInt("imageWidth", imgWidth)
            putInt("imageHeight", imgHeight)
        }

        val blocksArray: WritableArray = Arguments.createArray()
        for (block in visionText.textBlocks) {
            val blockMap = Arguments.createMap().apply {
                putString("text", block.text)
                block.boundingBox?.let { box ->
                    putMap("boundingBox", mapBox(box))
                }

                val linesArray: WritableArray = Arguments.createArray()
                for (line in block.lines) {
                    val lineMap = Arguments.createMap().apply {
                        putString("text", line.text)
                        line.confidence?.let { putDouble("confidence", it.toDouble()) }
                        line.boundingBox?.let { box ->
                            putMap("boundingBox", mapBox(box))
                        }

                        val wordsArray: WritableArray = Arguments.createArray()
                        for (element in line.elements) {
                            val wordMap = Arguments.createMap().apply {
                                putString("text", element.text)
                                element.confidence?.let { putDouble("confidence", it.toDouble()) }
                                element.boundingBox?.let { box ->
                                    putMap("boundingBox", mapBox(box))
                                }
                            }
                            wordsArray.pushMap(wordMap)
                        }
                        putArray("words", wordsArray)
                    }
                    linesArray.pushMap(lineMap)
                }
                putArray("lines", linesArray)
            }
            blocksArray.pushMap(blockMap)
        }

        resultMap.putArray("blocks", blocksArray)
        return resultMap
    }

    private fun createBoundingBoxMap(x: Double, y: Double, width: Double, height: Double): WritableMap {
        return Arguments.createMap().apply {
            putDouble("x", x)
            putDouble("y", y)
            putDouble("width", width)
            putDouble("height", height)
        }
    }
}
