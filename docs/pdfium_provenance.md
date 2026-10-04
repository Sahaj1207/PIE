# PDFium Native Engine — Provenance & Integration Notes

## 1. Upstream Source & Distribution
* **Upstream Project**: Google PDFium (Chromium PDF rendering engine)
* **Upstream Repository**: [https://pdfium.googlesource.com/pdfium](https://pdfium.googlesource.com/pdfium)
* **Prebuilt Distribution**: `bblanchon/pdfium-binaries` ([https://github.com/bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries))
* **Exact Distribution Tag**: `chromium/8066`
* **Chromium Branch / Version**: Chromium 156.0.8066.0
* **Build Date**: March 2026

> [!NOTE]
> **Provenance Accuracy**: The prebuilt binaries are built via automated GitHub Actions workflows directly from the upstream Google Chromium PDFium source repository by Benoit Blanchon. They are not direct pre-packaged downloads from google.com, but faithfully compile official Google Chromium PDFium source.

---

## 2. Licensing
* **Upstream PDFium License**: BSD 3-Clause License (Google Inc. / The Chromium Authors) & Apache 2.0 License.
* **Packaging Scripts**: Apache 2.0 License.
* **Commercial Restrictions**: None. Full commercial and non-commercial use permitted without seat fees, trial expiration watermarks, or token verification.
* **Redistribution Requirements**: Retain standard BSD 3-Clause copyright notice and Apache 2.0 attribution notices in third-party licenses documentation.

---

## 3. Native Integration Architecture
* **Build System**: Android NDK 27.1.12297006 + CMake 3.22.1 via Gradle `externalNativeBuild`.
* **C++ Standard**: C++17 (`-std=c++17`, `c++_shared` STL).
* **JNI Bridge**: Project-owned `libpdfium_bridge.so` (`android/app/src/main/cpp/pdfium_bridge.cpp`).
* **Isolation**: All PDFium interaction is strictly confined inside C++ JNI. Zero PDFium types/classes are exposed across the React Native bridge.
* **Threading**: Heavy document parsing, page rendering, and object extraction execute on a background Java thread pool (`Executors.newFixedThreadPool(2)`), keeping the React Native JS thread and Android UI thread completely unblocked.
* **Rendering Pipeline**: Direct hardware-accelerated rendering into Android `Bitmap` locked pixel memory (`AndroidBitmap_lockPixels` / `FPDF_REVERSE_BYTE_ORDER`), saved to disk cache via PNG compression.

---

## 4. Android ABI Coverage
| ABI | Binary | Size | Status |
| :--- | :--- | :--- | :--- |
| `arm64-v8a` | `android/app/src/main/jniLibs/arm64-v8a/libpdfium.so` | 6.46 MB | **Verified & Included** |
| `armeabi-v7a` | `android/app/src/main/jniLibs/armeabi-v7a/libpdfium.so` | 4.26 MB | **Verified & Included** |
| `x86_64` | `android/app/src/main/jniLibs/x86_64/libpdfium.so` | 6.71 MB | **Verified & Included** (Emulator) |
| `x86` | Omitted (deprecated 32-bit emulator ABI) | - | Excluded to reduce APK footprint |

---

## 5. iOS Integration Preparedness
* `bblanchon/pdfium-binaries` distributes pre-packaged iOS universal XCFrameworks (`pdfium.xcframework` for `ios-arm64` and `ios-arm64_x86_64-simulator`).
* The C++ bridge architecture (`pdfium_bridge.cpp`) and TypeScript interfaces are completely platform-agnostic.
* Status on current Windows workstation: **UNVERIFIED AT RUNTIME ON IOS** (macOS and Xcode toolchain required to compile and sign iOS targets).
