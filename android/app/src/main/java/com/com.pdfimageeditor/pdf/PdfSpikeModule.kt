package com.pdfimageeditor.pdf

import android.net.Uri
import com.facebook.react.bridge.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.Charset

class PdfSpikeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val scope = CoroutineScope(Dispatchers.IO)

    override fun getName(): String = "PdfSpikeModule"

    @ReactMethod
    fun prepareSamplePdf(reset: Boolean, promise: Promise) {
        scope.launch {
            try {
                val destFile = File(reactContext.filesDir, "spike_sample.pdf")
                if (!destFile.exists() || reset) {
                    reactContext.assets.open("sample.pdf").use { inputStream ->
                        FileOutputStream(destFile).use { outputStream ->
                            inputStream.copyTo(outputStream)
                        }
                    }
                }
                val fileUri = Uri.fromFile(destFile).toString()
                promise.resolve(fileUri)
            } catch (e: Exception) {
                promise.reject("PDF_PREPARE_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun readPdfContent(filePath: String, promise: Promise) {
        scope.launch {
            try {
                val cleanPath = if (filePath.startsWith("file://")) {
                    Uri.parse(filePath).path ?: filePath.removePrefix("file://")
                } else {
                    filePath
                }
                val file = File(cleanPath)
                if (!file.exists()) {
                    promise.reject("FILE_NOT_FOUND", "File not found: $filePath")
                    return@launch
                }
                // Read bytes and decode as ISO-8859-1 (preserves byte-to-char mapping for PDF parsing)
                val bytes = file.readBytes()
                val content = String(bytes, Charset.forName("ISO-8859-1"))
                promise.resolve(content)
            } catch (e: Exception) {
                promise.reject("READ_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun getPdfFileMetadata(filePath: String, promise: Promise) {
        scope.launch {
            try {
                val cleanPath = if (filePath.startsWith("file://")) {
                    Uri.parse(filePath).path ?: filePath.removePrefix("file://")
                } else {
                    filePath
                }
                val file = File(cleanPath)
                val map = Arguments.createMap().apply {
                    putBoolean("exists", file.exists())
                    putDouble("size", if (file.exists()) file.length().toDouble() else 0.0)
                    putDouble("lastModified", if (file.exists()) file.lastModified().toDouble() else 0.0)
                    putString("path", file.absolutePath)
                }
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("METADATA_ERROR", e.message, e)
            }
        }
    }
}
