package com.pdfimageeditor.pdf

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import java.security.MessageDigest
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.Executors
import kotlin.math.ceil

class NativePdfiumModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val REQUEST_CODE_PICK_PDF = 4242
        private const val REQUEST_CODE_CREATE_PDF = 4243
        private const val REQUEST_CODE_PICK_PDFS = 4244
        private const val THUMB_DIR = "pdfium_thumbs"
        private const val COMPOSE_DIR = "pdf_compose"
        /** Long side of images embedded into PDFs (keeps files reasonable, ~250 dpi on A4). */
        private const val MAX_EMBED_IMAGE_SIDE = 3000
        private const val EXPORT_DIR = "pdf_exports"
        private const val EXPORT_MAX_AGE_MS = 60L * 60L * 1000L
        /** Hard ceiling for one region render (the JS side requests far less). */
        private const val MAX_REGION_PIXELS = 16L * 1024L * 1024L
        /** Hard ceiling for one full-page render (the JS side budgets below this). */
        private const val MAX_PAGE_PIXELS = 32L * 1024L * 1024L
    }

    private val executor = Executors.newFixedThreadPool(2)
    private var pendingPickerPromise: Promise? = null
    private var pendingMultiPickPromise: Promise? = null

    /** Save As in progress: the verified app-private PDF to copy and the JS promise. */
    private class PendingSaveAs(val source: File, val promise: Promise)
    private var pendingSaveAs: PendingSaveAs? = null

    private val activityEventListener: ActivityEventListener = object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
            if (requestCode == REQUEST_CODE_PICK_PDFS) {
                val promise = pendingMultiPickPromise ?: return
                pendingMultiPickPromise = null
                if (resultCode != Activity.RESULT_OK || data == null) {
                    promise.resolve(Arguments.createArray())
                    return
                }
                val uris = ArrayList<Uri>()
                val clip = data.clipData
                if (clip != null) {
                    for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
                } else {
                    data.data?.let { uris.add(it) }
                }
                executor.execute {
                    try {
                        val out = Arguments.createArray()
                        for (uri in uris) {
                            val copied = copyPickedPdf(uri)
                            out.pushMap(Arguments.createMap().apply {
                                putString("filePath", copied.first.absolutePath)
                                putString("fileName", copied.second)
                                putDouble("fileSize", copied.first.length().toDouble())
                            })
                        }
                        promise.resolve(out)
                    } catch (e: Exception) {
                        promise.reject("PICK_PDF_ERROR", "Failed to load picked PDFs: ${e.message}", e)
                    }
                }
                return
            }
            if (requestCode == REQUEST_CODE_CREATE_PDF) {
                val pending = pendingSaveAs ?: return
                pendingSaveAs = null
                val destination = data?.data
                if (resultCode != Activity.RESULT_OK || destination == null) {
                    pending.promise.resolve(null) // user cancelled: nothing was written
                    return
                }
                executor.execute { writeSaveAsCopy(pending, destination) }
                return
            }
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
                    // Used by the editor's revision-history storage cap
                    putDouble("fileSizeBytes", file.length().toDouble())
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
                    // Phase 15: page rotation and user->display mapping as PDFium renders it
                    val geometry = try {
                        NativePdfiumBridge.nativeGetPageGeometry(docHandle.toLong(), pageIndex)
                    } catch (e: UnsatisfiedLinkError) {
                        null
                    }
                    if (geometry != null && geometry.size >= 9) {
                        putInt("rotation", (geometry[2].toInt() * 90) % 360)
                        putMap("displayMatrix", Arguments.createMap().apply {
                            putDouble("a", geometry[3])
                            putDouble("b", geometry[4])
                            putDouble("c", geometry[5])
                            putDouble("d", geometry[6])
                            putDouble("e", geometry[7])
                            putDouble("f", geometry[8])
                        })
                    }
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
                if (targetW.toLong() * targetH.toLong() > MAX_PAGE_PIXELS) {
                    promise.reject("PDF_RENDER_TOO_LARGE", "Page render exceeds the pixel budget ($targetW x $targetH)")
                    return@execute
                }

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

    /**
     * Renders only a display-space region of a page (points, top-left origin) at `scale`
     * pixels per point: the zoom-settled high-resolution detail of the visible area, so high
     * zoom never needs a huge full-page bitmap. Output goes to the same pdfium_renders cache
     * as page renders (purged by purgeRenderCache).
     */
    @ReactMethod
    fun renderPageRegion(
        docHandle: Double,
        pageIndex: Int,
        scale: Double,
        left: Double,
        top: Double,
        width: Double,
        height: Double,
        promise: Promise
    ) {
        executor.execute {
            try {
                if (!(scale > 0.0) || !(width > 0.0) || !(height > 0.0)) {
                    promise.reject("PDF_RENDER_REGION_INVALID", "Invalid region render request")
                    return@execute
                }
                val targetW = ceil(width * scale).toInt().coerceAtLeast(1)
                val targetH = ceil(height * scale).toInt().coerceAtLeast(1)
                if (targetW.toLong() * targetH.toLong() > MAX_REGION_PIXELS) {
                    promise.reject("PDF_RENDER_REGION_TOO_LARGE", "Region render exceeds the pixel budget")
                    return@execute
                }
                val bitmap = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888)
                val ok = NativePdfiumBridge.nativeRenderPageRegionToBitmap(
                    docHandle.toLong(), pageIndex, bitmap, scale, left, top
                )
                if (!ok) {
                    bitmap.recycle()
                    promise.reject("PDF_RENDER_FAILED", "Native PDFium region rendering failed for page $pageIndex")
                    return@execute
                }
                val outputDir = File(reactContext.cacheDir, "pdfium_renders")
                if (!outputDir.exists()) outputDir.mkdirs()
                val outFile = File(outputDir, "region_${pageIndex}_${System.currentTimeMillis()}.png")
                FileOutputStream(outFile).use { fos ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, fos)
                }
                bitmap.recycle()
                val result = Arguments.createMap().apply {
                    putString("filePath", outFile.absolutePath)
                    putString("uri", "file://${outFile.absolutePath}")
                    putInt("width", targetW)
                    putInt("height", targetH)
                    putDouble("scale", scale)
                    putInt("pageIndex", pageIndex)
                    putDouble("left", left)
                    putDouble("top", top)
                    putDouble("regionWidth", width)
                    putDouble("regionHeight", height)
                }
                promise.resolve(result)
            } catch (oom: OutOfMemoryError) {
                promise.reject("PDF_RENDER_OUT_OF_MEMORY", "Not enough memory to render this region", oom)
            } catch (e: Exception) {
                promise.reject("PDF_RENDER_ERROR", "Exception rendering page region: ${e.message}", e)
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

    /**
     * Moves a verified temporary PDF over its destination (used when a save targets the
     * currently open file). Rename is atomic on the same filesystem; otherwise copy + delete.
     * Refuses paths outside app-private storage so user source files are never touched.
     */
    @ReactMethod
    fun moveFile(fromPath: String, toPath: String, promise: Promise) {
        executor.execute {
            try {
                val source = File(resolveLocalPath(fromPath)).canonicalFile
                val target = File(resolveLocalPath(toPath)).canonicalFile
                if (!isAppPrivate(source) || !isAppPrivate(target)) {
                    promise.reject("PDF_MOVE_REJECTED", "PDF move is restricted to app-private storage")
                    return@execute
                }
                if (!source.exists()) {
                    promise.reject("PDF_FILE_NOT_FOUND", "Source PDF not found: ${source.path}")
                    return@execute
                }
                target.parentFile?.mkdirs()
                if (!source.renameTo(target)) {
                    // Different filesystem: copy next to the target, sync, then rename into place,
                    // so the target is never a partially written PDF. The source goes last.
                    val tmp = File(target.parentFile, ".${target.name}.moving")
                    source.inputStream().use { input ->
                        java.io.FileOutputStream(tmp).use { output ->
                            input.copyTo(output)
                            output.fd.sync()
                        }
                    }
                    if (tmp.length() != source.length()) {
                        tmp.delete()
                        throw IllegalStateException("The moved PDF is incomplete")
                    }
                    if (!tmp.renameTo(target)) {
                        val backup = File(target.parentFile, ".${target.name}.bak")
                        backup.delete()
                        val hadTarget = target.exists() && target.renameTo(backup)
                        if (!tmp.renameTo(target)) {
                            if (hadTarget) backup.renameTo(target)
                            tmp.delete()
                            throw IllegalStateException("Could not move the PDF into place")
                        }
                        backup.delete()
                    }
                    source.delete()
                }
                promise.resolve(target.absolutePath)
            } catch (e: Exception) {
                promise.reject("PDF_MOVE_FAILED", "Failed to move PDF: ${e.message}", e)
            }
        }
    }

    /**
     * Deletes cached page renders (cacheDir/pdfium_renders) except the given file paths,
     * which are still displayed. Returns the number of files removed.
     */
    @ReactMethod
    fun purgeRenderCache(keepPaths: ReadableArray, promise: Promise) {
        executor.execute {
            try {
                val keep = HashSet<String>()
                for (i in 0 until keepPaths.size()) {
                    val p = keepPaths.getString(i) ?: continue
                    keep.add(File(resolveLocalPath(p)).absolutePath)
                }
                val renderDir = File(reactContext.cacheDir, "pdfium_renders")
                var removed = 0
                renderDir.listFiles()?.forEach { file ->
                    if (file.isFile && !keep.contains(file.absolutePath)) {
                        if (file.delete()) removed++
                    }
                }
                promise.resolve(removed)
            } catch (e: Exception) {
                promise.reject("PDF_RENDER_PURGE_FAILED", e.message, e)
            }
        }
    }

    /**
     * Deletes temporary import copies in cacheDir/picked_pdfs and cacheDir/resolved_pdfs
     * (copies this module made from picker / content:// URIs) except `keepPaths`. Imported
     * PDFs live in durable document storage, so these copies are obsolete once imported.
     * Only files inside those two cache directories are ever touched; user files never are.
     * Returns the number of files removed.
     */
    @ReactMethod
    fun purgeImportCache(keepPaths: ReadableArray, promise: Promise) {
        executor.execute {
            try {
                val keep = HashSet<String>()
                for (i in 0 until keepPaths.size()) {
                    val p = keepPaths.getString(i) ?: continue
                    val plain = if (p.startsWith("file://")) p.substring(7) else p
                    keep.add(File(plain).canonicalPath)
                }
                var removed = 0
                for (dirName in listOf("picked_pdfs", "resolved_pdfs")) {
                    File(reactContext.cacheDir, dirName).listFiles()?.forEach { file ->
                        if (file.isFile && !keep.contains(file.canonicalPath)) {
                            if (file.delete()) removed++
                        }
                    }
                }
                promise.resolve(removed)
            } catch (e: Exception) {
                promise.reject("PDF_IMPORT_CACHE_PURGE_FAILED", e.message, e)
            }
        }
    }

    /**
     * Save As: lets the user choose filename and destination with the system
     * ACTION_CREATE_DOCUMENT picker, then copies the given VERIFIED app-private PDF there.
     *
     * - The source must be an existing PDF inside app-private storage (it is only read).
     * - Cancel resolves null; nothing is written.
     * - After writing, the destination is read back and compared (size + SHA-256); on any
     *   write/verification failure the partial destination document is deleted and the
     *   promise is rejected with PDF_SAVE_AS_WRITE_FAILED / PDF_SAVE_AS_VERIFY_FAILED.
     * Resolves { uri, displayName, sizeBytes }.
     */
    @ReactMethod
    fun saveCopyToUserLocation(sourcePath: String, suggestedName: String, promise: Promise) {
        val source = try {
            requireVerifiablePdf(sourcePath)
        } catch (e: Exception) {
            promise.reject("PDF_SAVE_AS_SOURCE_INVALID", e.message, e)
            return
        }
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("ACTIVITY_NOT_FOUND", "Cannot open the save location picker without an active activity")
            return
        }
        if (pendingSaveAs != null) {
            promise.reject("PDF_SAVE_AS_BUSY", "Another Save As is already in progress")
            return
        }
        pendingSaveAs = PendingSaveAs(source, promise)
        try {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/pdf"
                putExtra(Intent.EXTRA_TITLE, sanitizePdfFileName(suggestedName))
            }
            activity.startActivityForResult(intent, REQUEST_CODE_CREATE_PDF)
        } catch (e: Exception) {
            pendingSaveAs = null
            promise.reject("PDF_SAVE_AS_LAUNCH_FAILED", "Failed to open the save location picker: ${e.message}", e)
        }
    }

    private fun writeSaveAsCopy(pending: PendingSaveAs, destination: Uri) {
        val resolver = reactContext.contentResolver
        try {
            val sourceDigest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            val output = resolver.openOutputStream(destination, "w")
                ?: throw IllegalStateException("The chosen location cannot be written")
            output.use { out ->
                pending.source.inputStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        sourceDigest.update(buffer, 0, n)
                        written += n
                    }
                }
                out.flush()
            }

            // Read the destination back: only a byte-identical copy counts as saved.
            val destinationDigest = MessageDigest.getInstance("SHA-256")
            var readBack = 0L
            val input = resolver.openInputStream(destination)
                ?: throw IllegalStateException("The saved file could not be read back for verification")
            input.use { inp ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = inp.read(buffer)
                    if (n < 0) break
                    destinationDigest.update(buffer, 0, n)
                    readBack += n
                }
            }
            if (written != pending.source.length() || readBack != written ||
                !MessageDigest.isEqual(sourceDigest.digest(), destinationDigest.digest())) {
                deletePartialDocument(destination)
                pending.promise.reject("PDF_SAVE_AS_VERIFY_FAILED", "The saved copy does not match the verified PDF")
                return
            }

            var displayName: String? = null
            try {
                resolver.query(destination, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) displayName = cursor.getString(0)
                }
            } catch (_: Exception) {
                // Display name is informational only.
            }
            val result = Arguments.createMap().apply {
                putString("uri", destination.toString())
                putString("displayName", displayName ?: "")
                putDouble("sizeBytes", written.toDouble())
            }
            pending.promise.resolve(result)
        } catch (e: Exception) {
            deletePartialDocument(destination)
            pending.promise.reject("PDF_SAVE_AS_WRITE_FAILED", "Failed to write the PDF to the chosen location: ${e.message}", e)
        }
    }

    private fun deletePartialDocument(uri: Uri) {
        try {
            DocumentsContract.deleteDocument(reactContext.contentResolver, uri)
        } catch (_: Exception) {
            // Best effort: some providers do not support deletion.
        }
    }

    /**
     * Shares a VERIFIED app-private PDF through the system share sheet. A copy named after
     * the document is placed in cacheDir/pdf_exports and exposed only as a FileProvider
     * content:// URI with a read grant; app-private paths are never handed to other apps.
     * Resolves { contentUri, displayName }.
     */
    @ReactMethod
    fun sharePdf(sourcePath: String, displayName: String, chooserTitle: String, promise: Promise) {
        executor.execute {
            try {
                val source = requireVerifiablePdf(sourcePath)
                pruneExportCache(EXPORT_MAX_AGE_MS)
                val name = sanitizePdfFileName(displayName)
                val shareDir = File(File(reactContext.cacheDir, EXPORT_DIR), System.currentTimeMillis().toString())
                if (!shareDir.mkdirs() && !shareDir.isDirectory) {
                    throw IllegalStateException("Could not prepare the share folder")
                }
                val shared = File(shareDir, name)
                source.copyTo(shared, overwrite = true)
                if (shared.length() != source.length()) {
                    shared.delete()
                    throw IllegalStateException("The shared copy is incomplete")
                }

                val authority = "${reactContext.packageName}.provider"
                val contentUri = FileProvider.getUriForFile(reactContext, authority, shared)
                val sendIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "application/pdf"
                    putExtra(Intent.EXTRA_STREAM, contentUri)
                    clipData = ClipData.newRawUri(name, contentUri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val chooser = Intent.createChooser(sendIntent, chooserTitle).apply {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val activity = reactContext.currentActivity
                if (activity != null) {
                    activity.runOnUiThread {
                        try {
                            activity.startActivity(chooser)
                        } catch (e: Exception) {
                            android.util.Log.e("NativePdfiumModule", "Share sheet failed: ${e.message}", e)
                        }
                    }
                } else {
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    reactContext.startActivity(chooser)
                }

                val result = Arguments.createMap().apply {
                    putString("contentUri", contentUri.toString())
                    putString("displayName", name)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("PDF_SHARE_FAILED", "Failed to share the PDF: ${e.message}", e)
            }
        }
    }

    /**
     * Deletes share copies in cacheDir/pdf_exports older than maxAgeMs (0 = all).
     * Recent copies are kept so a receiving app can still read a just-shared file.
     */
    @ReactMethod
    fun purgeExportCache(maxAgeMs: Double, promise: Promise) {
        executor.execute {
            try {
                promise.resolve(pruneExportCache(maxAgeMs.toLong()))
            } catch (e: Exception) {
                promise.reject("PDF_EXPORT_CACHE_PURGE_FAILED", e.message, e)
            }
        }
    }


    // -----------------------------------------------------------------------------------------
    // Document operations: page tools, markup, merge, images -> PDF, search, thumbnails
    // -----------------------------------------------------------------------------------------

    private fun copyPickedPdf(uri: Uri): Pair<File, String> {
        var fileName = "Document.pdf"
        reactContext.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (cursor.moveToFirst() && nameIndex >= 0) {
                val n = cursor.getString(nameIndex)
                if (!n.isNullOrBlank()) fileName = n
            }
        }
        val cacheDir = File(reactContext.cacheDir, "picked_pdfs")
        if (!cacheDir.exists()) cacheDir.mkdirs()
        val safeName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
        val destFile = File(cacheDir, "${System.nanoTime()}_$safeName")
        reactContext.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(destFile).use { output -> input.copyTo(output) }
        } ?: throw IllegalStateException("The selected PDF could not be read")
        return destFile to fileName
    }

    /** Picks one or more PDFs (merge). Resolves an array (empty when cancelled). */
    @ReactMethod
    fun pickPdfDocuments(promise: Promise) {
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("ACTIVITY_NOT_FOUND", "Cannot launch file picker without active activity")
            return
        }
        pendingMultiPickPromise = promise
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/pdf"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            activity.startActivityForResult(intent, REQUEST_CODE_PICK_PDFS)
        } catch (e: Exception) {
            pendingMultiPickPromise = null
            promise.reject("PICK_LAUNCH_ERROR", "Failed to launch PDF picker: ${e.message}", e)
        }
    }

    private fun requireWritableOutput(outputPath: String): File {
        val out = File(resolveLocalPath(outputPath)).canonicalFile
        if (!isAppPrivate(out)) throw SecurityException("Output must be inside app storage")
        out.parentFile?.mkdirs()
        return out
    }

    @ReactMethod
    fun applyDocumentOperations(inputPath: String, outputPath: String, opsJson: String, promise: Promise) {
        executor.execute {
            try {
                val input = File(resolveLocalPath(inputPath))
                if (!input.exists()) {
                    promise.reject("PDF_FILE_NOT_FOUND", "Input PDF file not found")
                    return@execute
                }
                val out = requireWritableOutput(outputPath)
                if (out.absolutePath == input.canonicalPath) {
                    promise.reject("SAME_INPUT_OUTPUT", "Input and output must differ")
                    return@execute
                }
                promise.resolve(NativePdfiumBridge.nativeApplyDocumentOperationsJson(input.absolutePath, out.absolutePath, opsJson))
            } catch (e: Exception) {
                promise.reject("PDF_DOCUMENT_OPERATION_ERROR", "Document operation failed: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun mergeDocuments(inputPaths: ReadableArray, outputPath: String, promise: Promise) {
        executor.execute {
            try {
                val list = JSONArray()
                for (i in 0 until inputPaths.size()) {
                    val p = inputPaths.getString(i) ?: continue
                    list.put(File(resolveLocalPath(p)).absolutePath)
                }
                val out = requireWritableOutput(outputPath)
                promise.resolve(NativePdfiumBridge.nativeMergeDocumentsJson(list.toString(), out.absolutePath))
            } catch (e: Exception) {
                promise.reject("PDF_MERGE_ERROR", "Merging failed: ${e.message}", e)
            }
        }
    }

    /**
     * Decodes an image (file:// or content://, any Android-decodable format) upright (EXIF),
     * bounded to MAX_EMBED_IMAGE_SIDE, flattens transparency onto white and writes a JPEG.
     */
    private fun prepareJpeg(uriString: String, quality: Int): Triple<File, Int, Int> {
        val uri = if (uriString.startsWith("/")) Uri.fromFile(File(uriString)) else Uri.parse(uriString)
        val resolver = reactContext.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        // A bounds-only decode always returns null (it only fills `bounds`), so only a missing
        // stream means the image cannot be read.
        val boundsStream = resolver.openInputStream(uri) ?: throw IllegalStateException("The image could not be read")
        boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalStateException("This file is not a supported image (JPEG, PNG, WebP, HEIC or GIF)")
        }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_EMBED_IMAGE_SIDE) sample *= 2
        val decoded = resolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            })
        } ?: throw IllegalStateException("The image could not be decoded")
        val orientation = try {
            resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
        }
        val longSide = maxOf(decoded.width, decoded.height)
        if (longSide > MAX_EMBED_IMAGE_SIDE) {
            val s = MAX_EMBED_IMAGE_SIDE.toFloat() / longSide
            m.postScale(s, s)
        }
        val upright = if (m.isIdentity) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, m, true)
        if (upright !== decoded) decoded.recycle()
        val opaque = Bitmap.createBitmap(upright.width, upright.height, Bitmap.Config.ARGB_8888)
        Canvas(opaque).apply {
            drawColor(Color.WHITE)
            drawBitmap(upright, 0f, 0f, null)
        }
        upright.recycle()
        val dir = File(reactContext.cacheDir, COMPOSE_DIR)
        dir.mkdirs()
        val out = File(dir, "img_${System.nanoTime()}.jpg")
        FileOutputStream(out).use { opaque.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(50, 100), it) }
        val w = opaque.width
        val h = opaque.height
        opaque.recycle()
        return Triple(out, w, h)
    }

    /** Prepares an image for embedding into a PDF (addImage). Resolves {path, width, height}. */
    @ReactMethod
    fun prepareImageForPdf(imageUri: String, promise: Promise) {
        executor.execute {
            try {
                val (file, w, h) = prepareJpeg(imageUri, 90)
                promise.resolve(Arguments.createMap().apply {
                    putString("path", file.absolutePath)
                    putInt("width", w)
                    putInt("height", h)
                })
            } catch (oom: OutOfMemoryError) {
                promise.reject("IMAGE_TOO_LARGE", "Not enough memory to prepare this image", oom)
            } catch (e: Exception) {
                promise.reject("IMAGE_PREPARE_FAILED", "The image could not be prepared: ${e.message}", e)
            }
        }
    }

    /** Creates a PDF with one page per image. pageSize: "fit" | "a4" | "letter". */
    @ReactMethod
    fun createPdfFromImages(imageUris: ReadableArray, outputPath: String, pageSize: String, margin: Double, promise: Promise) {
        executor.execute {
            val temps = ArrayList<File>()
            try {
                val images = JSONArray()
                for (i in 0 until imageUris.size()) {
                    val uri = imageUris.getString(i) ?: continue
                    val (file, w, h) = prepareJpeg(uri, 88)
                    temps.add(file)
                    images.put(JSONObject().put("path", file.absolutePath).put("width", w).put("height", h))
                }
                if (images.length() == 0) {
                    promise.reject("INVALID_ARGUMENTS", "No images were given")
                    return@execute
                }
                val spec = JSONObject().put("images", images).put("pageSize", pageSize).put("margin", margin)
                val out = requireWritableOutput(outputPath)
                promise.resolve(NativePdfiumBridge.nativeCreatePdfFromImagesJson(spec.toString(), out.absolutePath))
            } catch (oom: OutOfMemoryError) {
                promise.reject("IMAGE_TOO_LARGE", "Not enough memory to create the PDF", oom)
            } catch (e: Exception) {
                promise.reject("PDF_CREATE_ERROR", "Creating the PDF failed: ${e.message}", e)
            } finally {
                temps.forEach { it.delete() }
            }
        }
    }

    @ReactMethod
    fun searchText(docHandle: Double, query: String, maxResults: Int, promise: Promise) {
        executor.execute {
            try {
                promise.resolve(NativePdfiumBridge.nativeSearchDocumentJson(docHandle.toLong(), query, maxResults.coerceIn(1, 2000)))
            } catch (e: Exception) {
                promise.reject("PDF_SEARCH_ERROR", "Search failed: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun getPageText(docHandle: Double, pageIndex: Int, promise: Promise) {
        executor.execute {
            try {
                promise.resolve(NativePdfiumBridge.nativeGetPageTextJson(docHandle.toLong(), pageIndex))
            } catch (e: Exception) {
                promise.reject("PDF_TEXT_ERROR", "Reading page text failed: ${e.message}", e)
            }
        }
    }

    /** Characters of a page for character-level text selection (see pdfium_bridge.cpp). */
    @ReactMethod
    fun getPageChars(docHandle: Double, pageIndex: Int, promise: Promise) {
        executor.execute {
            try {
                promise.resolve(NativePdfiumBridge.nativeGetPageCharsJson(docHandle.toLong(), pageIndex))
            } catch (e: Exception) {
                promise.reject("PDF_TEXT_ERROR", "Reading page characters failed: ${e.message}", e)
            }
        }
    }

    private fun renderToPng(docHandle: Long, pageIndex: Int, maxPixels: Int, outFile: File): IntArray? {
        val dims = NativePdfiumBridge.nativeGetPageSize(docHandle, pageIndex) ?: return null
        val longSide = maxOf(dims[0], dims[1])
        if (longSide <= 0) return null
        val scale = maxPixels.coerceIn(32, 2048) / longSide
        val w = ceil(dims[0] * scale).toInt().coerceAtLeast(1)
        val h = ceil(dims[1] * scale).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        try {
            if (!NativePdfiumBridge.nativeRenderPageToBitmap(docHandle, pageIndex, bitmap)) return null
            outFile.parentFile?.mkdirs()
            FileOutputStream(outFile).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally {
            bitmap.recycle()
        }
        return intArrayOf(w, h)
    }

    /** Small page render for the thumbnail strip / page grid (cacheDir/pdfium_thumbs). */
    @ReactMethod
    fun renderThumbnail(docHandle: Double, pageIndex: Int, maxPixels: Int, promise: Promise) {
        executor.execute {
            try {
                val out = File(File(reactContext.cacheDir, THUMB_DIR), "thumb_${docHandle.toLong()}_${pageIndex}_${System.nanoTime()}.png")
                val size = renderToPng(docHandle.toLong(), pageIndex, maxPixels, out)
                if (size == null) {
                    promise.reject("PDF_RENDER_FAILED", "Thumbnail could not be rendered")
                    return@execute
                }
                promise.resolve(Arguments.createMap().apply {
                    putString("filePath", out.absolutePath)
                    putString("uri", "file://${out.absolutePath}")
                    putInt("width", size[0])
                    putInt("height", size[1])
                    putInt("pageIndex", pageIndex)
                })
            } catch (e: Exception) {
                promise.reject("PDF_RENDER_ERROR", "Thumbnail failed: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun purgeThumbnailCache(promise: Promise) {
        executor.execute {
            var removed = 0
            File(reactContext.cacheDir, THUMB_DIR).listFiles()?.forEach { if (it.delete()) removed++ }
            File(reactContext.cacheDir, COMPOSE_DIR).listFiles()?.forEach { if (it.delete()) removed++ }
            promise.resolve(removed)
        }
    }

    /**
     * Renders page 1 of a PDF FILE (opened independently of any editor) to `outputPath`
     * (app-private, e.g. the document's library thumbnail). Resolves {uri, width, height, pageCount}.
     */
    @ReactMethod
    fun renderFileThumbnail(pdfPath: String, outputPath: String, maxPixels: Int, promise: Promise) {
        executor.execute {
            var handle = 0L
            try {
                val input = File(resolveLocalPath(pdfPath))
                if (!input.exists()) {
                    promise.reject("PDF_FILE_NOT_FOUND", "PDF not found")
                    return@execute
                }
                val out = requireWritableOutput(outputPath)
                handle = NativePdfiumBridge.nativeOpenDocument(input.absolutePath, null)
                if (handle <= 0L) {
                    promise.reject("PDF_OPEN_FAILED", "PDF could not be opened")
                    return@execute
                }
                val pageCount = NativePdfiumBridge.nativeGetPageCount(handle)
                val tmp = File(out.parentFile, "${out.name}.tmp")
                val size = renderToPng(handle, 0, maxPixels, tmp)
                if (size == null || !tmp.renameTo(out)) {
                    tmp.delete()
                    promise.reject("PDF_RENDER_FAILED", "Thumbnail could not be rendered")
                    return@execute
                }
                promise.resolve(Arguments.createMap().apply {
                    putString("uri", "file://${out.absolutePath}")
                    putInt("width", size[0])
                    putInt("height", size[1])
                    putInt("pageCount", pageCount)
                })
            } catch (e: Exception) {
                promise.reject("PDF_RENDER_ERROR", "Thumbnail failed: ${e.message}", e)
            } finally {
                if (handle > 0L) NativePdfiumBridge.nativeCloseDocument(handle)
            }
        }
    }

    private fun pruneExportCache(maxAgeMs: Long): Int {
        val exportRoot = File(reactContext.cacheDir, EXPORT_DIR)
        val cutoff = System.currentTimeMillis() - maxAgeMs
        var removed = 0
        exportRoot.listFiles()?.forEach { entry ->
            if (maxAgeMs <= 0L || entry.lastModified() < cutoff) {
                if (entry.deleteRecursively()) removed++
            }
        }
        return removed
    }

    /**
     * Resolves an output source: an existing, non-empty PDF file inside app-private storage
     * (never a user file or a content:// URI). Only read, never modified.
     */
    private fun requireVerifiablePdf(path: String): File {
        val plain = if (path.startsWith("file://")) path.substring(7) else path
        val file = File(plain).canonicalFile
        if (!isAppPrivate(file)) {
            throw SecurityException("Only PDFs stored by the app can be exported")
        }
        if (!file.isFile || file.length() <= 0L) {
            throw IllegalStateException("The PDF to export does not exist")
        }
        val header = ByteArray(5)
        val read = file.inputStream().use { it.read(header) }
        if (read != 5 || String(header, Charsets.US_ASCII) != "%PDF-") {
            throw IllegalStateException("The file to export is not a PDF")
        }
        return file
    }

    /** Safe display/file name: no path separators or control characters, ends with .pdf. */
    private fun sanitizePdfFileName(name: String?): String {
        var clean = (name ?: "").replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trim('.')
        if (clean.lowercase().endsWith(".pdf")) clean = clean.substring(0, clean.length - 4).trim()
        if (clean.isEmpty()) clean = "Document"
        if (clean.length > 120) clean = clean.substring(0, 120)
        return "$clean.pdf"
    }

    private fun isAppPrivate(file: File): Boolean {
        val roots = listOfNotNull(reactContext.filesDir, reactContext.cacheDir)
            .map { it.canonicalPath + File.separator }
        return roots.any { file.path.startsWith(it) }
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
