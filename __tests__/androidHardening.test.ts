/**
 * Android hardening pass — source-level regression checks for native / build configuration
 * that Jest cannot execute (Kotlin, C++, manifests). Behaviour still needs the device build.
 */
const fs: { readFileSync(f: string, e: 'utf8'): string; existsSync(f: string): boolean } = require('fs');
const path: { join(...p: string[]): string } = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const MAIN = 'android/app/src/main';
const KT = `${MAIN}/java/com/com.pdfimageeditor`;
const CPP = `${MAIN}/cpp/pdfium/pdfium_bridge.cpp`;

describe('Privacy and platform configuration', () => {
  it('FileProvider exposes only the share folders (never documents in filesDir)', () => {
    const xml = read(`${MAIN}/res/xml/file_paths.xml`);
    expect(xml).toContain('path="exports/"');
    expect(xml).toContain('path="pdf_exports/"');
    expect(xml).not.toMatch(/<files-path|<external-files-path|<external-cache-path|path="\."/);
  });

  it('share copies are created inside those folders', () => {
    expect(read(`${KT}/image/ImageProcessingModule.kt`)).toContain('File(reactContext.cacheDir, "exports")');
    expect(read(`${KT}/pdf/NativePdfiumModule.kt`)).toContain('EXPORT_DIR = "pdf_exports"');
  });

  it('documents are excluded from cloud backup and device transfer', () => {
    const manifest = read(`${MAIN}/AndroidManifest.xml`);
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const rules = read(`${MAIN}/res/xml/data_extraction_rules.xml`);
    for (const section of ['cloud-backup', 'device-transfer']) {
      const block = rules.split(`<${section}>`)[1].split(`</${section}>`)[0];
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
        expect(block).toContain(`<exclude domain="${domain}" path="." />`);
      }
    }
  });

  it('release builds have no network permission', () => {
    expect(read('android/app/src/release/AndroidManifest.xml')).toMatch(
      /android\.permission\.INTERNET"\s+tools:node="remove"/,
    );
  });

  it('R8 keep rules protect the JNI bridge and native modules', () => {
    const rules = read('android/app/proguard-rules.pro');
    expect(rules).toContain('native <methods>;');
    expect(rules).toContain('-keep class com.pdfimageeditor.pdf.NativePdfiumBridge { *; }');
    expect(rules).toContain('@com.facebook.react.bridge.ReactMethod <methods>;');
  });

  it('no stale JS bundle or legacy components remain', () => {
    expect(exists('assets/index.android.bundle')).toBe(false);
    for (const c of ['Header', 'Button', 'Card', 'ImportModal']) {
      expect(exists(`src/components/${c}.tsx`)).toBe(false);
    }
  });

  it('iOS fetches the same PDFium release as the Android binaries', () => {
    expect(read('scripts/fetch-pdfium-ios.sh')).toContain('TAG="${PDFIUM_TAG:-chromium/8066}"');
    expect(read('docs/pdfium_provenance.md')).toContain('chromium/8066');
  });
});

describe('Crash-safe file replacement', () => {
  it('the file store never deletes the previous version before the new one is in place', () => {
    const kt = read(`${KT}/storage/PieFileStoreModule.kt`);
    expect(kt).toContain('private fun moveIntoPlace(tmp: File, target: File)');
    expect(kt).toContain('private fun recoverInterruptedReplace(target: File)');
    // Old pattern: delete the target, then rename (a crash in between lost the file)
    expect(kt).not.toMatch(/target\.delete\(\)\s*\n\s*if \(!tmp\.renameTo\(target\)\)/);
    // Both writers use the safe replace; reads recover an interrupted one
    expect(kt.match(/moveIntoPlace\(tmp, target\)/g)).toHaveLength(2);
    expect(kt).toMatch(/fun readFile[\s\S]*?recoverInterruptedReplace\(file\)/);
  });

  it('moving a PDF across filesystems copies, syncs and renames (never a partial target)', () => {
    const kt = read(`${KT}/pdf/NativePdfiumModule.kt`);
    const move = kt.slice(kt.indexOf('fun moveFile('), kt.indexOf('fun moveFile(') + 2500);
    expect(move).toContain('output.fd.sync()');
    expect(move).not.toContain('source.copyTo(target, overwrite = true)');
  });
});

