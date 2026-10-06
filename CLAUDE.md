\# PIE — PDF \& Image Editor



\## Project



PIE is an offline-first PDF and Image Editor built with React Native for Android and iOS.



Canonical project (active workspace):

`D:\\PIE-source-correct`

(Source-only project imported from the finished Phase 11 ZIP. It supersedes the earlier `D:\\PDFImageEditor` path. Do not switch paths, recreate or copy the project.)



GitHub:

`Sahaj1207/PIE`



\## Critical Rule



This project was developed incrementally through Phase 11.



DO NOT rewrite the architecture.

DO NOT replace working systems without first auditing them.

DO NOT copy anything from the legacy project:



`D:\\PDF \& Image Editor`



The legacy project is not the source of truth.



The current PIE repository is the source of truth.



\---



\# Technology



\- React Native 0.87.1

\- React 19

\- TypeScript strict

\- Hermes

\- React Native New Architecture

\- React Native Reanimated

\- React Native Gesture Handler

\- react-native-worklets

\- @shopify/react-native-skia

\- React Navigation 7



Native:



Android:

\- Kotlin

\- C++

\- PDFium

\- Google ML Kit on-device OCR



iOS:

\- Swift / Objective-C

\- Apple Vision OCR



The application is designed to work offline.



\---



\# Product Requirements



PIE must support:



\## PDF



\- Import PDF

\- Render PDF

\- Zoom

\- Pan

\- Select existing text

\- Edit existing text

\- Delete existing text

\- Add text

\- Text formatting

\- Nested Form XObject handling

\- Undo / redo

\- Save

\- Save As

\- Reopen

\- Source immutability

\- Reliable lifecycle handling



\## Images



\- Import images

\- Display original image dimensions

\- Zoom

\- Pan

\- OCR

\- Select detected text

\- Edit detected text

\- Replace detected text

\- Delete detected text

\- Deterministic background reconstruction

\- Multiple replacements

\- Undo / redo

\- Export preparation



\## Privacy



Core processing must remain on-device.



Do NOT introduce:



\- cloud uploads

\- mandatory accounts

\- subscriptions

\- collaboration

\- cloud document storage

\- remote OCR

\- generative AI image editing



\---



\# Completed Phases



\## Phase 1

Foundation and import/rendering.



\## Phase 2

Coordinate system and gesture foundation.



\## Phase 3

PDF document extraction, object identity, selection and hit testing.



\## Phase 4A

PDF existing-text replacement.



\## Phase 4B

PDF existing-text deletion.



\## Phase 4C

PDF Add Text.



\## Phase 4D

PDF save/reopen/persistence hardening.



\## Phase 5

PDF formatting and layout fidelity.



\## Phase 6

PDF lifecycle, Save/Save As and navigation hardening.



\## Phase 7

Image editor foundation:

\- image import

\- rendering

\- intrinsic dimensions

\- orientation

\- viewport

\- zoom

\- pan

\- coordinate mapping



\## Phase 8

On-device OCR:

\- Android ML Kit

\- iOS Vision

\- OCR normalization

\- OCR boxes

\- OCR hit testing

\- OCR selection

\- OCR caching



\## Phase 9

Image text editing:

\- OCR selection integration

\- image text editing modal

\- replacement model

\- style estimation

\- font fallback

\- text fitting

\- deterministic background reconstruction

\- patch/layer model

\- replacement preview

\- replacement application

\- text deletion

\- multiple replacements

\- undo/redo

\- dirty state

\- export preparation

\- error handling



Latest Phase 9 automated result:



549 tests passed after removal of obsolete Nutrient spike tests.



TypeScript passed.



\---



\# Current Verification Status



Automated tests:

PASS



TypeScript:

PASS



Android build:

Previously verified through Phase 9 implementation.



Android runtime:

Previously verified through Phase 8 baseline.



Physical image editing:

NOT YET VERIFIED.



Note: the statuses above are the Phase 9 baseline. Phase 10, Phase 11, the Phase 11 finalization cleanup, Phase 12, Phase 13, Phase 14 and Phase 15 have NOT been tested, typechecked, built, installed or run (see the phase sections below).



Important:



Do NOT claim that the complete image editing workflow is physically working merely because automated tests pass.



Physical QA will be performed separately after the integrated product is ready.



\---



\# Architecture Rules



\## Coordinate Systems



Document coordinates are the source of truth.



Do not persist screen coordinates.



Viewport transformations must be centralized.



Zoom and pan must not alter document-space data.



\## Source Immutability



Original PDFs and images must never be destructively modified.



Edits must operate on:



\- working copies

\- reversible patches

\- editing layers

\- or equivalent safe representations



\## PDF



PDFium is the PDF engine.



Do not replace PDFium with another PDF engine without explicit approval.



\## Image



Skia is the primary rendering layer.



Do not create a second rendering system.



\## OCR



Android:

Google ML Kit, on-device.



iOS:

Apple Vision.



Do not add cloud OCR.



\## Editing



Image text edits should use deterministic local processing.



Do not introduce generative AI or cloud image processing.



\---



\# Testing Rules



Every feature phase must include:



1\. Implementation

2\. Automated tests

3\. TypeScript validation

4\. Android bundle/build

5\. Installation when device is available

6\. Runtime verification



Reports must distinguish:



\- IMPLEMENTED IN CODE

\- AUTOMATED TESTED

\- RUNTIME VERIFIED

\- PHYSICALLY VERIFIED

\- NOT VERIFIED

\- BLOCKED



Never equate compilation/tests with physical feature verification.



Do not remove existing regression tests simply to make a new feature pass.



