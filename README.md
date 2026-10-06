# PIE — PDF & Image Editor

PIE is an offline PDF and image editor for Android and iOS, built with React Native. It edits the
existing text in PDFs and in screenshots or photos, matches the original font and layout as
closely as possible, and does all processing on the device. Nothing is uploaded, there is no
account, and there is no cloud OCR or AI image generation.

## Features

### PDF
- Open, render, zoom (with sharp re-rendering of the visible area) and pan, including rotated pages
- **Select existing text like Google Drive:** long-press a word, then drag the handles to extend
  the selection character by character
- **Edit, replace and delete existing text**, including text inside nested Form XObjects; the
  rest of the line closes up or makes room
- Add text as movable, resizable text boxes (font, size, bold/italic, colour, alignment)
- Highlight, underline and strikethrough in a choice of colours; ink and shapes; signatures; images
- Pages: rotate, reorder, duplicate, insert blank, delete; merge PDFs; create a PDF from photos
- Find text, copy page text
- Undo/redo, Save, Save a Copy (system file picker), Share
- Every edit is verified by reopening the saved file; a failed edit is reported, never hidden
- The original file is never modified

### Images
- Import JPEG/PNG (camera, photo library, files) at original resolution, with EXIF orientation
- **On-device OCR**: Google ML Kit (Android), Apple Vision (iOS)
- **Replace or delete detected text**: the original text is removed and the background behind it
  is rebuilt deterministically (texture- and grain-preserving reconstruction; no AI)
- Font size estimated from the detected text; add new text; markup and signatures; crop, rotate, flip
- Undo/redo, saved edits, export to Photos (PNG/JPEG) at full resolution, Share

### App
- Library with search, filters, sort, grid/list views, rename, duplicate, share, delete
- Light/dark mode, iOS-style interface, haptics
- Works fully offline; the Android release build has no INTERNET permission

## Technology

| Area | Stack |
| --- | --- |
| App | React Native 0.87 (New Architecture, Hermes), React 19, TypeScript (strict) |
| UI | React Navigation 7, Reanimated, Gesture Handler, Skia |
| PDF engine | PDFium with a platform-neutral C++ bridge shared by Android (JNI) and iOS |
| OCR | Google ML Kit text recognition (Android), Apple Vision (iOS), on-device |
| Native | Kotlin + C++ (Android), Objective-C / C (iOS, `PieNative` pod) |

## Project layout

```
src/
  features/pdf        PDF editor model, selection, verification, rendering cache
  features/image      Image editing, render plan, background reconstruction
  features/ocr        OCR normalization and font size estimation
  screens/            Library, PDF editor, image editor, settings
  ui/                 Shared iOS-style controls, theme, overlays
android/app/src/main/cpp/pdfium   PDFium C++ engine (shared with iOS)
android/app/src/main/java/...     Kotlin native modules (PDF, image, OCR, storage)
ios/PieNative                     iOS native modules and C ports
__tests__/                        Jest suites (1,026 tests)
scripts/                          iOS PDFium fetch script, reconstruction parity check
```

## Building

Requirements: Node.js 22.11+, JDK 17 (Android Studio's JBR works), Android SDK with NDK
27.1.12297006. iOS builds need a Mac with Xcode and CocoaPods.

```sh
npm install
npm run typecheck
npm test
```

### Android

```sh
cd android
./gradlew assembleRelease     # APK: android/app/build/outputs/apk/release/app-release.apk
./gradlew bundleRelease       # AAB: android/app/build/outputs/bundle/release/app-release.aab
```

Release signing reads `android/keystore.properties` and the upload keystore, which are not
committed. Without them, use `./gradlew assembleDebug` for a debug build, or `npm run android`
with Metro running (`npm start`).

### iOS

```sh
./scripts/fetch-pdfium-ios.sh   # downloads the PDFium xcframework into ios/PieNative/Vendor
cd ios && pod install && cd ..
npm run ios
```

The iOS native layer is implemented but has not yet been built or tested on a Mac.

## Testing

- `npm test`: 58 Jest suites, 1,026 tests (editing models, PDF verification, OCR, reconstruction,
  persistence, UI behaviour)
- `npm run typecheck`: TypeScript strict
- `scripts/inpainting-parity/run-parity.sh`: checks that the Kotlin and C reconstruction ports are
  byte-identical to the TypeScript reference

The Android release build has been installed and checked on a physical device (OnePlus,
Android 16): PDF creation from photos, merge, add image, text selection/edit/delete,
save/reopen, OCR, text replace/delete with reconstruction, export, and restart.

## Known limitations

- Android OCR uses ML Kit's Latin recognizer.
- Highlights, ink and shapes are written into the page content, not as editable PDF annotations.
- Added PDF text uses the standard PDF fonts (WinAnsi characters).
- In PDFs whose words are made of widely spaced letter groups, a long-press selects part of the
  word; drag the handles to select the rest.
- iOS: not yet built or tested.

## Privacy

All documents stay in the app's private storage on the device. PIE has no account, no analytics,
no cloud storage and no network access in the Android release build.