describe('Memory-safe image processing', () => {
  const kt = read(`${KT}/image/ImageProcessingModule.kt`);

  it('checks free memory before decoding full-resolution bitmaps', () => {
    expect(kt).toContain('private fun canAllocateBitmaps(bytes: Long): Boolean');
    // import (rotation needs two copies), export, transform
    expect((kt.match(/canAllocateBitmaps\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(kt).toMatch(/ActivityManager\.MemoryInfo\(\)/);
  });

  it('the app may use a larger heap on Android 7 (bitmaps on the Java heap)', () => {
    expect(read(`${MAIN}/AndroidManifest.xml`)).toContain('android:largeHeap="true"');
  });
});

describe('PDF native engine fixes', () => {
  const cpp = read(CPP);

  it('font substitution keeps the stacking order and frees the replaced object', () => {
    expect(cpp).toContain('bool replaceRootObjectInPlace(FPDF_PAGE page, FPDF_PAGEOBJECT oldObj, FPDF_PAGEOBJECT replacement)');
    expect(cpp).toContain('FPDFPage_InsertObjectAtIndex(page, replacement, static_cast<size_t>(index))');
    // The old remove + append pattern is gone
    expect(cpp).not.toMatch(/FPDFPage_RemoveObject\(page, targetObj\);\s*\n\s*FPDFPage_InsertObject\(page, newTextObj\);/);
    expect(cpp).toContain('for (FPDF_PAGEOBJECT o : detachedObjects) FPDFPageObj_Destroy(o);');
  });

  it('a failed page content rebuild fails the batch', () => {
    expect(cpp).toMatch(/if \(!FPDFPage_GenerateContent\(page\)\) \{[\s\S]{0,300}GENERATE_CONTENT_FAILED/);
    expect(cpp).not.toMatch(/^\s*FPDFPage_GenerateContent\(page\);\s*$/m);
  });

  it('the open error is captured per thread while the engine lock is held', () => {
    expect(cpp).toContain('thread_local unsigned long t_lastOpenError');
    expect(cpp).toMatch(/int lastError\(\) \{\s*return static_cast<int>\(t_lastOpenError\);/);
  });

  it('"sans-serif" never resolves to Times', () => {
    expect(cpp).toContain('const bool sans = fam.find("sans") != std::string::npos;');
  });
});

describe('Image decoding (Images to PDF / Add Image regression)', () => {
  const ktFiles = [
    `${KT}/pdf/NativePdfiumModule.kt`,
    `${KT}/image/ImageProcessingModule.kt`,
    `${KT}/ocr/OcrModule.kt`,
  ];

  it('a bounds-only decode is never treated as a failure (it always returns null by design)', () => {
    for (const f of ktFiles) {
      const src = read(f);
      // `?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: throw` threw for every image
      expect(src).not.toMatch(/decodeStream\([^)]*bounds\)\s*\}\s*\?:\s*throw/);
    }
  });

  it('prepareJpeg only fails when the stream is missing or the header has no size', () => {
    const kt = read(`${KT}/pdf/NativePdfiumModule.kt`);
    const fn = kt.slice(kt.indexOf('private fun prepareJpeg('), kt.indexOf('private fun prepareJpeg(') + 900);
    expect(fn).toContain('val boundsStream = resolver.openInputStream(uri) ?: throw');
    expect(fn).toContain('if (bounds.outWidth <= 0 || bounds.outHeight <= 0)');
  });
});

describe('Texture-preserving background reconstruction is wired natively', () => {
  it('Android reconstructs through TextInpainting (port of textInpainting.ts)', () => {
    const kt = read(`${KT}/image/ImageProcessingModule.kt`);
    expect(kt).toContain('TextInpainting.reconstruct(');
    expect(kt).toContain('bitmap.getPixels(regionPixels');
    expect(kt).not.toContain('fun fitPlane(');
    expect(exists(`${KT}/image/TextInpainting.kt`)).toBe(true);
  });

  it('iOS reconstructs through PieTextInpainting.h (same algorithm)', () => {
    const m = read('ios/PieNative/ImageProcessingModule.m');
    expect(m).toContain('#import "PieTextInpainting.h"');
    expect(m).toContain('PieReconstructTextPatch(');
    expect(m).not.toContain('PieFitPlane(');
  });

  it('the parity script compares both ports with the reference', () => {
    const sh = read('scripts/inpainting-parity/run-parity.sh');
    expect(sh).toContain('TextInpainting.kt');
    expect(sh).toContain('harness.c');
    expect(read('scripts/inpainting-parity/harness.c')).toContain('PieTextInpainting.h');
  });
});

export {};