\---



\# Code Change Rules



Before making major architectural changes:



1\. Inspect the existing implementation.

2\. Identify what can be reused.

3\. Explain what will change.

4\. Preserve existing functionality.

5\. Add regression tests.

6\. Run the full test suite.



Do not create duplicate:



\- coordinate systems

\- history systems

\- selection systems

\- rendering systems

\- document models

\- OCR models



Reuse existing infrastructure whenever possible.



\---



\# Legacy Project



Never use:



`D:\\PDF \& Image Editor`



It is an old project and is NOT the source of truth.



Only use:



`D:\\PIE-source-correct`



\---



\# Phase 10 Implementation Status

Phase 10 — Image Export + Persistence + Save/Reopen is IMPLEMENTED IN CODE.

NOT executed / NOT verified (per the agreed workflow: all phases first, then full test run, typecheck, build, install and physical QA):

\- Automated tests (existing 549 + new Phase 10 suites): NOT RUN

\- TypeScript: NOT RUN

\- Android build: NOT RUN (new Kotlin code is uncompiled)

\- Runtime / physical image save, reopen, export: NOT VERIFIED

Approved decisions:

\- D1: EditorScreen Document/TextRegion/AddedText model + DocumentHistoryManager is the canonical image editing architecture. ImageEditingEngine / ImagePatchHistoryManager (Phase 9) remain test-only and are not wired into the UI.

\- D2: Export to MediaStore Pictures/PIE on Android 10+, Share everywhere; no storage permission.

\- D3: Durable storage via project-owned PieFileStoreModule (Kotlin) + FileSystemDocumentStorage. No new npm dependencies.

\- D4: OCR detection is an undoable history step persisted with the document; re-detection preserves edits/deletions and assigns collision-free IDs.

\- D5: Large-image safety: viewport-sized Skia surface, display preview, full-resolution working copy for editing/export, region-based reconstruction, fit-aware minimum zoom.

\- D6: No iOS native work in Phase 10; JS falls back safely (in-memory storage, legacy import, export unavailable error).

Persistence layout (app-private filesDir/pie):

\- documents/<id>/document.json (schemaVersion 1, document-relative "pie-doc:" references)

\- documents/<id>/assets (upright working image + preview), documents/<id>/patches

\- sessions/<id>/patches (unsaved session patches; removed on editor close and at app start)

Known not covered by Phase 10: PDF TS/native contract mismatch and other PDF issues (deliberately untouched), iOS native parity.



\# Phase 11 Implementation Status

Phase 11 — PDF Correctness & Persistence Hardening is IMPLEMENTED IN CODE (hardening of existing PDF requirements, no new features).

NOT executed / NOT verified: automated tests (existing + new Phase 11 suites) NOT RUN, TypeScript NOT RUN, Android build NOT RUN (new Kotlin moveFile/purgeRenderCache uncompiled), runtime/physical PDF QA NOT VERIFIED.

Implemented:

\- One canonical batch result (PdfMultiEditResult) produced by normalizeNativeBatchResult() from the REAL native JSON (success, commandResults[].applied, verifiedInReopened, sourceSha*). Native success:false becomes a typed error; un-applied commands are failed; the editor never reports a failed native edit as success. Legacy TS-shaped fixtures still accepted.

\- Save never sends an empty edit batch: applied working-copy edits are persisted through the explicit copyDocument() operation; queued commands through one batch. Output is reopened/validated; saving onto a file still needed (open/clean/revision) is staged and promoted (native moveFile).

\- One PDF editor, one history: applied edits are 'revision' history entries (undo/redo reopen the before/after PDF files); queued edits outstanding at apply time are folded into the native batch and restored by undo. undo()/redo() are async.

\- Dirty state derived from facts (queued edits, open file != last clean file, failed save). Discard returns to the last clean file (opened or saved).

\- Applied deletions no longer hide the next object that inherits the positional ID; stale references are rejected by object fingerprint. Nested Form XObject objectPath preserved in redo.

\- Working copies live in sessions/<docId>/working (flat names, cleaned after save, on close and at app start); page renders purged; saved PDFs written to documents/<docId>/rev_<ts>.pdf with a stable record id; older revisions pruned (source/active/undo files protected). PDF record paths inside the document directory are stored document-relative.

Not changed: PDFium, C++ bridge, JSON bridge architecture, coordinate pipeline, Skia, image editing, Phase 10 image persistence/export, OCR.

Phase 11 status: COMPLETED IN CODE and APPROVED (including the finalization cleanup below). Verification deferred per the workflow rule below.



\## Phase 11 Finalization Cleanup (IMPLEMENTED IN CODE, NOT RUN)

\- Removed stale checked-in `android/app/src/main/jniLibs/<abi>/libpdfium_bridge.so` (arm64-v8a, armeabi-v7a, x86_64). They predated the current `pdfium_bridge.cpp` (no objectPath / nested Form XObject locator support) and collided with the CMake-built library of the same name. `libpdfium.so` (prebuilt PDFium, imported by CMakeLists.txt) is kept. `libpdfium_bridge.so` is now produced only by the CMake build of `cpp/pdfium/pdfium_bridge.cpp`.

\- Removed obsolete `PdfSpikeModule.kt` / `PdfSpikePackage.kt` and their registration in `MainApplication.kt` (no JS or test callers). `NativePdfiumModule` (PdfiumNativeModule) is the only PDF native module. Assets `pdfium_spike_sample.pdf` (used by `extractAssetPdf`) and `sample.pdf` are left untouched.

