package com.pdfimageeditor.ocr

import android.graphics.BitmapFactory
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.util.concurrent.Executors

class OcrModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    override fun getName(): String = "OcrNativeModule"

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

    private fun buildOcrResult(visionText: Text, imgWidth: Int, imgHeight: Int): WritableMap {
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
                    putMap("boundingBox", createBoundingBoxMap(box.left, box.top, box.width(), box.height()))
                }

                val linesArray: WritableArray = Arguments.createArray()
                for (line in block.lines) {
                    val lineMap = Arguments.createMap().apply {
                        putString("text", line.text)
                        line.confidence?.let { putDouble("confidence", it.toDouble()) }
                        line.boundingBox?.let { box ->
                            putMap("boundingBox", createBoundingBoxMap(box.left, box.top, box.width(), box.height()))
                        }

                        val wordsArray: WritableArray = Arguments.createArray()
                        for (element in line.elements) {
                            val wordMap = Arguments.createMap().apply {
                                putString("text", element.text)
                                element.confidence?.let { putDouble("confidence", it.toDouble()) }
                                element.boundingBox?.let { box ->
                                    putMap("boundingBox", createBoundingBoxMap(box.left, box.top, box.width(), box.height()))
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

    private fun createBoundingBoxMap(x: Int, y: Int, width: Int, height: Int): WritableMap {
        return Arguments.createMap().apply {
            putDouble("x", x.toDouble())
            putDouble("y", y.toDouble())
            putDouble("width", width.toDouble())
            putDouble("height", height.toDouble())
        }
    }
}
