package com.pdfimageeditor

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Native project-owned OCR package (Google ML Kit on-device)
          add(com.pdfimageeditor.ocr.OcrPackage())
          // Native project-owned image background reconstruction package
          add(com.pdfimageeditor.image.ImageProcessingPackage())
          // Native project-owned PDFium engine package
          add(com.pdfimageeditor.pdf.NativePdfiumPackage())
          // Native project-owned durable document file store (app-private, offline)
          add(com.pdfimageeditor.storage.PieFileStorePackage())
          // Native project-owned app services (haptics, clipboard, storage usage)
          add(com.pdfimageeditor.app.PieAppPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