\- copyDocument / applyBatchEdits separation is explicit: `IPdfiumEngine.copyDocument()` is REQUIRED; `PdfDocumentEditor.saveDocument()` calls either `applyBatchEdits()` with a non-empty batch or `copyDocument()`, with no empty-batch fallback. `PdfiumEngine.applyBatchEdits()` rejects empty batches; `copyDocument()` is the only path that sends `[]` to native. Legacy test doubles (phase4a–4d, phase5, phase6, crossEditorIntegration) implement `copyDocument` by delegating to their own mocked batch so existing regression tests keep their behavior.

\- Known remaining minor issue (not changed): if a save must be staged and the engine lacks the optional `replaceFile`, the result stays at the `.tmp_<ts>.pdf` path. The Android PdfiumEngine implements `replaceFile`.



\# Workflow Rule (current)

Implement ALL remaining phases first. Do NOT run Jest, tsc, Gradle/Android builds, APK install, ADB/device testing, iOS builds or physical testing until the entire product implementation is finished. Then: full automated test suite, typecheck, Android build/install, physical QA.



\# Phase 12 Implementation Status

Phase 12 — Integrity & Correctness Hardening is IMPLEMENTED IN CODE (no new product features).

NOT executed / NOT verified: automated tests (existing + new Phase 12 suites) NOT RUN, C++ core test NOT COMPILED/RUN, TypeScript NOT RUN, Android build NOT RUN (C++ bridge changes and Kotlin purgeImportCache uncompiled), runtime/physical NOT VERIFIED.

Implemented:

\- Stale JS bundle: checked-in `android/app/src/main/assets/index.android.bundle` removed and git-ignored. Debug loads JS from Metro; release bundles are generated by the React Native Gradle plugin. No custom bundle configuration.

\- Reconstruction false success: `LocalBackgroundReconstructionEngine` throws `ImageReconstructionUnavailableError` (code IMAGE_RECONSTRUCTION_UNAVAILABLE) when the native processor is missing outside tests; native results without a patch file or with invalid bounds are rejected. The simulated patch exists only when NODE_ENV === 'test' (same rule as image export).

\- Pure C++ core `android/app/src/main/cpp/pdfium/pie_bridge_core.h` (no JNI/PDFium): strict JSON parser (all escapes, \\uXXXX surrogate pairs, key lookup only on the command object itself), standard UTF-8/UTF-16 conversion (invalid input -> U+FFFD), edit-command parsing (same JSON contract and defaults), duplicate-safe verification `pie::verifyPageEdits`. Malformed batches return INVALID_EDITS_JSON instead of silently becoming a zero-command copy. Standalone test: `android/app/src/test/cpp/pie_bridge_core_test.cpp` (not part of the Gradle build).

\- JNI UTF-8 safety: all JNI string conversion goes through UTF-16 (`GetStringChars`/`NewString` via `jstringToUtf8`/`utf8ToJstring`); `GetStringUTFChars`/`NewStringUTF` (modified UTF-8) are no longer used. Bridge contract unchanged.

\- PDF reopen verification (native): every applied replace/insert is checked on the edited object itself (object path recorded after the edit, text compared exactly after trimming) plus exact occurrence counts of the requested/replaced text on the page; deletes are checked by exact counts (object count for text-less objects). Duplicate text cannot hide a failed edit or fail a correct one. Edits superseded within one batch are verified through the superseding command. commandResults gain an additive `verificationError` string. The single-object `replaceTextObject` native path uses the same verifier.

\- PDF reopen verification (editor): `PdfDocumentEditor` rejects apply and Save with `PdfReopenVerificationError` unless every applied edit is verified (per-command `verifiedInReopened`, aggregate flags for legacy-shaped results) and a non-empty batch reports its applied edits. Failed apply leaves the open document/history unchanged; failed Save keeps queued edits and the clean file (SAVE_FAILED). copyDocument() and applyBatchEdits([]) remain separate; source checksum check unchanged.

\- Durable PDF import: a picked PDF is copied to `documents/<docId>/source.pdf` (`ensureDurablePdfSource`) BEFORE it is opened and a library record is written at import time; a failed copy is a typed DocumentStorageError (no fallback to cache). Library documents already in storage open unchanged; without a native file store (iOS/Jest) the input path is used as before. `source.pdf` is never pruned (not a `rev_` file).

\- Import cache cleanup: native `purgeImportCache(keepPaths)` deletes only files in cacheDir/picked_pdfs and cacheDir/resolved_pdfs; called after a successful durable import and at app launch.

Known limitations (Phase 12): verification extracts text with PDFium; for nested Form XObject text the extraction is geometric (bounded text), so overlapping text can cause a verification FAILURE (safe direction: the edit is rejected, never falsely accepted). Unverified output files are left in place (session working dir / unreferenced rev_ file, removed by existing cleanup/pruning). PdfiumEngine.replaceTextObject (engine API, not used by the editor) nested path still reports `replacementFound` from the batch status.



\# Phase 13 Implementation Status

Phase 13 — PDF Output & File Management is IMPLEMENTED IN CODE.

NOT executed / NOT verified: automated tests (existing + new Phase 13 suites) NOT RUN, TypeScript/lint NOT RUN, Android build NOT RUN (new Kotlin saveCopyToUserLocation/sharePdf/purgeExportCache uncompiled), runtime/physical NOT VERIFIED.

Implemented:

\- Output rule (`src/features/pdf/pdfOutputService.ts`): Save As and Share expose ONLY the editor's clean file (`resolveVerifiedOutputPath`): not dirty, not SAVING/SAVE_FAILED, open file == clean file, and the file reopens with PDFium (page count + page sizes). Unsaved edits are first saved with the normal Phase 12-verified Save (silent variant `performSave(false)`); normal Save behaviour (alert, revision, record, pruning) is unchanged.

