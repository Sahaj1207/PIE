package com.pdfimageeditor.storage

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * Project-owned, offline file store backing durable document persistence.
 *
 * - Root: <app filesDir>/pie (app-private, not purged like cacheDir).
 * - All destination paths (writes, copies, deletes, mkdirs) must resolve inside the root;
 *   anything else is rejected, so this module can never modify files outside the app
 *   sandbox (in particular, user source images are never written).
 * - Operations run sequentially on a single background thread.
 */
class PieFileStoreModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "PieFileStoreModule"

    private fun rootDir(): File {
        val root = File(reactContext.filesDir, "pie")
        if (!root.exists()) root.mkdirs()
        return root
    }

    private fun stripScheme(path: String): String =
        if (path.startsWith("file://")) path.substring(7) else path

    /** Resolves a path and verifies it lies inside the storage root. */
    private fun resolveInsideRoot(path: String): File {
        val file = File(stripScheme(path)).canonicalFile
        val root = rootDir().canonicalFile
        if (file != root && !file.path.startsWith(root.path + File.separator)) {
            throw SecurityException("Path is outside of the PIE storage root: $path")
        }
        return file
    }

    private fun isInsideRoot(file: File): Boolean = try {
        val f = file.canonicalFile
        val root = rootDir().canonicalFile
        f.path.startsWith(root.path + File.separator)
    } catch (_: Exception) {
        false
    }

    private fun backupOf(target: File): File = File(target.parentFile, ".${target.name}.bak")

    /**
     * Replaces `target` with the fully written and synced `tmp`. rename(2) over an existing file
     * is atomic on Android's filesystems; when a filesystem refuses it, the previous version is
     * kept as a backup until the new file is in place, so a crash can never leave the file
     * missing (recoverInterruptedReplace restores it on the next read).
     */
    private fun moveIntoPlace(tmp: File, target: File) {
        if (tmp.renameTo(target)) return
        val backup = backupOf(target)
        backup.delete()
        val hadTarget = target.exists()
        if (hadTarget && !target.renameTo(backup)) {
            tmp.delete()
            throw IllegalStateException("Could not replace ${target.path}")
        }
        if (!tmp.renameTo(target)) {
            if (hadTarget) backup.renameTo(target)
            tmp.delete()
            throw IllegalStateException("Could not move temp file into place: ${target.path}")
        }
        backup.delete()
    }

    /** Restores the previous version if a replace was interrupted between its two renames. */
    private fun recoverInterruptedReplace(target: File) {
        if (target.exists()) return
        val backup = backupOf(target)
        if (backup.exists()) backup.renameTo(target)
    }

    @ReactMethod
    fun getRootPath(promise: Promise) {
        try {
            promise.resolve(rootDir().canonicalPath)
        } catch (e: Exception) {
            promise.reject("FILE_STORE_ROOT_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun writeFileAtomic(path: String, contents: String, promise: Promise) {
        executor.execute {
            try {
                val target = resolveInsideRoot(path)
                target.parentFile?.mkdirs()
                val tmp = File(target.parentFile, ".${target.name}.tmp")
                FileOutputStream(tmp).use { out ->
                    out.write(contents.toByteArray(Charsets.UTF_8))
                    out.fd.sync()
                }
                moveIntoPlace(tmp, target)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("FILE_STORE_WRITE_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun readFile(path: String, promise: Promise) {
        executor.execute {
            try {
                val file = resolveInsideRoot(path)
                recoverInterruptedReplace(file)
                if (!file.exists()) {
                    promise.reject("FILE_STORE_NOT_FOUND", "File not found: ${file.path}")
                    return@execute
                }
                promise.resolve(file.readText(Charsets.UTF_8))
            } catch (e: Exception) {
                promise.reject("FILE_STORE_READ_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun exists(path: String, promise: Promise) {
        executor.execute {
            try {
                // Existence checks may target files outside the root (e.g. cache patches).
                val file = File(stripScheme(path))
                if (isInsideRoot(file)) recoverInterruptedReplace(file.canonicalFile)
                promise.resolve(file.exists())
            } catch (e: Exception) {
                promise.reject("FILE_STORE_EXISTS_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun copyFile(fromPath: String, toPath: String, promise: Promise) {
        executor.execute {
            try {
                val source = File(stripScheme(fromPath))
                if (!source.exists() || !source.isFile) {
                    promise.reject("FILE_STORE_NOT_FOUND", "Source file not found: ${source.path}")
                    return@execute
                }
                val target = resolveInsideRoot(toPath)
                target.parentFile?.mkdirs()
                val tmp = File(target.parentFile, ".${target.name}.tmp")
                source.inputStream().use { input ->
                    FileOutputStream(tmp).use { output ->
                        input.copyTo(output)
                        output.fd.sync()
                    }
                }
                moveIntoPlace(tmp, target)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("FILE_STORE_COPY_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun deletePath(path: String, promise: Promise) {
        executor.execute {
            try {
                val file = resolveInsideRoot(path)
                if (file == rootDir().canonicalFile) {
                    throw SecurityException("Refusing to delete the PIE storage root")
                }
                if (file.exists()) {
                    file.deleteRecursively()
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("FILE_STORE_DELETE_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun listDirectory(path: String, promise: Promise) {
        executor.execute {
            try {
                val dir = resolveInsideRoot(path)
                val result = Arguments.createArray()
                if (dir.isDirectory) {
                    dir.listFiles()
                        ?.filter { !it.name.startsWith(".") }
                        ?.sortedBy { it.name }
                        ?.forEach { result.pushString(it.name) }
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("FILE_STORE_LIST_FAILED", e.message, e)
            }
        }
    }

    @ReactMethod
    fun makeDirectory(path: String, promise: Promise) {
        executor.execute {
            try {
                val dir = resolveInsideRoot(path)
                if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory) {
                    throw IllegalStateException("Could not create directory: ${dir.path}")
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("FILE_STORE_MKDIR_FAILED", e.message, e)
            }
        }
    }

    override fun invalidate() {
        executor.shutdown()
        super.invalidate()
    }
}
