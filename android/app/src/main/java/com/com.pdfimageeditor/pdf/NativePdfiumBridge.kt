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
}