\- Save As: Android system ACTION_CREATE_DOCUMENT picker (`NativePdfiumModule.saveCopyToUserLocation`): user chooses name and destination; the verified app-private PDF is copied byte-for-byte, read back and compared (size + SHA-256); partial destinations are deleted on failure (`DocumentsContract.deleteDocument`). Cancel resolves null. Errors: PdfSaveAsError (write/verify), PdfOutputUnavailableError (no native picker, e.g. iOS). Never MediaStore; the source is only read.

\- Share: `NativePdfiumModule.sharePdf` copies the verified PDF to `cacheDir/pdf_exports/<ts>/<name>.pdf` and shares only a FileProvider content:// URI (existing `${applicationId}.provider`, read grant + ClipData). TS rejects any non-content:// result (PdfShareError). Share copies older than 1 hour are purged (on share, app launch, library delete).

\- Library delete (`src/features/pdf/pdfLibrary.ts`, Home long-press + confirmation, PDF records only): validates the id (assertSafeDocumentId), requires an existing PDF record with the same id, refuses while the document is in use (`src/features/documents/documentActivity.ts`: open/saving/exporting/closing marks from PdfEditorScreen) with DocumentBusyError, then deletes via the existing `IDocumentStorage.deleteDocument` (documents/<id> incl. source.pdf, rev_*.pdf, document.json, and sessions/<id>). Render/import/old share caches are purged only when no document is in use. The list updates immediately.

\- Password-protected PDFs: detected (native PDF_PASSWORD_REQUIRED -> PdfPasswordRequiredError; PDF_SECURITY_UNSUPPORTED -> new PdfSecurityUnsupportedError) and shown as a dedicated "Password-Protected PDF" / "Unsupported PDF Security" state; a failed import is discarded and never registered. No password prompt: the native batch/copy contract opens documents without a password, so encrypted PDFs could be opened but never edited or saved; encryption is never bypassed.

\- UI: PdfEditorScreen header gains one Export button (⤴) opening "Save As…" / "Share…" (disabled while saving/exporting; back blocked while exporting). Typed, user-facing error messages via describePdfOutputError / describePdfOpenError / describeLibraryDeleteError.

Known limitations (Phase 13): delete is offered for PDF records only (image records unchanged; image editor does not register document activity). Save As of a never-edited document exports the imported original bytes. Save As/Share need Android native; iOS reports PdfOutputUnavailableError.



\# Phase 14 Implementation Status

Phase 14 — Image Editor Completion is IMPLEMENTED IN CODE (canonical EditorScreen + Document/AddedTextElement + DocumentHistoryManager architecture; ImageEditingEngine still unused).

NOT executed / NOT verified: automated tests (existing + new Phase 14 suite) NOT RUN, TypeScript/lint NOT RUN, Android build NOT RUN (Kotlin multi-line export drawing uncompiled), runtime/physical NOT VERIFIED.

Implemented:

\- Shared text layout `src/features/text/textLayout.ts`: renderable font families (sans-serif / serif / monospace; aliases + deterministic fallback via resolveSystemFontFamily; iOS name mapping), deterministic width estimate (tests/fallback), multi-line layout (explicit newlines preserved, greedy whitespace wrapping with character breaking, line height default 1.25 em).

