package com.pdfimageeditor.pdf

import android.graphics.Bitmap

object NativePdfiumBridge {
    init {
        try {
            System.loadLibrary("pdfium")
            System.loadLibrary("pdfium_bridge")
        } catch (e: UnsatisfiedLinkError) {
            android.util.Log.e("NativePdfiumBridge", "Failed to load native PDFium libraries: ${e.message}")
        }
    }

    @JvmStatic
    external fun nativeInit()

    @JvmStatic
    external fun nativeDestroy()

    @JvmStatic
    external fun nativeOpenDocument(filePath: String, password: String?): Long

    @JvmStatic
    external fun nativeCloseDocument(docHandle: Long)

    @JvmStatic
    external fun nativeGetPageCount(docHandle: Long): Int

    @JvmStatic
    external fun nativeGetPageSize(docHandle: Long, pageIndex: Int): DoubleArray?

    @JvmStatic
    external fun nativeRenderPageToBitmap(docHandle: Long, pageIndex: Int, bitmap: Bitmap): Boolean

    /** [displayWidth, displayHeight, rotation(0-3), a, b, c, d, e, f] (user -> display matrix). */
    @JvmStatic
    external fun nativeGetPageGeometry(docHandle: Long, pageIndex: Int): DoubleArray?

    /** Renders the display-space region starting at (left, top) points at `scale` px/pt. */
    @JvmStatic
    external fun nativeRenderPageRegionToBitmap(
        docHandle: Long,
        pageIndex: Int,
        bitmap: Bitmap,
        scale: Double,
        left: Double,
        top: Double
    ): Boolean

    @JvmStatic
    external fun nativeGetTextObjectsJson(docHandle: Long, pageIndex: Int): String

    @JvmStatic
    external fun nativeReplaceTextObjectJson(
        inputPath: String,
        outputPath: String,
        pageIndex: Int,
        objectIndex: Int,
        replacementText: String
    ): String

    @JvmStatic
    external fun nativeApplyBatchEditsJson(
        inputPath: String,
        outputPath: String,
        editsJson: String
    ): String

    @JvmStatic
    external fun nativeGetLastError(): Int

    /** Page tools + markup (pie_pdf_ops.h). Returns a JSON result (success / errorCode). */
    @JvmStatic
    external fun nativeApplyDocumentOperationsJson(inputPath: String, outputPath: String, opsJson: String): String

    /** inputsJson = JSON array of absolute PDF paths. */
    @JvmStatic
    external fun nativeMergeDocumentsJson(inputsJson: String, outputPath: String): String

    /** specJson = {"images":[{"path","width","height"}],"pageSize","margin"} (JPEG files). */
    @JvmStatic
    external fun nativeCreatePdfFromImagesJson(specJson: String, outputPath: String): String

    @JvmStatic
    external fun nativeSearchDocumentJson(docHandle: Long, query: String, maxResults: Int): String

    @JvmStatic
    external fun nativeGetPageTextJson(docHandle: Long, pageIndex: Int): String

    /** Characters of a page (boxes, baselines, owning text objects) for text selection. */
    @JvmStatic
    external fun nativeGetPageCharsJson(docHandle: Long, pageIndex: Int): String
}
