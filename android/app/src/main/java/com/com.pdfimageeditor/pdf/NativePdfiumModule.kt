package com.pdfimageeditor.pdf

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import android.graphics.Bitmap
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.Executors
import kotlin.math.ceil

class NativePdfiumModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val REQUEST_CODE_PICK_PDF = 4242
    }

    private val executor = Executors.newFixedThreadPool(2)
    private var pendingPickerPromise: Promise? = null

    private val activityEventListener: ActivityEventListener = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
            if (requestCode == REQUEST_CODE_PICK_PDF) {
                val promise = pendingPickerPromise ?: return
                pendingPickerPromise = null

                if (resultCode != Activity.RESULT_OK || data == null || data.data == null) {
                    promise.resolve(null)
                    return
                }

                val uri: Uri = data.data!!
                executor.execute {
                    try {
                        var fileName = "Document.pdf"
                        var fileSize = 0L

                        reactContext.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (cursor.moveToFirst()) {
                                if (nameIndex >= 0) {
                                    val n = cursor.getString(nameIndex)
                                    if (!n.isNullOrBlank()) fileName = n
                                }
                                if (sizeIndex >= 0) fileSize = cursor.getLong(sizeIndex)
                            }
                        }

                        val cacheDir = File(reactContext.cacheDir, "picked_pdfs")
                        if (!cacheDir.exists()) cacheDir.mkdirs()
                        val safeName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
                        val destFile = File(cacheDir, "${System.currentTimeMillis()}_$safeName")

                        reactContext.contentResolver.openInputStream(uri)?.use { input ->
                            FileOutputStream(destFile).use { output ->
                                input.copyTo(output)
                            }
                        }

                        val result = Arguments.createMap().apply {
                            putString("filePath", destFile.absolutePath)
                            putString("fileName", fileName)
                            putDouble("fileSize", destFile.length().toDouble())
                        }
                        promise.resolve(result)
                    } catch (e: Exception) {
                        promise.reject("PICK_PDF_ERROR", "Failed to load picked PDF: ${e.message}", e)
                    }
                }
            }
        }
    }

    init {
        reactContext.addActivityEventListener(activityEventListener)
    }

    override fun getName(): String = "PdfiumNativeModule"

    @ReactMethod
    fun pickPdfDocument(promise: Promise) {
        val currentActivity = reactContext.currentActivity
        if (currentActivity == null) {
            promise.reject("ACTIVITY_NOT_FOUND", "Cannot launch file picker without active activity")
            return
        }
        pendingPickerPromise = promise
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/pdf"
            }
            currentActivity.startActivityForResult(intent, REQUEST_CODE_PICK_PDF)
        } catch (e: Exception) {
            pendingPickerPromise = null
            promise.reject("PICK_LAUNCH_ERROR", "Failed to launch PDF picker: ${e.message}", e)
        }
    }

    @ReactMethod
    fun openDocument(filePath: String, password: String?, promise: Promise) {
        executor.execute {
            try {
                val cleanPath = resolveLocalPath(filePath)
                val file = File(cleanPath)
                if (!file.exists()) {
                    promise.reject("PDF_FILE_NOT_FOUND", "PDF file not found at path: $cleanPath")
                    return@execute
                }

                val docHandle = NativePdfiumBridge.nativeOpenDocument(cleanPath, password)
                if (docHandle <= 0L) {
                    val errCode = NativePdfiumBridge.nativeGetLastError()
                    val (code, msg) = when (errCode) {
                        2 -> "PDF_FILE_NOT_FOUND" to "Cannot open file or file does not exist"
                        3 -> "PDF_FORMAT_CORRUPT" to "Corrupted or invalid PDF format"
                        4 -> "PDF_PASSWORD_REQUIRED" to "Password required or incorrect password"
                        5 -> "PDF_SECURITY_UNSUPPORTED" to "Unsupported security scheme"
                        6 -> "PDF_PAGE_ERROR" to "Page error or invalid document content"
                        else -> "PDF_OPEN_FAILED" to "Failed to open PDF document (error code: $errCode)"
                    }
                    promise.reject(code, msg)
                    return@execute
                }

                val pageCount = NativePdfiumBridge.nativeGetPageCount(docHandle)
                val result = Arguments.createMap().apply {
                    putDouble("docHandle", docHandle.toDouble())
                    putInt("pageCount", pageCount)
                    putString("filePath", cleanPath)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("PDF_OPEN_EXCEPTION", "Exception opening PDF: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun closeDocument(docHandle: Double, promise: Promise) {
        executor.execute {
            try {
                NativePdfiumBridge.nativeCloseDocument(docHandle.toLong())
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("PDF_CLOSE_ERROR", "Failed to close PDF document: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun getPageCount(docHandle: Double, promise: Promise) {
        executor.execute {
            try {
                val count = NativePdfiumBridge.nativeGetPageCount(docHandle.toLong())
                if (count < 0) {
                    promise.reject("PDF_INVALID_HANDLE", "Invalid or closed document handle")
                    return@execute
                }
                promise.resolve(count)
            } catch (e: Exception) {
                promise.reject("PDF_PAGE_COUNT_ERROR", "Failed to get page count: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun getPageSize(docHandle: Double, pageIndex: Int, promise: Promise) {
        executor.execute {
            try {
                val dims = NativePdfiumBridge.nativeGetPageSize(docHandle.toLong(), pageIndex)
                if (dims == null || dims.size < 2) {
                    promise.reject("PDF_PAGE_SIZE_ERROR", "Failed to get page size for page $pageIndex")
                    return@execute
                }
                val result = Arguments.createMap().apply {
                    putDouble("width", dims[0])
                    putDouble("height", dims[1])
                    putInt("pageIndex", pageIndex)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("PDF_PAGE_SIZE_ERROR", "Exception getting page size: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun renderPage(docHandle: Double, pageIndex: Int, scale: Double, promise: Promise) {
        executor.execute {
            try {
                val effectiveScale = if (scale <= 0.0) 1.5 else scale
                val dims = NativePdfiumBridge.nativeGetPageSize(docHandle.toLong(), pageIndex)
                if (dims == null || dims.size < 2) {
                    promise.reject("PDF_PAGE_NOT_FOUND", "Page index $pageIndex out of range or not found")
                    return@execute
                }

                val pageWidth = dims[0]
                val pageHeight = dims[1]
                val targetW = ceil(pageWidth * effectiveScale).toInt().coerceAtLeast(1)
                val targetH = ceil(pageHeight * effectiveScale).toInt().coerceAtLeast(1)

                val bitmap = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888)
                val ok = NativePdfiumBridge.nativeRenderPageToBitmap(docHandle.toLong(), pageIndex, bitmap)
                if (!ok) {
                    bitmap.recycle()
                    promise.reject("PDF_RENDER_FAILED", "Native PDFium rendering failed for page $pageIndex")
                    return@execute
                }

                val outputDir = File(reactContext.cacheDir, "pdfium_renders")
                if (!outputDir.exists()) {
                    outputDir.mkdirs()
                }

                val outFile = File(outputDir, "page_${pageIndex}_${System.currentTimeMillis()}.png")
                FileOutputStream(outFile).use { fos ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, fos)
                }
                bitmap.recycle()

                val result = Arguments.createMap().apply {
                    putString("filePath", outFile.absolutePath)
                    putString("uri", "file://${outFile.absolutePath}")
                    putInt("width", targetW)
                    putInt("height", targetH)
                    putDouble("pageWidth", pageWidth)
                    putDouble("pageHeight", pageHeight)
                    putDouble("scale", effectiveScale)
                    putInt("pageIndex", pageIndex)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("PDF_RENDER_ERROR", "Exception rendering page $pageIndex: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun getTextObjects(docHandle: Double, pageIndex: Int, promise: Promise) {
        executor.execute {
            try {
                val jsonStr = NativePdfiumBridge.nativeGetTextObjectsJson(docHandle.toLong(), pageIndex)
                promise.resolve(jsonStr)
            } catch (e: Exception) {
                promise.reject("PDF_TEXT_EXTRACTION_ERROR", "Failed to extract text objects: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun replaceTextObject(
        inputPath: String,
        outputPath: String,
        pageIndex: Int,
        objectIndex: Int,
        replacementText: String,
        promise: Promise
    ) {
        executor.execute {
            try {
                val cleanInput = resolveLocalPath(inputPath)
                val cleanOutput = resolveLocalPath(outputPath)
                val inputFile = File(cleanInput)
                if (!inputFile.exists()) {
                    promise.reject("PDF_FILE_NOT_FOUND", "Input PDF file not found at: $cleanInput")
                    return@execute
                }
                if (cleanInput == cleanOutput) {
                    promise.reject("SAME_INPUT_OUTPUT", "Input path and output path must be different to preserve source immutability")
                    return@execute
                }
                if (replacementText.isEmpty()) {
                    promise.reject("EMPTY_REPLACEMENT", "Replacement text cannot be empty")
                    return@execute
                }

                val outFile = File(cleanOutput)
                outFile.parentFile?.let { parent ->
                    if (!parent.exists()) parent.mkdirs()
                }

                val jsonStr = NativePdfiumBridge.nativeReplaceTextObjectJson(
                    cleanInput,
                    cleanOutput,
                    pageIndex,
                    objectIndex,
                    replacementText
                )
                promise.resolve(jsonStr)
            } catch (e: Exception) {
                promise.reject("PDF_REPLACEMENT_ERROR", "Exception during PDF text replacement: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun applyBatchEdits(
        inputPath: String,
        outputPath: String,
        editsJson: String,
        promise: Promise
    ) {
        executor.execute {
            try {
                val cleanInput = resolveLocalPath(inputPath)
                val cleanOutput = resolveLocalPath(outputPath)
                val inputFile = File(cleanInput)
                if (!inputFile.exists()) {
                    promise.reject("PDF_FILE_NOT_FOUND", "Input PDF file not found at: $cleanInput")
                    return@execute
                }
                if (cleanInput == cleanOutput) {
                    promise.reject("SAME_INPUT_OUTPUT", "Input path and output path must be different to preserve source immutability")
                    return@execute
                }
                if (editsJson.isBlank()) {
                    promise.reject("EMPTY_EDITS", "Edits JSON cannot be empty")
                    return@execute
                }

                val outFile = File(cleanOutput)
                outFile.parentFile?.let { parent ->
                    if (!parent.exists()) parent.mkdirs()
                }

                val jsonStr = NativePdfiumBridge.nativeApplyBatchEditsJson(
                    cleanInput,
                    cleanOutput,
                    editsJson
                )
                promise.resolve(jsonStr)
            } catch (e: Exception) {
                promise.reject("PDF_BATCH_EDIT_ERROR", "Exception during PDF batch edit: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun extractAssetPdf(assetName: String, promise: Promise) {
        executor.execute {
            try {
                val targetFile = File(reactContext.filesDir, assetName)
                reactContext.assets.open(assetName).use { input: InputStream ->
                    FileOutputStream(targetFile).use { output ->
                        input.copyTo(output)
                    }
                }
                promise.resolve(targetFile.absolutePath)
            } catch (e: Exception) {
                promise.reject("ASSET_EXTRACT_ERROR", "Failed to extract asset $assetName: ${e.message}", e)
            }
        }
    }

    private fun resolveLocalPath(path: String): String {
        if (path.startsWith("file://")) {
            return path.substring(7)
        }
        if (path.startsWith("content://")) {
            try {
                val uri = Uri.parse(path)
                val cacheDir = File(reactContext.cacheDir, "resolved_pdfs")
                if (!cacheDir.exists()) cacheDir.mkdirs()
                val destFile = File(cacheDir, "pdf_" + System.currentTimeMillis() + ".pdf")
                reactContext.contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(destFile).use { output ->
                        input.copyTo(output)
                    }
                }
                if (destFile.exists() && destFile.length() > 0) {
                    return destFile.absolutePath
                }
            } catch (e: Exception) {
                android.util.Log.e("NativePdfiumModule", "Failed to resolve content URI: " + e.message, e)
            }
        }
        return path
    }
}