\- Measurement `src/features/image/textMeasurement.ts`: `defaultTextMeasurer` uses Skia `matchFont(...).getTextWidth` (the canvas's own fonts) in the app and the deterministic estimate in Jest. The same measurer builds the plan for the canvas and for export.

\- Render plan (`imageRenderPlan.ts`): every text layer now carries `lines` ({text, x, baselineY, width}), `alignment`, `lineHeight`; existing fields unchanged (drawX/baselineY = first line). Line breaking happens once in the plan; DocumentCanvas draws exactly these lines; the exporter sends them and `ImageProcessingModule.exportImagePage` draws them as-is (legacy single-line path kept when `lines` is absent). OCR replacement layers stay single fitted lines (unchanged behaviour).

\- Added-text layers (`src/features/image/addedTextLayers.ts`, pure/immutable): createAddedText (measured bounds, font family kept, wrapWidth = to the right image edge, origin clamped), updateAddedText (text/family/size/color/weight/style/alignment; origin and wrapWidth preserved), moveAddedText (document coordinates, clamped), deleteAddedText, collision-free ids. Each touches only its layer; OCR regions and originalContent are never modified; nothing is flattened into the source image. `AddedTextElement.wrapWidth?` added (optional, persisted as JSON).

\- EditorScreen: Add Text, Edit (context bar + TextEditModal prefilled from the layer, alignment control for added text, Delete in the modal), drag-to-move. Every operation is one `commitEdit` history step (undo/redo/dirty/persistence unchanged). OCR replace/delete still use the reconstruction pipeline (Phase 12 typed unavailability preserved). The modal now also prefills OCR edits from the selected region (UI only).

\- DocumentCanvas: drag of the SELECTED added-text layer only (one-finger pan starting on it, 12pt slop); delta = screen delta / zoom (document units), committed on release via onMoveAddedText; all other pans move the viewport; taps/OCR selection unchanged.

Known limitations (Phase 14): preview (Skia) and export (Android Canvas) share line breaks and positions, but glyph rasterization can differ slightly between the two renderers. Three font families only (no bundled fonts). Alignment is relative to the widest line, anchored at the layer's x. iOS native exporter (not compiled into the Xcode project) does not draw `lines`. No rotation/scale transform for added text (none exists in the model).



\# Phase 15 Implementation Status

Phase 15 — PDF Fidelity & Viewing is IMPLEMENTED IN CODE (PDFium remains the only PDF engine/renderer; no new persistence/history system).

NOT executed / NOT verified: automated tests (existing + new Phase 15 suites, C++ core test) NOT RUN, TypeScript/lint NOT RUN, Android build NOT RUN (C++ display-matrix/glyph/region-render code and Kotlin renderPageRegion/geometry uncompiled), runtime/physical NOT VERIFIED (rotated PDFs, CJK/subset fonts and zoom detail need device QA).

Implemented:

\- Rotation: the C++ bridge derives each page's user->display matrix from PDFium itself (FPDF_PageToDevice, i.e. the same transform FPDF_RenderPageBitmap uses: /Rotate + crop box). Extracted text bounds are display-space via that matrix (unrotated pages: identical to before). `nativeGetPageGeometry` -> getPageSize now also returns `rotation` and `displayMatrix`. TS `src/features/pdf/pdfPageGeometry.ts` (rotationDisplayMatrix fallback, user<->display points/rects, uprightTextMatrix, placeInsertedText) drives insertion/move of added text; unrotated pages keep the exact previous formulas. Native inserts use an upright text basis for the page rotation. Replace/delete address objects by path (unchanged).

\- Glyph safety: C++ `findMissingGlyphs` (FPDFFont_GetGlyphPath per new character; characters the object already renders are trusted; emoji/supplementary and control characters never pass) blocks Strategy-1 replacements in the original font; standard-14 font paths (inserts, font substitution) require WinAnsi coverage (`pie::isWinAnsiEncodable`). Failures are per-command `UNSUPPORTED_GLYPHS: ...` -> typed `PdfUnsupportedGlyphsError` (extends PdfFontLimitationError, code PDF_UNSUPPORTED_GLYPHS, lists the characters). TS pre-checks (`pdfGlyphCoverage.ts`): inserts must be WinAnsi; replacements reject emoji/control characters (CJK etc. are decided natively against the font). No font substitution is claimed as exact.

\- Zoom-aware rendering: base page render 2 px/pt capped by an 8 MP budget (`pdfRenderScale.ts`). After a pinch/pan ends (200 ms debounce, never per frame) PdfViewport reports zoom + visible rect; when the base render is too coarse, only the visible region (+25% margin) is rendered at a quantized scale (3/4/6/8/12 px/pt, 6 MP budget) via new native `renderPageRegion` (FPDF_RenderPageBitmapWithMatrix, same page transform) and drawn over the base render at its document rect. Native hard caps: 32 MP page, 16 MP region.

\- Render cache (`pdfRenderCache.ts`): keys = native doc handle + open file (new on every open/apply/undo/redo/save) + page + scale + region + render flags; LRU (16 entries, 48 MP); other revisions are dropped when a new revision is shown; files purged through the existing purgeRenderCache. Page cache entries carry their revision key.

\- Revision storage cap (PdfDocumentEditor): default 20 applied revisions / 512 MB of revision files (source and clean file excluded; sizes from openDocument fileSizeBytes). Oldest undo steps are dropped deterministically (newest always kept; `isHistoryTruncated()`), released files (`takeDiscardedRevisionFiles()`, incl. abandoned redo branches) exclude every protected path, and `deleteReleasedRevisionFiles` only deletes direct PDF children of sessions/<docId>/working.

Known limitations (Phase 15): FPDF_RenderPageBitmapWithMatrix bases its page transform on integer page sizes, so region renders of non-integer page sizes can be offset by a fraction of a point (verify on device). Glyph presence for embedded fonts is judged by FPDFFont_GetGlyphPath; PDFium-internal fallback fonts are not detectable through the public API. Inserted text remains limited to standard 14 fonts (WinAnsi). Thin/unusual whitespace without outlines may be refused (safe direction).

\# Fix Pass 16 — Image Manipulation, OCR Input, PDF Selection

AUTOMATED TESTED (TypeScript PASS, Jest 51/51 suites, 884/884 tests). Physical gesture/OCR/PDF-tap feel NOT VERIFIED.

\- Added image text: grab-to-select one-finger drag and two-finger pinch resize (centre anchor, font clamp 4..max(64, page short side)) via Skia Group live preview; one `manipulateAddedText` commit = one DocumentHistoryManager step. Canvas does not pan/zoom while a selected layer is manipulated. Pure math in `src/features/image/imageCanvasInteraction.ts`.

\- Tap/drag tolerances are screen points converted to document pixels by zoom (fixes untappable OCR regions/added text on high-resolution photos). TextEditModal sizes are in points x `documentPixelsPerPoint(fitScale)`.

\- OCR input: `planOcrInput` (downscale >16 MP, upscale small images up to 3x) + native `OcrModule.recognizeTextWithOptions` (EXIF upright decode, inSampleSize, alpha flatten, boxes mapped back); `alignRegionsToDocument` guarantees document coordinates. ML Kit Latin recognizer only (genuine limitation).

\- PDF hit test: containing objects first, else nearest within 20 screen points (`pdfTapToleranceDocPoints`); no longer prefers a smaller neighbour over the tapped line.



\# Version 1.0 — Product Completion (iOS-style UI, features, release, iOS native)

Status: Android IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 53/53 suites, 927/927 tests) + BUILT (assembleDebug, signed assembleRelease + bundleRelease). NOT runtime/physically verified. iOS native layer IMPLEMENTED IN CODE ONLY (cannot be built on Windows; user builds on a Mac).

