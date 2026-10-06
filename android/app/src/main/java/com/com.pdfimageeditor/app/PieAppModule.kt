package com.pdfimageeditor.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.util.concurrent.Executors

/**
 * App services used by the UI: haptics (predefined touch effects), clipboard,
 * plain-text sharing, app version and on-device storage usage / cache cleanup.
 * Everything is local; nothing touches the network.
 */
class PieAppModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "PieAppModule"

    /** Cache sub-directories owned by the app (never user files). */
    private val cacheDirs = listOf(
        "pdfium_renders", "pdfium_thumbs", "pdf_compose", "pdf_exports",
        "picked_pdfs", "resolved_pdfs", "exports"
    )

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (reactContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            reactContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    /**
     * Haptic feedback. Android 10+ plays the system's predefined touch effects through the
     * vibrator (tagged as touch feedback, so the user's haptic-intensity setting applies).
     * View.performHapticFeedback is only the fallback: its CLOCK_TICK / CONTEXT_CLICK constants
     * are silent on many devices (e.g. OnePlus/ColorOS), which made haptics appear broken.
     */
    @ReactMethod
    fun haptic(kind: String) {
        val v = vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && v != null && v.hasVibrator()) {
            val effect = when (kind) {
                "selection" -> VibrationEffect.EFFECT_TICK
                "light" -> VibrationEffect.EFFECT_CLICK
                "medium" -> VibrationEffect.EFFECT_HEAVY_CLICK
                "success" -> VibrationEffect.EFFECT_CLICK
                "warning", "error" -> VibrationEffect.EFFECT_DOUBLE_CLICK
                else -> VibrationEffect.EFFECT_CLICK
            }
            try {
                val predefined = VibrationEffect.createPredefined(effect)
                if (Build.VERSION.SDK_INT >= 33) {
                    v.vibrate(predefined, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
                } else {
                    @Suppress("DEPRECATION")
                    v.vibrate(
                        predefined,
                        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).build()
                    )
                }
                return
            } catch (_: Exception) {
                // Fall back to view haptics below
            }
        }
        val activity = reactContext.currentActivity ?: return
        activity.runOnUiThread {
            val view = activity.window?.decorView ?: return@runOnUiThread
            val constant = when (kind) {
                "selection" -> HapticFeedbackConstants.KEYBOARD_TAP
                "medium" -> HapticFeedbackConstants.LONG_PRESS
                "success" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
                "warning", "error" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
                else -> HapticFeedbackConstants.VIRTUAL_KEY
            }
            view.performHapticFeedback(constant)
        }
    }

    @ReactMethod
    fun setClipboardString(text: String, promise: Promise) {
        try {
            val manager = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(ClipData.newPlainText("PIE", text))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CLIPBOARD_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun shareText(text: String, title: String, promise: Promise) {
        try {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            val chooser = Intent.createChooser(send, title)
            val activity = reactContext.currentActivity
            if (activity != null) {
                activity.runOnUiThread { activity.startActivity(chooser) }
            } else {
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(chooser)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SHARE_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun getAppInfo(promise: Promise) {
        try {
            val pm = reactContext.packageManager
            val info = pm.getPackageInfo(reactContext.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
            promise.resolve(Arguments.createMap().apply {
                putString("version", info.versionName ?: "1.0")
                putString("build", code.toString())
                putString("platform", "android")
                putString("osVersion", Build.VERSION.RELEASE ?: "")
                putString("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            })
        } catch (e: Exception) {
            promise.reject("APP_INFO_FAILED", e.message, e)
        }
    }

    private fun sizeOf(file: File): Long {
        if (!file.exists()) return 0L
        if (file.isFile) return file.length()
        return file.listFiles()?.sumOf { sizeOf(it) } ?: 0L
    }

    @ReactMethod
    fun getStorageUsage(promise: Promise) {
        executor.execute {
            try {
                val documents = sizeOf(File(reactContext.filesDir, "pie"))
                val cache = cacheDirs.sumOf { sizeOf(File(reactContext.cacheDir, it)) }
                promise.resolve(Arguments.createMap().apply {
                    putDouble("documentsBytes", documents.toDouble())
                    putDouble("cacheBytes", cache.toDouble())
                })
            } catch (e: Exception) {
                promise.reject("STORAGE_USAGE_FAILED", e.message, e)
            }
        }
    }

    /** Clears the app's temporary caches (renders, thumbnails, share/export copies). */
    @ReactMethod
    fun clearCaches(promise: Promise) {
        executor.execute {
            try {
                var freed = 0L
                for (name in cacheDirs) {
                    val dir = File(reactContext.cacheDir, name)
                    freed += sizeOf(dir)
                    dir.listFiles()?.forEach { it.deleteRecursively() }
                }
                promise.resolve(freed.toDouble())
            } catch (e: Exception) {
                promise.reject("CLEAR_CACHE_FAILED", e.message, e)
            }
        }
    }
}
