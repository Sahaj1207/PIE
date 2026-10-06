/**
 * Phase 12 — build/runtime integrity assumptions (static checks on the source tree).
 *
 * These guard against stale artifacts silently overriding current code:
 * - a checked-in JS bundle shadowing the current JS,
 * - prebuilt bridge binaries shadowing the CMake-built pdfium_bridge,
 * - JNI "modified UTF-8" string conversion corrupting non-BMP text,
 * - the old hand-written JSON field scanning and substring reopen verification.
 */
// Node built-ins (Jest runs on Node), typed locally: the React Native tsconfig loads only
// jest types, so Node module declarations are not guaranteed for `tsc`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs: { readFileSync(file: string, encoding: 'utf8'): string; existsSync(file: string): boolean } = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path: { join(...parts: string[]): string } = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const BRIDGE = 'android/app/src/main/cpp/pdfium/pdfium_bridge.cpp';
const CORE = 'android/app/src/main/cpp/pdfium/pie_bridge_core.h';
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];

/** Source without // line comments (so explanatory comments do not count as usages). */
function codeOnly(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('Phase 12 — stale JS bundle', () => {
  it('no checked-in index.android.bundle can override the current JS', () => {
    expect(exists('android/app/src/main/assets/index.android.bundle')).toBe(false);
    expect(exists('android/app/src/main/assets/index.android.bundle.map')).toBe(false);
  });

  it('the generated bundle path is git-ignored', () => {
    const gitignore = read('.gitignore');
    expect(gitignore).toContain('android/app/src/main/assets/index.android.bundle');
  });

  it('keeps the standard React Native Gradle bundling flow (no custom bundle configuration)', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('apply plugin: "com.facebook.react"');
    expect(gradle).not.toMatch(/^\s*bundleAssetName\s*=/m);
    expect(gradle).not.toMatch(/^\s*debuggableVariants\s*=/m);
  });

  it('keeps the PDF assets used at runtime', () => {
    expect(exists('android/app/src/main/assets/pdfium_spike_sample.pdf')).toBe(true);
  });
});

describe('Phase 12 — native PDF bridge build inputs', () => {
  it('ships prebuilt libpdfium.so but no prebuilt libpdfium_bridge.so for every ABI', () => {
    for (const abi of ABIS) {
      expect(exists(`android/app/src/main/jniLibs/${abi}/libpdfium.so`)).toBe(true);
      expect(exists(`android/app/src/main/jniLibs/${abi}/libpdfium_bridge.so`)).toBe(false);
    }
  });

  it('builds pdfium_bridge from source via CMake', () => {
    const cmake = read('android/app/src/main/cpp/CMakeLists.txt');
    expect(cmake).toMatch(/add_library\(pdfium_bridge SHARED\s+pdfium\/pdfium_bridge\.cpp/);
  });

  it('the PdfSpike module stays removed; PdfiumNativeModule exposes the cache purge', () => {
    expect(read('android/app/src/main/java/com/com.pdfimageeditor/MainApplication.kt')).not.toContain('PdfSpike');
    const module = read('android/app/src/main/java/com/com.pdfimageeditor/pdf/NativePdfiumModule.kt');
    expect(module).toContain('fun purgeImportCache(');
    expect(module).toContain('"picked_pdfs"');
    expect(module).toContain('"resolved_pdfs"');
  });
});

describe('Phase 12 — JNI UTF-8 safety', () => {
  const bridge = codeOnly(read(BRIDGE));

  it('never converts strings with modified-UTF-8 JNI calls', () => {
    expect(bridge).not.toContain('GetStringUTFChars');
    expect(bridge).not.toContain('ReleaseStringUTFChars');
    expect(bridge).not.toContain('NewStringUTF(');
  });

  it('converts JNI strings through UTF-16 (GetStringChars / NewString)', () => {
    expect(bridge).toContain('env->GetStringChars(');
    expect(bridge).toContain('env->NewString(');
    expect(bridge).toMatch(/jstringToUtf8\(env, jEditsJson\)/);
    expect(bridge).toMatch(/jstringToUtf8\(env, jFilePath\)/);
  });
});

describe('Phase 12 — JSON parsing and reopen verification in the bridge', () => {
  const bridge = codeOnly(read(BRIDGE));
  const core = read(CORE);

  it('the shared core is pure C++ (testable without JNI / PDFium)', () => {
    expect(core).not.toMatch(/#include\s*[<"]jni\.h[>"]/);
    expect(core).not.toMatch(/#include\s*[<"]fpdf/);
    expect(read(BRIDGE)).toContain('#include "pie_bridge_core.h"');
    expect(exists('android/app/src/test/cpp/pie_bridge_core_test.cpp')).toBe(true);
  });

  it('parses edit batches with the strict JSON parser and rejects malformed batches', () => {
    expect(bridge).toContain('pie::parseEditCommands(editsJson, commands, parseError)');
    expect(bridge).toContain('INVALID_EDITS_JSON');
    expect(bridge).not.toContain('extractJsonStringField');
    // String escapes and \u surrogate pairs are decoded by the parser
    expect(core).toContain("case 'n': out.push_back('\\n')");
    expect(core).toContain("case 'u':");
    expect(core).toContain('0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00))');
  });

  it('no longer verifies edits with page-wide substring / equality scans', () => {
    expect(bridge).not.toMatch(/t\.find\(results\[ci\]\.newText\)/);
    expect(bridge).not.toMatch(/t == results\[ci\]\.originalText/);
    expect(bridge).not.toMatch(/txt\.find\(replacementText\)/);
  });

  it('verifies the edited object itself plus duplicate-safe occurrence counts', () => {
    expect(bridge).toContain('pie::verifyPageEdits(beforeTextsByPage[pageIndex], afterTexts, inputs)');
    expect(bridge).toContain('locateObjectPath(page, results[ci].resultObject, results[ci].expectedPath)');
    expect(bridge).toContain('extractTextAtPath(newPage, newTextPage, r.expectedPath, inputs[k].objectText)');
    expect(bridge).toContain('"verificationError');
    expect(core).toContain('inline void verifyPageEdits(');
  });
});