\- UI system (src/ui): ThemeProvider (system/light/dark), Skia SF-style icons, iOS alerts/action sheets/prompts/toasts/HUD (OverlayHost; falls back to Alert in tests), NavBar/Toolbar/BottomSheet/ListRow/SegmentedControl/SearchField, ErrorBoundary, haptics. Settings persisted in filesDir/pie/settings.json (src/settings/appSettings.ts).

\- Screens: Library (Home: search, filter, sort, grid/list, thumbnails, rename/duplicate/share/info/delete for PDFs and images, Images to PDF, Merge PDFs, camera), Settings, first-launch Welcome. Home keeps the "Edit PDF" / "Edit Image" accessibility labels used by tests.

\- PDF: shared platform-neutral C++ (pie_pdf_ops.h: rotate/delete/move/insert blank/duplicate pages, ink/shape/highlight/underline/strike-out/JPEG image markup as page content, merge, images->PDF, search, page text). pdfium_bridge.cpp is now the platform-neutral engine (namespace pie_engine, pie_pdf_engine.h) + Android-only JNI wrappers. PdfDocumentEditor.applyDocumentOperations = one undoable 'pages'/'markup' revision. PdfViewport: select/draw/place modes, double-tap zoom, swipe pages, overlay slot. PDF editor UI: edit menu (Edit/Copy/Highlight/Underline/Strikethrough/Delete), Markup, Sign (saved signatures, signatures.json), Pages sheet, Find, Add Image, Copy Page Text.

\- Image: page.drawings (ImageDrawing, same path commands for Skia canvas and native export), markup + signatures, crop/rotate/flip (native transformImage -> new working asset; edits are flattened first with confirmation; undoable), Live-Text copy/share. Shared markup geometry: src/features/markup.

\- Release: app name PIE, generated icon (adaptive + iOS 1024), splash, INTERNET removed in release manifest, console.log disabled in release, version 1.0.0. Upload keystore android/app/pie-upload.keystore + android/keystore.properties (gitignored; must be backed up).

\- iOS: local pod PieNative (repo-root PieNative.podspec, ios/PieNative/*: PdfiumNativeModule.mm on the shared engine, ImageProcessingModule.m, OcrNativeModule.m (Vision), PieFileStoreModule.m, PieAppModule.m). PDFium binary via scripts/fetch-pdfium-ios.sh -> ios/PieNative/Vendor/pdfium.xcframework. Old unlinked Swift modules removed. Info.plist: name PIE, camera/photo usage strings. Parity test: every Android @ReactMethod exists on iOS.

Known limitations: ML Kit Latin-only OCR on Android; markup is written as page content (not editable PDF annotations); crop/rotate flattens image edits; iOS untested.

\# QA Pass 17 — Physical-QA Fixes (selection, edit panels, typography, OCR edit)

Status: IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 54/54 suites incl. new `__tests__/qaPass17SelectionAndEditing.test.tsx`). NOT built, NOT installed, NOT runtime/physically verified (Antigravity builds/installs; physical QA follows).

\- Root-cause bug fixed: image OCR regions could never stay selected (the canvas reported region + "null added text" per tap and the screen's null handler cleared the region in the same batch), so Edit/Copy/Delete never appeared. Canvas now emits one `onSelectionHit(hit, 'tap'|'drag')`; pure `resolveImageCanvasTap` (imageCanvasInteraction.ts) decides the selection; tapping the selected text again opens Edit. Post-detection coach mark "Tap highlighted text to edit it". OCR edits now apply the chosen font family (was ignored). Delete is also offered inside the Edit panel for OCR regions.

\- Typography tokens (src/constants/theme.ts): calibrated iOS-style scale (largeTitle 30, headline/nav 16, body 16/15, subhead 14, footnote 13, caption 12, caption2 11, sectionHeader 12), `fontWeights.semibold` = Roboto Medium (500) on Android (600 rendered as Bold), SF tracking only on iOS. Controls, overlays (action sheets 17pt/52pt rows, checkmark option state), Library, Settings, sheets, editors use the tokens.

\- NavBar/BarRow (src/ui/controls.tsx): content-sized side items with their own touch areas, non-interactive title layer placed by `navTitleInsets` (centred when room, otherwise between the items), one line + tail ellipsis. Editors use a chevron-only back button (`BackButton compact`). Sheet headers use the same BarRow.

\- PDF selection: hit test Tier 1 prefers the line whose centre is nearest the finger for partially overlapping neighbours (nested boxes keep smallest/deepest). `src/features/pdf/pdfTextSelection.ts`: tap = text object, tap again / "Select Line" = whole visual line (same baseline, word-sized gaps, never across table columns), one continuous band per line, reading-order copy text. Subtle tinted selection band (no border). No character handles (the object model cannot support them). Line delete = `PdfDocumentEditor.applyExistingTextDeletions` (one native batch, one undo step; applyRevision accepts a command list).

\- Shared EditMenu/HintPill (src/ui/EditMenu.tsx) for both editors: selected-text preview, Edit (primary), Copy, Select Line/Word, Highlight/Underline/Strikethrough (with colour dot), Colour, Delete.

\- Markup colour: `AppSettings.annotationColors {highlight, underline, strikeout}` (sanitized, persisted in settings.json), `PdfMarkupColorSheet` (style segments, live sample, swatches, "apply to selection"); clearly separate from text colour. Colour flows into the existing native `addHighlight` page-content operation (saved/reopened like other markup).

\- Edit Text panels: shared compact primitives `src/ui/formatControls.tsx` (EditorSheet content-sized with KeyboardAvoidingView padding, FormatGroup/FormatRow, ChoiceSegments, ToggleButton, SizeStepper + presets, ColorSwatches, FormatNote). PdfTextEditModal + TextEditModal rebuilt on them; same props and behaviour (font-lock rules, Add vs Done, alignment for added text, delete).

\- Export modal rebuilt on BottomSheet/ListSection; starts from the Settings default format/quality.

Known limitations / physical verification needed: keyboard behaviour of EditorSheet on Android edge-to-edge; selection feel and line grouping on real PDFs (thresholds 0.6 vertical overlap, 0.8 x line-height gap); underline is drawn at the bottom of the object box (descender line), not the baseline; nav title measuring shows the title after the first layout pass. (Legacy components and the root stale bundle were removed in the Android hardening pass.)



\# QA Pass 18 — PDF Add Text as Text Boxes, Markup Colours

Status: IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 55/55 suites, 976 tests incl. new `__tests__/qaPass18PdfTextBox.test.tsx`). NOT built (one small C++ change), NOT installed, NOT runtime/physically verified.

\- PDF Add Text now mirrors the image editor: tap Add Text -> tap location -> Edit Text panel (multi-line, alignment, family, bold/italic, size, colour) -> the text appears as a draft text box that can be dragged and pinch-resized (plus Edit Text / size -/+ toolbar) -> Done writes it. Pure model `src/features/pdf/pdfTextBox.ts` (standard-14 AFM widths, layout/alignment, draftForRect, clamp, baseline from text matrix). Written by `PdfDocumentEditor.applyTextBoxInsertion` (one native batch = one undo step; one standard-14 text object per line; reopen-verified).

\- Move / resize of existing text: "Move" in the edit menu for text PIE can re-insert losslessly (top-level, upright, non-embedded standard-14 font, WinAnsi). Done = delete + insert in the same verified batch (native verification counts compose; no native changes needed).

\- Bugs fixed: panel Serif/Mono were sent as "serif"/"monospace" and inserted as Helvetica (resolveStandardFontName now maps them); native resolveStandardFontNameCpp mapped "sans-serif" to Times (C++ fix in pdfium_bridge.cpp); every replacement sent isBold/isItalic, forcing font substitution even when the style was untouched (only changed style is sent now); size shown as the text-matrix-free Tf (e.g. "1 pt") — panel now shows the visible size and scales Tf on change; the panel re-initialised on parent re-renders (now only when it opens); unsupported characters (e.g. ₹) are flagged before Add.

\- Markup colours: Highlight / Underline / Strikethrough in the edit menu open an inline swatch row (EditMenu `colorChooser`); the pick is applied immediately and remembered per style (`annotationColors`). PdfMarkupColorSheet removed. Underline / strikethrough are placed from the text baseline when it is reliable (`markRectsForStyle`), otherwise the glyph box as before.

Physical verification needed: draft preview vs. PDFium rendering (RN system font preview approximates standard-14 fonts), drag/pinch feel, rotated pages, underline position on real PDFs.



\# Android Hardening Pass

Status: IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 56/56 suites, 991 tests incl. source-level `__tests__/androidHardening.test.ts`). C++ compile-checked with NDK 27 clang (arm64-v8a + armeabi-v7a, `-fsyntax-only -Wall`, no warnings); `FPDFPage_InsertObjectAtIndex` confirmed exported by all three bundled libpdfium.so. Kotlin NOT compiled (needs Gradle). NOT built/installed/runtime verified.

\- Memory: `ImageProcessingModule.canAllocateBitmaps` preflights import (rotation = 2 copies), export (full canvas) and crop/rotate against free memory (ActivityManager on Android 8+, where bitmaps are native; Java heap on 7) and rejects with a clear IMAGE_TOO_LARGE / EXPORT_TOO_LARGE message instead of risking an OOM kill. `android:largeHeap="true"`.

\- Crash-safe writes: PieFileStoreModule `moveIntoPlace` keeps the previous file as `.<name>.bak` until the new one is in place (never delete-then-rename); `recoverInterruptedReplace` restores it on read/exists. PDF `moveFile` cross-filesystem fallback copies to a synced sibling temp and renames (source deleted last).

\- PDF engine (pdfium_bridge.cpp, shared with iOS): font substitution swaps the new object into the original index (`replaceRootObjectInPlace`, keeps stacking order) and frees the detached original after the page's edits (batch) / immediately (single path; expected index unchanged); batch `FPDFPage_GenerateContent` failure now fails with GENERATE_CONTENT_FAILED; open errors captured in `thread_local t_lastOpenError` under the engine lock (password PDFs no longer misreported under concurrency).

\- Privacy/config: FileProvider limited to cacheDir `exports/` and `pdf_exports/`; `data_extraction_rules.xml` excludes everything from cloud backup and device transfer; release manifest removes INTERNET (verified in the previous merged release manifest), so the ML Kit transport cannot send anything; R8 keep rules added (R8 still off); iOS PDFium fetch pinned to chromium/8066 (same as Android).

\- Cleanup: removed root `assets/index.android.bundle` (stale, contained removed spike/Nutrient code; now git-ignored) and unused src/components Header/Button/Card/ImportModal.

Device checks: 20–50 MP photo import/export/rotate on a mid-range phone; Share from PDF and image editors and from Library (provider paths); edit text in a PDF whose text is under shapes/images.



\# Device QA Fix — Images to PDF

Status: IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 56/56 suites, 993 tests). Kotlin NOT compiled. Needs device re-test.

\- Bug (physical QA): "Images to PDF" failed for every photo with "The image could not be read"; PDF "Add Image" was broken the same way. `NativePdfiumModule.prepareJpeg` treated the bounds-only decode (`inJustDecodeBounds`, which always returns null by design) as a read failure via `?.use { decodeStream(...) } ?: throw`. Now only a missing stream or an image header without a size fails. Regression checks in `__tests__/androidHardening.test.ts` scan the Kotlin for the pattern; all other `?.use { } ?:` uses were reviewed (non-null block results).

\- Library: the third quick action is "Create PDF · From photos" (was the truncated "Images to PDF"); quick-action titles/captions shrink slightly instead of truncating at large font sizes; accessibility labels keep the full description; the "+" sheet entry is "Create PDF from Photos".



\# Texture-Preserving Background Reconstruction

Status: IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 57/57 suites, 1005 tests). Native ports VERIFIED BYTE-IDENTICAL to the reference off-device (`scripts/inpainting-parity/run-parity.sh`: TextInpainting.kt compiled with the cached Kotlin 2.2 compiler and run on the JVM; PieTextInpainting.h compiled to WebAssembly with NDK clang `-Wall -Wextra -Werror` and run in Node). ImageProcessingModule.kt/.m call sites NOT compiled (need Gradle / Xcode). NOT device verified.

\- Problem: OCR replace/delete repainted the WHOLE text box with a linear colour plane, smearing textured / photo backgrounds.

\- Algorithm (reference `src/features/image/textInpainting.ts`, tests `__tests__/textInpainting.test.ts` incl. golden SHA-256 of 5 parity cases): plane fit on the 4 px border ring -> adaptive threshold T = clamp(3 sigma, 20, 110) -> text mask (pixels farther than T from the plane) dilated by clamp(round(0.06 box height), 1, 4) -> only masked pixels filled outside-in (8-connected BFS layers, inverse-squared-distance average of known pixels in a 9x9 window). Background between/around letters is kept exactly. Fallback to the previous plane fill (2 px feather) when < 0.2% or > 60% of the target is flagged. Deterministic; computed confidence; result adds `method` ('inpaint' | 'plane') and `filledPixels`.

\- Ports: Android `image/TextInpainting.kt` (pure Kotlin; module reads the region with one `getPixels`), iOS `ios/PieNative/PieTextInpainting.h` (dependency-free C99). Old per-pixel plane code removed from both modules. Patch contract (opaque PNG at target bounds) unchanged: canvas, export, history and persistence untouched. If the algorithm changes, update all three and re-run the parity script (the golden hash test fails first).

\- Limits: strokes are filled by diffusion (very thick/large lettering on strong texture can look soft inside the stroke); text that crosses lines or edges inside the box is removed with them.



\# QA Pass 19 — Drive-style PDF Selection, Form Edits, Reflow, Haptics

Status: IMPLEMENTED + AUTOMATED TESTED (TypeScript PASS, Jest 58/58 suites, 1023 tests incl. `__tests__/qaPass19CharSelection.test.tsx`) + BUILT (signed assembleRelease) + INSTALLED on device d22f6e82 (launches, no crash). Native edits verified on device with a cross-compiled pie_cli harness on synthetic PDFs. Selection gestures / haptics feel NOT physically verified; the user's original failing PDF was not available.

- Form XObject edit bug ("Deleted text occurs 0 time(s) … expected N"): PDFium does not persist edits inside forms. `flattenRootForm` (pdfium_bridge.cpp) moves the form's children into page content with the form matrix (and clip) before editing; only text/path/image/form children are allowed, otherwise a clear error. Nested forms flatten level by level.
- Line reflow: replace/delete commands may carry `reflow: true` (pie_bridge_core.h). Following text on the same typeset line (baseline within 0.35 em, root-level, upright, stopping at gaps > 1 em) shifts by the width change; deletions close up. Not applied inside forms (they are flattened first).
- Character selection: native `getPageChars` (Android + iOS) -> `src/features/pdf/pdfCharSelection.ts` (lines, word at point, ranges, bands, handles, markup, `planRangeEdit`). PdfViewport: single tap only clears; long press selects a word; dragging a handle extends by character. Select Line / Select Word removed. Edit menu: Edit, Copy, Select All, Move (whole objects only), Highlight/Underline/Strikethrough, Delete. `PdfDocumentEditor.applyTextRangeEdit` = one native batch, one undo step. Partial-word edits change text only (format locked, explained in the panel); partial edits of objects whose characters do not match their text (ligatures) are refused. Falls back to object selection when no character data.
- Haptics: Android `PieAppModule.haptic` now uses the Vibrator (`VibrationEffect.createPredefined`, touch attributes) + VIBRATE permission; `performHapticFeedback` is only the fallback.

# Current Next Phase



\## Phase 16 — PENDING (not started; scope requires approval)

Remaining roadmap from the gap audit (separate phases, each needs explicit approval): Android production hardening (draft recovery, error boundary, logging, accessibility, release signing, INTERNET/FileProvider narrowing), iOS native parity (no PDF engine or PieFileStore on iOS yet), then the final integration/verification phase.

Before implementing: audit the affected areas, do not rewrite working systems.



\---



\# Final Product Goal



PIE should become a polished, production-ready offline-first PDF and Image Editor.



Prioritize:



\- reliability

\- correctness

\- native-feeling interaction

\- performance

\- source immutability

\- deterministic behavior

\- privacy

\- maintainable architecture



Do not add unrelated features.



Do not optimize for feature count.



Do not rewrite working code merely for stylistic preference.

