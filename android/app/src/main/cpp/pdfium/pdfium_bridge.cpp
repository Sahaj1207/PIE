// PIE PDFium bridge.
//
// Platform-neutral engine (namespace pie_engine, see pie_pdf_engine.h) used by Android (JNI
// wrappers at the end of this file) and iOS (PieNative Objective-C++ module). All PDF logic
// lives here once; only the JNI plumbing is Android-specific.
#if defined(__ANDROID__)
#include <jni.h>
#include <android/log.h>
#include <android/bitmap.h>
#endif
#include <string>
#include <vector>
#include <unordered_map>
#include <map>
#include <mutex>
#include <sstream>
#include <iomanip>
#include <cmath>
#include <algorithm>
#include <functional>

#include "fpdfview.h"
#include "fpdf_doc.h"
#include "fpdf_text.h"
#include "fpdf_edit.h"
#include "fpdf_save.h"
#include "fpdf_transformpage.h"

#include "pie_bridge_core.h"
#include "pie_pdf_ops.h"
#include "pie_pdf_engine.h"

#define TAG "PdfiumBridge"
#if defined(__ANDROID__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#else
#include <cstdio>
#define LOGI(...) ((void)0)
#define LOGE(...) ((void)fprintf(stderr, __VA_ARGS__), (void)fprintf(stderr, "\n"))
#endif

namespace {

struct CustomFileWriter : public FPDF_FILEWRITE {
    FILE* file = nullptr;
    CustomFileWriter(FILE* f) {
        version = 1;
        file = f;
        WriteBlock = &WriteBlockCallback;
    }
    static int WriteBlockCallback(FPDF_FILEWRITE* self, const void* data, unsigned long size) {
        auto* writer = static_cast<CustomFileWriter*>(self);
        if (!writer->file) return 0;
        size_t written = fwrite(data, 1, size, writer->file);
        return (written == size) ? 1 : 0;
    }
};

std::string computeFileChecksum(const std::string& filePath) {
    FILE* fp = fopen(filePath.c_str(), "rb");
    if (!fp) return "";
    uint64_t hash = 14695981039346656037ULL;
    unsigned char buffer[4096];
    size_t bytesRead;
    while ((bytesRead = fread(buffer, 1, sizeof(buffer), fp)) > 0) {
        for (size_t i = 0; i < bytesRead; ++i) {
            hash ^= buffer[i];
            hash *= 1099511628211ULL;
        }
    }
    fclose(fp);
    std::ostringstream ss;
    ss << std::hex << std::setw(16) << std::setfill('0') << hash;
    return ss.str();
}

std::mutex g_mutex;
bool g_libraryInitialized = false;
int64_t g_nextDocHandle = 1;
std::unordered_map<int64_t, FPDF_DOCUMENT> g_documents;

void ensureLibraryInitialized() {
    if (!g_libraryInitialized) {
        FPDF_LIBRARY_CONFIG config;
        config.version = 2;
        config.m_pUserFontPaths = nullptr;
        config.m_pIsolate = nullptr;
        config.m_v8EmbedderSlot = 0;
        FPDF_InitLibraryWithConfig(&config);
        g_libraryInitialized = true;
        LOGI("PDFium library initialized successfully");
    }
}

// UTF-16 (PDFium FPDF_WCHAR) -> standard UTF-8. Delegates to pie_bridge_core.h.
std::string utf16ToUtf8(const unsigned short* wstr, size_t length) {
    return pie::utf16ToUtf8(reinterpret_cast<const uint16_t*>(wstr), length, true);
}

using pie::escapeJsonString;

// Standard UTF-8 -> NUL-terminated UTF-16 for PDFium FPDF_WIDESTRING arguments.
std::vector<FPDF_WCHAR> utf8ToUtf16(const std::string& utf8) {
    const std::vector<uint16_t> units = pie::utf8ToUtf16(utf8);
    std::vector<FPDF_WCHAR> out(units.begin(), units.end());
    out.push_back(0);
    return out;
}

#if defined(__ANDROID__)
// JNI strings are converted through UTF-16 (GetStringChars / NewString). The JNI
// GetStringUTFChars / NewStringUTF pair uses "modified UTF-8", which encodes non-BMP
// characters (emoji, some CJK) as surrogate halves and makes NewStringUTF reject or garble
// standard 4-byte UTF-8 -- that silently corrupted text and could abort under CheckJNI.
std::string jstringToUtf8(JNIEnv* env, jstring value) {
    if (!value) return std::string();
    const jsize length = env->GetStringLength(value);
    const jchar* chars = env->GetStringChars(value, nullptr);
    if (!chars) return std::string();
    std::string out = pie::utf16ToUtf8(reinterpret_cast<const uint16_t*>(chars), static_cast<size_t>(length), false);
    env->ReleaseStringChars(value, chars);
    return out;
}

jstring utf8ToJstring(JNIEnv* env, const std::string& utf8) {
    const std::vector<uint16_t> units = pie::utf8ToUtf16(utf8);
    static const jchar kEmpty = 0;
    return env->NewString(units.empty() ? &kEmpty : reinterpret_cast<const jchar*>(units.data()),
                          static_cast<jsize>(units.size()));
}

#endif

bool isSubsetFont(const std::string& baseFontName) {
    if (baseFontName.length() < 8 || baseFontName[6] != '+') return false;
    for (int i = 0; i < 6; ++i) {
        if (baseFontName[i] < 'A' || baseFontName[i] > 'Z') return false;
    }
    return true;
}

std::string resolveStandardFontNameCpp(const std::string& family, bool isBold, bool isItalic) {
    std::string fam = family;
    std::transform(fam.begin(), fam.end(), fam.begin(), ::tolower);
    // "sans-serif" contains "serif": it is Helvetica, never Times
    const bool sans = fam.find("sans") != std::string::npos;
    if (fam.find("times") != std::string::npos || (!sans && fam.find("serif") != std::string::npos)) {
        if (isBold && isItalic) return "Times-BoldItalic";
        if (isBold) return "Times-Bold";
        if (isItalic) return "Times-Italic";
        return "Times-Roman";
    }
    if (fam.find("courier") != std::string::npos || fam.find("mono") != std::string::npos) {
        if (isBold && isItalic) return "Courier-BoldOblique";
        if (isBold) return "Courier-Bold";
        if (isItalic) return "Courier-Oblique";
        return "Courier";
    }
    if (isBold && isItalic) return "Helvetica-BoldOblique";
    if (isBold) return "Helvetica-Bold";
    if (isItalic) return "Helvetica-Oblique";
    return "Helvetica";
}

using pie::EditCommand;

// Swaps a root-level page object for `replacement` at the same position in the page's object
// list, so the new text keeps the original stacking order (it is not drawn over shapes or
// images that covered the original). On failure the page is left unchanged and false is
// returned; the caller still owns `replacement`. On success the caller owns `oldObj` (now
// detached from the page) and must destroy it once nothing refers to it.
bool replaceRootObjectInPlace(FPDF_PAGE page, FPDF_PAGEOBJECT oldObj, FPDF_PAGEOBJECT replacement) {
    const int count = FPDFPage_CountObjects(page);
    int index = -1;
    for (int i = 0; i < count; ++i) {
        if (FPDFPage_GetObject(page, i) == oldObj) {
            index = i;
            break;
        }
    }
    if (index < 0 || !FPDFPage_RemoveObject(page, oldObj)) return false;
    if (FPDFPage_InsertObjectAtIndex(page, replacement, static_cast<size_t>(index))) return true;
    // Restore the original at its position (or at the end if that fails too)
    if (!FPDFPage_InsertObjectAtIndex(page, oldObj, static_cast<size_t>(index))) {
        FPDFPage_InsertObject(page, oldObj);
    }
    return false;
}

FS_MATRIX identityMatrix() {
    return FS_MATRIX{1, 0, 0, 1, 0, 0};
}

// Returns outer * inner for PDF's affine matrix representation.
FS_MATRIX composeMatrix(const FS_MATRIX& outer, const FS_MATRIX& inner) {
    return FS_MATRIX{
        outer.a * inner.a + outer.c * inner.b,
        outer.b * inner.a + outer.d * inner.b,
        outer.a * inner.c + outer.c * inner.d,
        outer.b * inner.c + outer.d * inner.d,
        outer.a * inner.e + outer.c * inner.f + outer.e,
        outer.b * inner.e + outer.d * inner.f + outer.f,
    };
}

void transformPoint(const FS_MATRIX& matrix, float x, float y, float& outX, float& outY) {
    outX = matrix.a * x + matrix.c * y + matrix.e;
    outY = matrix.b * x + matrix.d * y + matrix.f;
}

void transformBounds(const FS_MATRIX& matrix, float left, float bottom, float right, float top,
                     float& outLeft, float& outBottom, float& outRight, float& outTop) {
    float xs[4];
    float ys[4];
    transformPoint(matrix, left, bottom, xs[0], ys[0]);
    transformPoint(matrix, left, top, xs[1], ys[1]);
    transformPoint(matrix, right, bottom, xs[2], ys[2]);
    transformPoint(matrix, right, top, xs[3], ys[3]);
    outLeft = *std::min_element(xs, xs + 4);
    outRight = *std::max_element(xs, xs + 4);
    outBottom = *std::min_element(ys, ys + 4);
    outTop = *std::max_element(ys, ys + 4);
}

std::string objectPathId(int pageIndex, const std::vector<int>& path) {
    std::ostringstream ss;
    ss << "p" << pageIndex << "_path";
    for (size_t i = 0; i < path.size(); ++i) {
        if (i > 0) ss << "_";
        ss << path[i];
    }
    return ss.str();
}

// Edit batches are parsed by pie::parseEditCommands (strict JSON including all string escapes and
// UTF-16 surrogate-pair escapes), see pie_bridge_core.h.

std::string extractTextObjectText(
    FPDF_PAGEOBJECT object,
    FPDF_TEXTPAGE textPage,
    float pageLeft = 0.0f,
    float pageBottom = 0.0f,
    float pageRight = 0.0f,
    float pageTop = 0.0f) {
    if (!textPage) return "";
    unsigned long reqBytes = FPDFTextObj_GetText(object, textPage, nullptr, 0);
    if (reqBytes > 0) {
        std::vector<FPDF_WCHAR> wbuf(reqBytes / sizeof(FPDF_WCHAR) + 1, 0);
        const unsigned long readBytes = FPDFTextObj_GetText(object, textPage, wbuf.data(), reqBytes);
        if (readBytes > 0) {
            std::string text = utf16ToUtf8(wbuf.data(), readBytes / sizeof(FPDF_WCHAR));
            if (!text.empty()) return text;
        }
    }

    const int charCount = FPDFText_CountChars(textPage);
    std::vector<FPDF_WCHAR> matchedChars;
    for (int c = 0; c < charCount; ++c) {
        if (FPDFText_GetTextObject(textPage, c) == object) {
            const unsigned int unicode = FPDFText_GetUnicode(textPage, c);
            if (unicode > 0) matchedChars.push_back(static_cast<FPDF_WCHAR>(unicode));
        }
    }
    if (!matchedChars.empty()) {
        std::string text = utf16ToUtf8(matchedChars.data(), matchedChars.size());
        if (!text.empty()) return text;
    }

    // Fallback for nested Form XObjects:
    // When text is encapsulated in a Form XObject, root FPDFTextObj_GetText and
    // char-object matching return empty because the root text page does not map the internal
    // text object directly. However, the root text page contains the flattened text
    // at the transformed document coordinates.
    if (std::abs(pageRight - pageLeft) > 0.001f && std::abs(pageTop - pageBottom) > 0.001f) {
        const double bLeft = std::min(pageLeft, pageRight) - 0.5;
        const double bRight = std::max(pageLeft, pageRight) + 0.5;
        const double bBottom = std::min(pageBottom, pageTop) - 0.5;
        const double bTop = std::max(pageBottom, pageTop) + 0.5;

        const int boundedCount = FPDFText_GetBoundedText(textPage, bLeft, bTop, bRight, bBottom, nullptr, 0);
        if (boundedCount > 0) {
            std::vector<FPDF_WCHAR> bBuf(boundedCount + 1, 0);
            const int read = FPDFText_GetBoundedText(textPage, bLeft, bTop, bRight, bBottom, bBuf.data(), boundedCount + 1);
            if (read > 0) {
                std::string boundedText = utf16ToUtf8(bBuf.data(), read);
                while (!boundedText.empty() && (static_cast<unsigned char>(boundedText.back()) <= 32 || boundedText.back() == 0)) {
                    boundedText.pop_back();
                }
                if (!boundedText.empty()) return boundedText;
            }
        }
    }

    return "";
}

// Page user space -> display space (points, top-left origin, Y down) exactly as PDFium renders
// the page (FPDF_RenderPageBitmap with rotate 0 applies the page's /Rotate and crop box).
// Derived from FPDF_PageToDevice at a fine device resolution so rotation and box offsets come
// from PDFium itself rather than hand-written math. u = a*x + c*y + e, v = b*x + d*y + f.
// Display-matrix helpers are shared with the platform-neutral document operations.
using pie_pdf::displayMatrixFallback;
using pie_pdf::computeDisplayMatrix;
using pie_pdf::pageDisplayMatrix;

// Text object matrix (rotation part) that makes text read upright, left-to-right in the
// DISPLAYED page: baseline along display +u, glyph "up" along display -v.
void uprightTextBasis(const FS_MATRIX& display, float& ta, float& tb, float& tc, float& td) {
    const double det = static_cast<double>(display.a) * display.d - static_cast<double>(display.b) * display.c;
    if (std::abs(det) < 1e-9) {
        ta = 1; tb = 0; tc = 0; td = 1;
        return;
    }
    // inverse of [[a c],[b d]] = (1/det) [[d -c],[-b a]]
    ta = static_cast<float>(display.d / det);   // inv * (1, 0)
    tb = static_cast<float>(-display.b / det);
    tc = static_cast<float>(display.c / det);   // inv * (0, -1)
    td = static_cast<float>(-display.a / det);
}

// Code points of `newText` the font cannot draw with its own glyphs. Characters already
// present in `existingText` (currently rendered by this object) are trusted; spaces are
// skipped; supplementary-plane characters (emoji etc.) and control characters never pass.
std::vector<uint32_t> findMissingGlyphs(FPDF_FONT font, const std::string& newText, const std::string& existingText) {
    std::vector<uint32_t> missing;
    const std::vector<uint32_t> existing = pie::decodeCodePoints(existingText);
    for (uint32_t cp : pie::decodeCodePoints(newText)) {
        bool known = false;
        for (uint32_t m : missing) if (m == cp) { known = true; break; }
        if (known) continue;
        if (cp == 0x20 || cp == 0xA0) continue;
        if (cp > 0xFFFF || cp < 0x20 || cp == 0xFFFD) {
            missing.push_back(cp);
            continue;
        }
        bool present = false;
        for (uint32_t e : existing) if (e == cp) { present = true; break; }
        if (present) continue;
        FPDF_GLYPHPATH glyph = font ? FPDFFont_GetGlyphPath(font, cp, 12.0f) : nullptr;
        if (!glyph || FPDFGlyphPath_CountGlyphSegments(glyph) <= 0) {
            missing.push_back(cp);
        }
    }
    return missing;
}

std::string unsupportedGlyphsMessage(const std::vector<uint32_t>& missing, const std::string& what) {
    return std::string(pie::kUnsupportedGlyphsPrefix) + what + " cannot display " +
           pie::describeCodePoints(missing) + ". The text was not changed.";
}

void appendTextObjectJson(
    std::ostringstream& ss,
    bool& first,
    FPDF_PAGEOBJECT object,
    int pageIndex,
    const FS_MATRIX& displayMatrix,
    FPDF_TEXTPAGE textPage,
    const std::vector<int>& path,
    const FS_MATRIX& parentMatrix) {
    float left = 0, bottom = 0, right = 0, top = 0;
    if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) return;

    // Bounds are expressed in the containing Form's space. Apply only the
    // accumulated parent Form matrix; GetBounds already includes the text's
    // own local transform.
    float pageLeft = 0, pageBottom = 0, pageRight = 0, pageTop = 0;
    transformBounds(parentMatrix, left, bottom, right, top, pageLeft, pageBottom, pageRight, pageTop);

    FS_MATRIX localMatrix = identityMatrix();
    const bool hasMatrix = FPDFPageObj_GetMatrix(object, &localMatrix);
    const FS_MATRIX pageMatrix = hasMatrix ? composeMatrix(parentMatrix, localMatrix) : parentMatrix;

    float fontSize = 0.0f;
    const bool hasFontSize = FPDFTextObj_GetFontSize(object, &fontSize);
    std::string fontName;
    std::string familyName;
    int isEmbedded = -1;
    int fontWeight = -1;
    int fontFlags = -1;
    bool hasFont = false;
    FPDF_FONT font = FPDFTextObj_GetFont(object);
    if (font) {
        const size_t fnLen = FPDFFont_GetBaseFontName(font, nullptr, 0);
        if (fnLen > 0) {
            std::vector<char> fnBuf(fnLen + 1, 0);
            FPDFFont_GetBaseFontName(font, fnBuf.data(), fnLen);
            fontName = fnBuf.data();
            hasFont = !fontName.empty();
        }
        const size_t famLen = FPDFFont_GetFamilyName(font, nullptr, 0);
        if (famLen > 0) {
            std::vector<char> famBuf(famLen + 1, 0);
            FPDFFont_GetFamilyName(font, famBuf.data(), famLen);
            familyName = famBuf.data();
        }
        isEmbedded = FPDFFont_GetIsEmbedded(font);
        fontWeight = FPDFFont_GetWeight(font);
        fontFlags = FPDFFont_GetFlags(font);
    }

    unsigned int r = 0, g = 0, b = 0, a = 255;
    const bool hasColor = FPDFPageObj_GetFillColor(object, &r, &g, &b, &a);
    const std::string textUtf8 = extractTextObjectText(object, textPage, pageLeft, pageBottom, pageRight, pageTop);

    if (!first) ss << ",";
    first = false;
    ss << "{";
    ss << "\"id\":\"" << objectPathId(pageIndex, path) << "\",";
    ss << "\"pageIndex\":" << pageIndex << ",";
    ss << "\"objectIndex\":" << path.back() << ",";
    ss << "\"objectPath\":[";
    for (size_t i = 0; i < path.size(); ++i) {
        if (i > 0) ss << ",";
        ss << path[i];
    }
    ss << "],";
    ss << "\"text\":\"" << escapeJsonString(textUtf8) << "\",";
    // Display-space bounds (what is rendered): rotation and crop-box origin applied.
    float dispLeft = 0, dispTop = 0, dispRight = 0, dispBottom = 0;
    transformBounds(displayMatrix, pageLeft, pageBottom, pageRight, pageTop, dispLeft, dispTop, dispRight, dispBottom);
    ss << "\"bounds\":{\"x\":" << dispLeft << ",\"y\":" << dispTop
       << ",\"width\":" << std::abs(dispRight - dispLeft) << ",\"height\":" << std::abs(dispBottom - dispTop) << "},";
    ss << "\"pdfBounds\":{\"left\":" << pageLeft << ",\"bottom\":" << pageBottom
       << ",\"right\":" << pageRight << ",\"top\":" << pageTop << "},";
    ss << "\"fontSize\":" << ((hasFontSize && fontSize > 0) ? std::to_string(fontSize) : "null") << ",";
    ss << "\"isEditable\":true,";
    if (hasFont) {
        ss << "\"fontName\":\"" << escapeJsonString(fontName) << "\",";
        ss << "\"fontDetails\":{\"baseFontName\":\"" << escapeJsonString(fontName)
           << "\",\"familyName\":\"" << escapeJsonString(familyName)
           << "\",\"isEmbedded\":" << (isEmbedded == 1 ? "true" : "false")
           << ",\"isSubset\":" << (isSubsetFont(fontName) ? "true" : "false")
           << ",\"weight\":" << (fontWeight >= 0 ? std::to_string(fontWeight) : "null")
           << ",\"flags\":" << (fontFlags >= 0 ? std::to_string(fontFlags) : "null") << "},";
    } else {
        ss << "\"fontName\":null,\"fontDetails\":null,";
    }
    if (hasColor) {
        char colorBuf[16];
        snprintf(colorBuf, sizeof(colorBuf), "#%02X%02X%02X", r, g, b);
        ss << "\"color\":\"" << colorBuf << "\",\"colorRgba\":{\"r\":" << r
           << ",\"g\":" << g << ",\"b\":" << b << ",\"a\":" << a << "},";
    } else {
        ss << "\"color\":null,\"colorRgba\":null,";
    }
    ss << "\"matrix\":{\"a\":" << pageMatrix.a << ",\"b\":" << pageMatrix.b
       << ",\"c\":" << pageMatrix.c << ",\"d\":" << pageMatrix.d
       << ",\"e\":" << pageMatrix.e << ",\"f\":" << pageMatrix.f << "}";
    ss << "}";
}

void traverseTextObjects(
    FPDF_PAGEOBJECT object,
    int pageIndex,
    const FS_MATRIX& displayMatrix,
    FPDF_TEXTPAGE textPage,
    const std::vector<int>& path,
    const FS_MATRIX& parentMatrix,
    std::ostringstream& ss,
    bool& first) {
    if (!object) return;
    const int type = FPDFPageObj_GetType(object);
    if (type == FPDF_PAGEOBJ_TEXT) {
        appendTextObjectJson(ss, first, object, pageIndex, displayMatrix, textPage, path, parentMatrix);
        return;
    }
    if (type != FPDF_PAGEOBJ_FORM) return;

    FS_MATRIX formMatrix = identityMatrix();
    const FS_MATRIX childParentMatrix = FPDFPageObj_GetMatrix(object, &formMatrix)
        ? composeMatrix(parentMatrix, formMatrix)
        : parentMatrix;
    const int childCount = FPDFFormObj_CountObjects(object);
    for (int i = 0; i < childCount; ++i) {
        std::vector<int> childPath = path;
        childPath.push_back(i);
        traverseTextObjects(
            FPDFFormObj_GetObject(object, i),
            pageIndex,
            displayMatrix,
            textPage,
            childPath,
            childParentMatrix,
            ss,
            first);
    }
}

struct ResolvedObjectPath {
    FPDF_PAGEOBJECT object = nullptr;
    FPDF_PAGEOBJECT parentForm = nullptr;
};

bool resolveObjectPath(FPDF_PAGE page, const std::vector<int>& path, ResolvedObjectPath& result) {
    if (path.empty() || path[0] < 0) return false;
    FPDF_PAGEOBJECT current = FPDFPage_GetObject(page, path[0]);
    if (!current) return false;
    FPDF_PAGEOBJECT parentForm = nullptr;
    for (size_t i = 1; i < path.size(); ++i) {
        if (path[i] < 0 || FPDFPageObj_GetType(current) != FPDF_PAGEOBJ_FORM) return false;
        parentForm = current;
        current = FPDFFormObj_GetObject(parentForm, path[i]);
        if (!current) return false;
    }
    result.object = current;
    result.parentForm = parentForm;
    return true;
}

void collectTextObjectStrings(FPDF_PAGEOBJECT object, FPDF_TEXTPAGE textPage,
                              std::vector<std::string>& texts,
                              const FS_MATRIX& parentMatrix = identityMatrix()) {
    if (!object) return;
    const int type = FPDFPageObj_GetType(object);
    if (type == FPDF_PAGEOBJ_TEXT) {
        float left = 0, bottom = 0, right = 0, top = 0;
        float pageLeft = 0, pageBottom = 0, pageRight = 0, pageTop = 0;
        if (FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) {
            transformBounds(parentMatrix, left, bottom, right, top, pageLeft, pageBottom, pageRight, pageTop);
        }
        texts.push_back(extractTextObjectText(object, textPage, pageLeft, pageBottom, pageRight, pageTop));
        return;
    }
    if (type != FPDF_PAGEOBJ_FORM) return;
    FS_MATRIX formMatrix = identityMatrix();
    const FS_MATRIX childParentMatrix = FPDFPageObj_GetMatrix(object, &formMatrix)
        ? composeMatrix(parentMatrix, formMatrix)
        : parentMatrix;
    const int childCount = FPDFFormObj_CountObjects(object);
    for (int i = 0; i < childCount; ++i) {
        collectTextObjectStrings(FPDFFormObj_GetObject(object, i), textPage, texts, childParentMatrix);
    }
}

// Text of the text object at `path` (root index, then Form XObject child indices), extracted
// exactly as collectTextObjectStrings extracts the same object. Returns false when the path
// does not resolve to a text object.
bool extractTextAtPath(FPDF_PAGE page, FPDF_TEXTPAGE textPage, const std::vector<int>& path,
                       std::string& outText) {
    if (!page || path.empty() || path[0] < 0 || path[0] >= FPDFPage_CountObjects(page)) return false;
    FPDF_PAGEOBJECT current = FPDFPage_GetObject(page, path[0]);
    FS_MATRIX parentMatrix = identityMatrix();
    for (size_t i = 1; i < path.size(); ++i) {
        if (!current || FPDFPageObj_GetType(current) != FPDF_PAGEOBJ_FORM) return false;
        FS_MATRIX formMatrix = identityMatrix();
        if (FPDFPageObj_GetMatrix(current, &formMatrix)) {
            parentMatrix = composeMatrix(parentMatrix, formMatrix);
        }
        if (path[i] < 0 || path[i] >= FPDFFormObj_CountObjects(current)) return false;
        current = FPDFFormObj_GetObject(current, path[i]);
    }
    if (!current || FPDFPageObj_GetType(current) != FPDF_PAGEOBJ_TEXT) return false;
    float left = 0, bottom = 0, right = 0, top = 0;
    float pageLeft = 0, pageBottom = 0, pageRight = 0, pageTop = 0;
    if (FPDFPageObj_GetBounds(current, &left, &bottom, &right, &top)) {
        transformBounds(parentMatrix, left, bottom, right, top, pageLeft, pageBottom, pageRight, pageTop);
    }
    outText = extractTextObjectText(current, textPage, pageLeft, pageBottom, pageRight, pageTop);
    return true;
}

bool findObjectInTree(FPDF_PAGEOBJECT node, FPDF_PAGEOBJECT target, std::vector<int>& path) {
    if (!node) return false;
    if (node == target) return true;
    if (FPDFPageObj_GetType(node) != FPDF_PAGEOBJ_FORM) return false;
    const int childCount = FPDFFormObj_CountObjects(node);
    for (int i = 0; i < childCount; ++i) {
        path.push_back(i);
        if (findObjectInTree(FPDFFormObj_GetObject(node, i), target, path)) return true;
        path.pop_back();
    }
    return false;
}

// Object path (root index, then Form XObject child indices) of `target` on `page`.
// Moves the contents of the root-level Form XObject `form` onto the page, in place (same order,
// same stacking position), applying the form's matrix to every moved object and its clip path,
// then removes the empty form. Appearance is unchanged; afterwards the content is ordinary page
// content, which FPDFPage_GenerateContent writes on save. (Changes to objects INSIDE a form are
// not written by FPDFPage_GenerateContent, and PDFium has no public API to regenerate a form's
// stream, so editing text inside a form requires this.) The moved objects keep their identity,
// so pointers resolved before flattening stay valid. Returns false (page unchanged) when the
// form holds content PDFium cannot re-serialise as page content (e.g. shadings).
bool flattenRootForm(FPDF_PAGE page, FPDF_PAGEOBJECT form, std::string& error) {
    const int rootCount = FPDFPage_CountObjects(page);
    int index = -1;
    for (int i = 0; i < rootCount; ++i) {
        if (FPDFPage_GetObject(page, i) == form) {
            index = i;
            break;
        }
    }
    if (index < 0 || FPDFPageObj_GetType(form) != FPDF_PAGEOBJ_FORM) {
        error = "Content block not found on the page";
        return false;
    }
    const int childCount = FPDFFormObj_CountObjects(form);
    if (childCount < 0) {
        error = "Content block could not be read";
        return false;
    }
    for (int i = 0; i < childCount; ++i) {
        const int type = FPDFPageObj_GetType(FPDFFormObj_GetObject(form, static_cast<unsigned long>(i)));
        if (type != FPDF_PAGEOBJ_TEXT && type != FPDF_PAGEOBJ_PATH && type != FPDF_PAGEOBJ_IMAGE &&
            type != FPDF_PAGEOBJ_FORM) {
            error = "This text is part of a content block with graphics PIE cannot rewrite safely";
            return false;
        }
    }
    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    if (!FPDFPageObj_GetMatrix(form, &m)) {
        error = "Content block position could not be read";
        return false;
    }
    for (int i = 0; i < childCount; ++i) {
        FPDF_PAGEOBJECT child = FPDFFormObj_GetObject(form, 0);
        if (!child || !FPDFFormObj_RemoveObject(form, child)) {
            error = "Content block could not be converted";
            return false;
        }
        FPDFPageObj_TransformF(child, &m);
        if (FPDFPageObj_GetClipPath(child)) {
            FPDFPageObj_TransformClipPath(child, m.a, m.b, m.c, m.d, m.e, m.f);
        }
        if (!FPDFPage_InsertObjectAtIndex(page, child, static_cast<size_t>(index + i))) {
            FPDFPage_InsertObject(page, child);
        }
    }
    if (FPDFPage_RemoveObject(page, form)) {
        FPDFPageObj_Destroy(form);
    }
    return true;
}

// ---- Line reflow (word-processor-like edits inside a line) ---------------------------------
// Geometry is in page (user) space. Only root-level, upright text objects take part; anything
// else (rotated text, objects still inside forms) is never moved.

struct PieBox {
    float l = 0, b = 0, r = 0, t = 0;
    float baseline = 0;  // page-space y of the text origin
    float size = 0;      // effective font size (Tf size x vertical matrix scale)
    float h() const { return t - b; }
};

bool pieUprightTextBox(FPDF_PAGEOBJECT o, PieBox& box) {
    if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_TEXT) return false;
    FS_MATRIX m;
    if (!FPDFPageObj_GetMatrix(o, &m) || std::fabs(m.b) > 1e-3f || std::fabs(m.c) > 1e-3f || m.a <= 0 || m.d <= 0) {
        return false;
    }
    float fontSize = 0;
    if (!FPDFTextObj_GetFontSize(o, &fontSize) || fontSize <= 0) fontSize = 1;
    box.baseline = m.f;
    box.size = fontSize * m.d;
    return FPDFPageObj_GetBounds(o, &box.l, &box.b, &box.r, &box.t) && box.r >= box.l && box.t > box.b;
}

// Same typeset line: baselines within a third of the font size and comparable sizes. (Ink boxes
// alone are unreliable: commas, descenders and small letters barely overlap capitals.)
bool pieSameLine(const PieBox& a, const PieBox& c) {
    const float big = std::max(a.size, c.size), small = std::min(a.size, c.size);
    if (small <= 0) return false;
    return std::fabs(a.baseline - c.baseline) <= big * 0.35f && big <= small * 2.0f;
}

// Root-level text objects on `line` that start at or after `fromX`, in reading order, up to
// the first gap wider than the line height (a column break): the run that follows an edit.
std::vector<std::pair<FPDF_PAGEOBJECT, PieBox>> pieFollowingRun(FPDF_PAGE page, const PieBox& line, float fromX,
                                                                const std::vector<FPDF_PAGEOBJECT>& exclude) {
    std::vector<std::pair<FPDF_PAGEOBJECT, PieBox>> candidates;
    const int count = FPDFPage_CountObjects(page);
    for (int i = 0; i < count; ++i) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (std::find(exclude.begin(), exclude.end(), o) != exclude.end()) continue;
        PieBox box;
        if (!pieUprightTextBox(o, box) || !pieSameLine(line, box)) continue;
        if (box.l < fromX - 0.5f) continue;
        candidates.emplace_back(o, box);
    }
    std::sort(candidates.begin(), candidates.end(),
              [](const auto& x, const auto& y) { return x.second.l < y.second.l; });
    std::vector<std::pair<FPDF_PAGEOBJECT, PieBox>> run;
    const float maxGap = std::max(1.0f, line.size);
    float prevRight = fromX;
    for (const auto& c : candidates) {
        if (c.second.l - prevRight > maxGap) break;
        run.push_back(c);
        prevRight = std::max(prevRight, c.second.r);
    }
    return run;
}

// Right edge of the nearest root-level text on `line` that ends at or before `x` (within one
// line height, i.e. not across a column gap). Returns false when there is none.
bool pieLeftNeighbourRight(FPDF_PAGE page, const PieBox& line, float x, float& outRight) {
    bool found = false;
    const float maxGap = std::max(1.0f, line.size);
    const int count = FPDFPage_CountObjects(page);
    for (int i = 0; i < count; ++i) {
        PieBox box;
        if (!pieUprightTextBox(FPDFPage_GetObject(page, i), box) || !pieSameLine(line, box)) continue;
        if (box.r > x + 0.5f || x - box.r > maxGap) continue;
        if (!found || box.r > outRight) outRight = box.r;
        found = true;
    }
    return found;
}

void pieShiftRun(const std::vector<std::pair<FPDF_PAGEOBJECT, PieBox>>& run, float dx) {
    if (std::fabs(dx) < 0.01f) return;
    for (const auto& c : run) FPDFPageObj_Transform(c.first, 1, 0, 0, 1, dx, 0);
}

bool locateObjectPath(FPDF_PAGE page, FPDF_PAGEOBJECT target, std::vector<int>& outPath) {
    outPath.clear();
    if (!page || !target) return false;
    const int rootCount = FPDFPage_CountObjects(page);
    for (int i = 0; i < rootCount; ++i) {
        outPath.assign(1, i);
        if (findObjectInTree(FPDFPage_GetObject(page, i), target, outPath)) return true;
    }
    outPath.clear();
    return false;
}

FPDF_DOCUMENT getDoc(int64_t handle) {
    auto it = g_documents.find(handle);
    if (it == g_documents.end()) {
        return nullptr;
    }
    return it->second;
}

} // namespace

namespace pie_engine {

void initLibrary() {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();
}

void destroyLibrary() {
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto& pair : g_documents) {
        if (pair.second) {
            FPDF_CloseDocument(pair.second);
        }
    }
    g_documents.clear();
    if (g_libraryInitialized) {
        FPDF_DestroyLibrary();
        g_libraryInitialized = false;
        LOGI("PDFium library destroyed");
    }
}

// Error of the calling thread's last openDocument(), captured while the engine lock is held:
// PDFium's FPDF_GetLastError() is process-wide, so reading it later (after another thread used
// PDFium) could report the wrong reason, e.g. a password PDF shown as "corrupt".
thread_local unsigned long t_lastOpenError = 0;

int64_t openDocument(const std::string& filePath, const char* password) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();
    FPDF_DOCUMENT doc = FPDF_LoadDocument(filePath.c_str(), password);
    if (!doc) {
        unsigned long err = FPDF_GetLastError();
        t_lastOpenError = err;
        LOGE("Failed to open PDF document, FPDF_GetLastError: %lu", err);
        return 0;
    }
    t_lastOpenError = 0;
    int64_t handle = g_nextDocHandle++;
    g_documents[handle] = doc;
    LOGI("Opened PDF document with handle %lld", (long long)handle);
    return handle;
}

void closeDocument(int64_t docHandle) {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_documents.find(docHandle);
    if (it != g_documents.end()) {
        if (it->second) {
            FPDF_CloseDocument(it->second);
        }
        g_documents.erase(it);
        LOGI("Closed PDF document with handle %lld", (long long)docHandle);
    }
}

int getPageCount(int64_t docHandle) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) {
        LOGE("getPageCount: Invalid document handle %lld", (long long)docHandle);
        return -1;
    }
    return FPDF_GetPageCount(doc);
}

bool getPageSize(int64_t docHandle, int pageIndex, double& width, double& height) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) return false;
    return FPDF_GetPageSizeByIndex(doc, pageIndex, &width, &height) != 0;
}

// Page geometry: [displayWidth, displayHeight, rotationQuarterTurns, a, b, c, d, e, f] where
// (a..f) maps PDF user space to the displayed page (points, top-left origin, Y down) exactly
// as rendering does.
bool getPageGeometry(int64_t docHandle, int pageIndex, double out[9]) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) return false;
    double width = 0.0, height = 0.0;
    if (!FPDF_GetPageSizeByIndex(doc, pageIndex, &width, &height)) return false;
    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) return false;
    FS_MATRIX m;
    if (!computeDisplayMatrix(page, width, height, m)) {
        m = displayMatrixFallback(height);
    }
    int rotation = FPDFPage_GetRotation(page);
    if (rotation < 0 || rotation > 3) rotation = 0;
    FPDF_ClosePage(page);
    const double values[9] = {width, height, static_cast<double>(rotation), m.a, m.b, m.c, m.d, m.e, m.f};
    for (int i = 0; i < 9; ++i) out[i] = values[i];
    return true;
}

// Renders the whole page into a caller-owned 32-bit buffer (white background, annotations).
// rgbaOrder = true writes R,G,B,A bytes (Android ARGB_8888); false writes B,G,R,A (iOS BGRA).
bool renderPageToBuffer(int64_t docHandle, int pageIndex, void* pixels, int width, int height, int stride, bool rgbaOrder) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc || !pixels || width <= 0 || height <= 0) {
        LOGE("renderPageToBuffer: invalid arguments");
        return false;
    }
    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) {
        LOGE("renderPageToBuffer: Failed to load page %d", pageIndex);
        return false;
    }
    FPDF_BITMAP fpdfBitmap = FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, pixels, stride);
    if (!fpdfBitmap) {
        FPDF_ClosePage(page);
        return false;
    }
    FPDFBitmap_FillRect(fpdfBitmap, 0, 0, width, height, 0xFFFFFFFF);
    FPDF_RenderPageBitmap(fpdfBitmap, page, 0, 0, width, height, 0,
                          FPDF_ANNOT | (rgbaOrder ? FPDF_REVERSE_BYTE_ORDER : 0));
    FPDFBitmap_Destroy(fpdfBitmap);
    FPDF_ClosePage(page);
    return true;
}

// Renders the display-space region starting at (left, top) points at `scale` pixels per point,
// using the same page display transform as renderPageToBuffer.
bool renderRegionToBuffer(int64_t docHandle, int pageIndex, void* pixels, int width, int height, int stride,
                          double scale, double left, double top, bool rgbaOrder) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc || !pixels || !(scale > 0.0) || width <= 0 || height <= 0) return false;
    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) return false;
    FPDF_BITMAP fpdfBitmap = FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, pixels, stride);
    if (!fpdfBitmap) {
        FPDF_ClosePage(page);
        return false;
    }
    FPDFBitmap_FillRect(fpdfBitmap, 0, 0, width, height, 0xFFFFFFFF);
    // Applied after the page's own display matrix: display points -> region pixels.
    const FS_MATRIX matrix{
        static_cast<float>(scale), 0, 0, static_cast<float>(scale),
        static_cast<float>(-left * scale), static_cast<float>(-top * scale)};
    const FS_RECTF clip{0, 0, static_cast<float>(width), static_cast<float>(height)};
    FPDF_RenderPageBitmapWithMatrix(fpdfBitmap, page, &matrix, &clip,
                                    FPDF_ANNOT | (rgbaOrder ? FPDF_REVERSE_BYTE_ORDER : 0));
    FPDFBitmap_Destroy(fpdfBitmap);
    FPDF_ClosePage(page);
    return true;
}

std::string getTextObjectsJson(int64_t docHandle, int pageIndex) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) {
        LOGE("nativeGetTextObjectsJson: Invalid document handle %lld", (long long)docHandle);
        return std::string("[]");
    }

    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) {
        LOGE("nativeGetTextObjectsJson: Failed to load page %d", pageIndex);
        return std::string("[]");
    }

    double pageW = 0.0;
    double pageH = 0.0;
    FPDF_GetPageSizeByIndex(doc, pageIndex, &pageW, &pageH);

    FS_MATRIX displayMatrix;
    if (!computeDisplayMatrix(page, pageW, pageH, displayMatrix)) {
        displayMatrix = displayMatrixFallback(pageH);
    }

    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    std::ostringstream recursiveJson;
    recursiveJson << "[";
    bool recursiveFirst = true;
    const int rootObjectCount = FPDFPage_CountObjects(page);
    for (int i = 0; i < rootObjectCount; ++i) {
        traverseTextObjects(
            FPDFPage_GetObject(page, i),
            pageIndex,
            displayMatrix,
            textPage,
            std::vector<int>{i},
            identityMatrix(),
            recursiveJson,
            recursiveFirst);
    }
    recursiveJson << "]";
    if (textPage) FPDFText_ClosePage(textPage);
    FPDF_ClosePage(page);
    return recursiveJson.str();

    // Legacy flat traversal retained below solely as historical reference.
    // It is unreachable because nested Form XObjects require the recursive
    // traversal above.
    int objCount = FPDFPage_CountObjects(page);

    std::ostringstream ss;
    ss << "[";
    bool first = true;

    for (int i = 0; i < objCount; ++i) {
        FPDF_PAGEOBJECT pageObj = FPDFPage_GetObject(page, i);
        if (!pageObj) continue;

        int type = FPDFPageObj_GetType(pageObj);
        // Strictly filter for vector text objects only
        // Skips FPDF_PAGEOBJ_IMAGE (3), FPDF_PAGEOBJ_PATH (2), etc.
        if (type != FPDF_PAGEOBJ_TEXT) {
            continue;
        }

        // 1. Bounds
        float left = 0, bottom = 0, right = 0, top = 0;
        FPDF_BOOL okBounds = FPDFPageObj_GetBounds(pageObj, &left, &bottom, &right, &top);
        if (!okBounds) continue;

        // Coordinate normalization into top-left document coordinate system
        // docLeft = left
        // docTop = pageH - top
        // docWidth = right - left
        // docHeight = top - bottom
        float docLeft = left;
        float docTop = static_cast<float>(pageH) - top;
        float docWidth = std::abs(right - left);
        float docHeight = std::abs(top - bottom);

        // 2. Font size
        float fontSize = 0.0f;
        FPDF_BOOL hasFontSize = FPDFTextObj_GetFontSize(pageObj, &fontSize);

        // 3. Font base name and rich font details
        std::string fontName;
        std::string familyName;
        int isEmbedded = -1;
        bool isSubset = false;
        int fontWeight = -1;
        int fontFlags = -1;
        bool hasFont = false;
        FPDF_FONT font = FPDFTextObj_GetFont(pageObj);
        if (font) {
            size_t fnLen = FPDFFont_GetBaseFontName(font, nullptr, 0);
            if (fnLen > 0) {
                std::vector<char> fnBuf(fnLen + 1, 0);
                FPDFFont_GetBaseFontName(font, fnBuf.data(), fnLen);
                fontName = fnBuf.data();
                hasFont = !fontName.empty();
            }
            size_t famLen = FPDFFont_GetFamilyName(font, nullptr, 0);
            if (famLen > 0) {
                std::vector<char> famBuf(famLen + 1, 0);
                FPDFFont_GetFamilyName(font, famBuf.data(), famLen);
                familyName = famBuf.data();
            }
            isEmbedded = FPDFFont_GetIsEmbedded(font);
            fontWeight = FPDFFont_GetWeight(font);
            fontFlags = FPDFFont_GetFlags(font);
            isSubset = isSubsetFont(fontName);
        }

        // 4. Fill Color
        unsigned int r = 0, g = 0, b = 0, a = 255;
        FPDF_BOOL hasColor = FPDFPageObj_GetFillColor(pageObj, &r, &g, &b, &a);

        // 5. Transformation Matrix
        FS_MATRIX matrix;
        FPDF_BOOL hasMatrix = FPDFPageObj_GetMatrix(pageObj, &matrix);

        // 6. Text content extraction
        std::string textUtf8;
        if (textPage) {
            unsigned long reqBytes = FPDFTextObj_GetText(pageObj, textPage, nullptr, 0);
            if (reqBytes > 0) {
                std::vector<FPDF_WCHAR> wbuf(reqBytes / sizeof(FPDF_WCHAR) + 1, 0);
                unsigned long readBytes = FPDFTextObj_GetText(pageObj, textPage, wbuf.data(), reqBytes);
                if (readBytes > 0) {
                    textUtf8 = utf16ToUtf8(wbuf.data(), readBytes / sizeof(FPDF_WCHAR));
                }
            }

            // Fallback: If FPDFTextObj_GetText was empty, correlate matching character indices in textPage
            if (textUtf8.empty()) {
                int charCount = FPDFText_CountChars(textPage);
                std::vector<FPDF_WCHAR> matchedChars;
                for (int c = 0; c < charCount; ++c) {
                    if (FPDFText_GetTextObject(textPage, c) == pageObj) {
                        unsigned int unicode = FPDFText_GetUnicode(textPage, c);
                        if (unicode > 0) {
                            matchedChars.push_back(static_cast<FPDF_WCHAR>(unicode));
                        }
                    }
                }
                if (!matchedChars.empty()) {
                    textUtf8 = utf16ToUtf8(matchedChars.data(), matchedChars.size());
                }
            }
        }

        // Construct stable identifier for current opened document
        std::string id = "p" + std::to_string(pageIndex) + "_obj" + std::to_string(i);

        if (!first) {
            ss << ",";
        }
        first = false;

        ss << "{";
        ss << "\"id\":\"" << id << "\",";
        ss << "\"pageIndex\":" << pageIndex << ",";
        ss << "\"objectIndex\":" << i << ",";
        ss << "\"text\":\"" << escapeJsonString(textUtf8) << "\",";
        ss << "\"bounds\":{\"x\":" << docLeft << ",\"y\":" << docTop
           << ",\"width\":" << docWidth << ",\"height\":" << docHeight << "},";
        ss << "\"pdfBounds\":{\"left\":" << left << ",\"bottom\":" << bottom
           << ",\"right\":" << right << ",\"top\":" << top << "},";

        if (hasFontSize && fontSize > 0) {
            ss << "\"fontSize\":" << fontSize << ",";
        } else {
            ss << "\"fontSize\":null,";
        }

        ss << "\"isEditable\":true,";

        if (hasFont) {
            ss << "\"fontName\":\"" << escapeJsonString(fontName) << "\",";
            ss << "\"fontDetails\":{";
            ss << "\"baseFontName\":\"" << escapeJsonString(fontName) << "\",";
            ss << "\"familyName\":\"" << escapeJsonString(familyName) << "\",";
            ss << "\"isEmbedded\":" << (isEmbedded == 1 ? "true" : "false") << ",";
            ss << "\"isSubset\":" << (isSubset ? "true" : "false") << ",";
            ss << "\"weight\":" << (fontWeight >= 0 ? std::to_string(fontWeight) : "null") << ",";
            ss << "\"flags\":" << (fontFlags >= 0 ? std::to_string(fontFlags) : "null");
            ss << "},";
        } else {
            ss << "\"fontName\":null,\"fontDetails\":null,";
        }

        if (hasColor) {
            char colorBuf[16];
            snprintf(colorBuf, sizeof(colorBuf), "#%02X%02X%02X", r, g, b);
            ss << "\"color\":\"" << colorBuf << "\",";
            ss << "\"colorRgba\":{\"r\":" << r << ",\"g\":" << g << ",\"b\":" << b << ",\"a\":" << a << "},";
        } else {
            ss << "\"color\":null,\"colorRgba\":null,";
        }

        if (hasMatrix) {
            ss << "\"matrix\":{\"a\":" << matrix.a << ",\"b\":" << matrix.b
               << ",\"c\":" << matrix.c << ",\"d\":" << matrix.d
               << ",\"e\":" << matrix.e << ",\"f\":" << matrix.f << "}";
        } else {
            ss << "\"matrix\":null";
        }

        ss << "}";
    }

    ss << "]";

    if (textPage) {
        FPDFText_ClosePage(textPage);
    }
    FPDF_ClosePage(page);

    std::string jsonStr = ss.str();
    return jsonStr;
}

int lastError() {
    return static_cast<int>(t_lastOpenError);
}

std::string replaceTextObjectJson(const std::string& inputPath, const std::string& outputPath, int pageIndex,
                                  int objectIndex, const std::string& replacementText) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();

    auto makeErrorJson = [&](const std::string& code, const std::string& msg) -> std::string {
        std::string json = "{\"success\":false,\"errorCode\":\"" + escapeJsonString(code) +
                           "\",\"errorMessage\":\"" + escapeJsonString(msg) + "\"}";
        return json;
    };



    if (inputPath == outputPath) {
        return makeErrorJson("SAME_INPUT_OUTPUT", "Input path and output path must be different to preserve source immutability");
    }

    if (replacementText.empty()) {
        return makeErrorJson("EMPTY_REPLACEMENT", "Replacement text cannot be empty");
    }

    // 1. Source immutability verification: Checksum before operation
    std::string hashBefore = computeFileChecksum(inputPath);
    if (hashBefore.empty()) {
        return makeErrorJson("PDF_FILE_NOT_FOUND", "Input PDF file not found or inaccessible: " + inputPath);
    }

    // 2. Open source document
    FPDF_DOCUMENT doc = FPDF_LoadDocument(inputPath.c_str(), nullptr);
    if (!doc) {
        unsigned long err = FPDF_GetLastError();
        return makeErrorJson("PDF_OPEN_FAILED", "Failed to open source PDF, error code: " + std::to_string(err));
    }

    int pageCountBefore = FPDF_GetPageCount(doc);
    if (pageIndex < 0 || pageIndex >= pageCountBefore) {
        FPDF_CloseDocument(doc);
        return makeErrorJson("PDF_PAGE_OUT_OF_RANGE", "Page index " + std::to_string(pageIndex) + " is out of range [0, " + std::to_string(pageCountBefore - 1) + "]");
    }

    // 3. Load target page
    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) {
        FPDF_CloseDocument(doc);
        return makeErrorJson("PDF_PAGE_LOAD_FAILED", "Failed to load page " + std::to_string(pageIndex));
    }

    int objCount = FPDFPage_CountObjects(page);
    if (objectIndex < 0 || objectIndex >= objCount) {
        FPDF_ClosePage(page);
        FPDF_CloseDocument(doc);
        return makeErrorJson("PDF_OBJECT_OUT_OF_RANGE", "Object index " + std::to_string(objectIndex) + " is out of range [0, " + std::to_string(objCount - 1) + "]");
    }

    // 4. Retrieve target object
    FPDF_PAGEOBJECT targetObj = FPDFPage_GetObject(page, objectIndex);
    if (!targetObj) {
        FPDF_ClosePage(page);
        FPDF_CloseDocument(doc);
        return makeErrorJson("PDF_OBJECT_NULL", "Target object at index " + std::to_string(objectIndex) + " is null");
    }

    int objType = FPDFPageObj_GetType(targetObj);
    if (objType != FPDF_PAGEOBJ_TEXT) {
        FPDF_ClosePage(page);
        FPDF_CloseDocument(doc);
        return makeErrorJson("NOT_A_TEXT_OBJECT", "Target object at index " + std::to_string(objectIndex) + " is not a vector text object (type: " + std::to_string(objType) + ")");
    }

    // 5. Extract existing text object properties to preserve
    double pageW = 0.0, pageH = 0.0;
    FPDF_GetPageSizeByIndex(doc, pageIndex, &pageW, &pageH);

    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    std::string oldText;
    if (textPage) {
        unsigned long oldLen = FPDFTextObj_GetText(targetObj, textPage, nullptr, 0);
        if (oldLen > 0) {
            std::vector<FPDF_WCHAR> wbuf(oldLen / sizeof(FPDF_WCHAR) + 1, 0);
            unsigned long readBytes = FPDFTextObj_GetText(targetObj, textPage, wbuf.data(), oldLen);
            if (readBytes > 0) {
                oldText = utf16ToUtf8(wbuf.data(), readBytes / sizeof(FPDF_WCHAR));
            }
        }
    }

    // Pre-edit text of every root-level text object and of the target, used for
    // duplicate-safe reopen verification (exact text + occurrence counts).
    std::vector<std::string> beforeRootTexts;
    for (int i = 0; i < objCount; ++i) {
        FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, i);
        if (obj && FPDFPageObj_GetType(obj) == FPDF_PAGEOBJ_TEXT) {
            beforeRootTexts.push_back(extractTextObjectText(obj, textPage));
        }
    }
    const std::string preEditText = extractTextObjectText(targetObj, textPage);

    float oldLeft = 0, oldBottom = 0, oldRight = 0, oldTop = 0;
    [[maybe_unused]] FPDF_BOOL okBounds = FPDFPageObj_GetBounds(targetObj, &oldLeft, &oldBottom, &oldRight, &oldTop);

    float oldFontSize = 12.0f;
    [[maybe_unused]] FPDF_BOOL hasFontSize = FPDFTextObj_GetFontSize(targetObj, &oldFontSize);

    std::string oldFontName;
    std::string oldFamilyName;
    int oldFontWeight = -1;
    int oldFontFlags = -1;
    bool oldIsEmbedded = false;
    bool oldIsSubset = false;

    FPDF_FONT oldFont = FPDFTextObj_GetFont(targetObj);
    if (oldFont) {
        size_t fnLen = FPDFFont_GetBaseFontName(oldFont, nullptr, 0);
        if (fnLen > 0) {
            std::vector<char> fnBuf(fnLen + 1, 0);
            FPDFFont_GetBaseFontName(oldFont, fnBuf.data(), fnLen);
            oldFontName = fnBuf.data();
        }
        size_t famLen = FPDFFont_GetFamilyName(oldFont, nullptr, 0);
        if (famLen > 0) {
            std::vector<char> famBuf(famLen + 1, 0);
            FPDFFont_GetFamilyName(oldFont, famBuf.data(), famLen);
            oldFamilyName = famBuf.data();
        }
        oldIsEmbedded = (FPDFFont_GetIsEmbedded(oldFont) == 1);
        oldFontWeight = FPDFFont_GetWeight(oldFont);
        oldFontFlags = FPDFFont_GetFlags(oldFont);
        oldIsSubset = isSubsetFont(oldFontName);
    }

    unsigned int r = 0, g = 0, b = 0, a = 255;
    FPDF_BOOL hasColor = FPDFPageObj_GetFillColor(targetObj, &r, &g, &b, &a);

    FS_MATRIX matrix;
    FPDF_BOOL hasMatrix = FPDFPageObj_GetMatrix(targetObj, &matrix);

    // 6. Perform Vector Text Replacement
    std::vector<FPDF_WCHAR> wideRep = utf8ToUtf16(replacementText);
    bool replacedInPlace = false;
    bool genuineSuccess = false;
    std::string fontStrategy = "UNKNOWN";
    std::vector<std::string> limitations;

    // Phase 15 glyph safety (same rule as the batch path)
    {
        const std::vector<uint32_t> missing = findMissingGlyphs(oldFont, replacementText, preEditText);
        if (!missing.empty()) {
            if (textPage) FPDFText_ClosePage(textPage);
            FPDF_ClosePage(page);
            FPDF_CloseDocument(doc);
            return makeErrorJson("UNSUPPORTED_GLYPHS", unsupportedGlyphsMessage(missing, "The original font"));
        }
    }

    // Strategy 1: Direct in-place replacement via FPDFText_SetText
    // If the font can represent the replacement characters, this reuses the exact original
    // font resource (and existing matrix/color/dimensions) held by the existing object.
    if (FPDFText_SetText(targetObj, (FPDF_WIDESTRING)wideRep.data())) {
        replacedInPlace = true;
        genuineSuccess = true;
        fontStrategy = "REUSED_ORIGINAL";
    } else {
        // Strategy 2: Fallback when in-place modification fails (e.g. subset font lacking glyphs)
        std::string standardCandidate;
        if (!oldFontName.empty()) {
            std::string cleanName = oldIsSubset ? oldFontName.substr(7) : oldFontName;
            standardCandidate = cleanName;
        }

        FPDF_FONT repFont = nullptr;
        if (!standardCandidate.empty()) {
            repFont = FPDFText_LoadStandardFont(doc, standardCandidate.c_str());
        }
        if (!repFont && oldFontWeight >= 700) {
            repFont = FPDFText_LoadStandardFont(doc, "Helvetica-Bold");
        }
        if (!repFont) {
            repFont = FPDFText_LoadStandardFont(doc, "Helvetica");
        }

        if (repFont) {
            fontStrategy = "LOADED_STANDARD";
            FPDF_PAGEOBJECT newTextObj = FPDFPageObj_CreateTextObj(doc, repFont, oldFontSize);
            if (newTextObj) {
                if (FPDFText_SetText(newTextObj, (FPDF_WIDESTRING)wideRep.data())) {
                    if (hasMatrix) {
                        FPDFPageObj_SetMatrix(newTextObj, &matrix);
                    }
                    if (hasColor) {
                        FPDFPageObj_SetFillColor(newTextObj, r, g, b, a);
                    }
                    if (replaceRootObjectInPlace(page, targetObj, newTextObj)) {
                        // The original is detached and no longer referenced: free it
                        FPDFPageObj_Destroy(targetObj);
                        targetObj = nullptr;
                        genuineSuccess = true;
                    } else {
                        FPDFPageObj_Destroy(newTextObj);
                    }
                } else {
                    FPDFPageObj_Destroy(newTextObj);
                }
            }
        } else {
            limitations.push_back("Standard font loading unavailable; could not substitute font");
        }
    }

    if (!genuineSuccess) {
        if (textPage) FPDFText_ClosePage(textPage);
        FPDF_ClosePage(page);
        FPDF_CloseDocument(doc);
        return makeErrorJson("TEXT_REPLACE_FAILED", "PDFium failed to replace vector text on target object");
    }

    // Location of the replaced object after the edit: the same index for both strategies
    // (Strategy 2 swaps the substituted object into the original position; count unchanged).
    const int expectedIndex = static_cast<int>(objectIndex);
    (void)replacedInPlace;

    // 7. Regenerate page content streams
    FPDF_BOOL okGen = FPDFPage_GenerateContent(page);
    if (textPage) {
        FPDFText_ClosePage(textPage);
    }
    FPDF_ClosePage(page);

    if (!okGen) {
        FPDF_CloseDocument(doc);
        return makeErrorJson("GENERATE_CONTENT_FAILED", "FPDFPage_GenerateContent failed to rebuild page content stream");
    }

    // 8. Save modified document as a new file copy
    FILE* fp = fopen(outputPath.c_str(), "wb");
    if (!fp) {
        FPDF_CloseDocument(doc);
        return makeErrorJson("OUTPUT_FILE_CREATE_FAILED", "Failed to create output file for writing: " + outputPath);
    }

    CustomFileWriter writer(fp);
    FPDF_BOOL okSave = FPDF_SaveAsCopy(doc, &writer, 0);
    fclose(fp);
    FPDF_CloseDocument(doc);

    if (!okSave) {
        return makeErrorJson("PDF_SAVE_FAILED", "FPDF_SaveAsCopy failed to save document");
    }

    // 9. Source immutability check
    std::string hashAfter = computeFileChecksum(inputPath);
    bool sourceUnchanged = (!hashBefore.empty() && hashBefore == hashAfter);

    // 10. Reopen generated PDF document and inspect verification metrics
    FPDF_DOCUMENT newDoc = FPDF_LoadDocument(outputPath.c_str(), nullptr);
    if (!newDoc) {
        return makeErrorJson("REOPEN_FAILED", "Newly saved output PDF could not be reopened with PDFium");
    }

    int pageCountAfter = FPDF_GetPageCount(newDoc);
    FPDF_PAGE newPage = FPDF_LoadPage(newDoc, pageIndex);
    if (!newPage) {
        FPDF_CloseDocument(newDoc);
        return makeErrorJson("REOPEN_PAGE_FAILED", "Failed to load page " + std::to_string(pageIndex) + " from reopened PDF");
    }

    double newPageW = 0.0, newPageH = 0.0;
    FPDF_GetPageSizeByIndex(newDoc, pageIndex, &newPageW, &newPageH);

    FPDF_TEXTPAGE newTextPage = FPDFText_LoadPage(newPage);
    int newObjCount = FPDFPage_CountObjects(newPage);

    bool replacementFoundInReopened = false;
    bool oldTextStillPresentInReopened = false;

    // Scan page for the replaced text and verify
    std::string reopenedObjId;
    std::string reopenedText;
    float reopenedX = 0, reopenedY = 0, reopenedW = 0, reopenedH = 0;
    float repLeft = 0, repBottom = 0, repRight = 0, repTop = 0;
    float reopenedFontSize = 0;
    std::string reopenedFontName;
    std::string reopenedFamilyName;
    int reopenedFontWeight = -1;
    int reopenedFontFlags = -1;
    bool reopenedIsEmbedded = false;
    bool reopenedIsSubset = false;
    std::string reopenedColor;
    unsigned int repR = 0, repG = 0, repB = 0, repA = 255;
    FS_MATRIX repMatrix;
    bool hasRepMatrix = false;

    // Verification inspects the replaced object itself (at its expected index) plus exact
    // occurrence counts, never a page-wide substring match.
    std::vector<std::string> afterRootTexts;
    bool expectedObjectFound = false;
    std::string expectedObjectText;
    for (int i = 0; i < newObjCount; ++i) {
        FPDF_PAGEOBJECT obj = FPDFPage_GetObject(newPage, i);
        if (!obj || FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) continue;

        const std::string txt = extractTextObjectText(obj, newTextPage);
        afterRootTexts.push_back(txt);

        if (i == expectedIndex) {
            expectedObjectFound = true;
            expectedObjectText = txt;
            reopenedObjId = "p" + std::to_string(pageIndex) + "_obj" + std::to_string(i);
            reopenedText = txt;

            FPDFPageObj_GetBounds(obj, &repLeft, &repBottom, &repRight, &repTop);
            reopenedX = repLeft;
            reopenedY = static_cast<float>(newPageH) - repTop;
            reopenedW = std::abs(repRight - repLeft);
            reopenedH = std::abs(repTop - repBottom);

            FPDFTextObj_GetFontSize(obj, &reopenedFontSize);
            FPDF_FONT fnt = FPDFTextObj_GetFont(obj);
            if (fnt) {
                size_t fnL = FPDFFont_GetBaseFontName(fnt, nullptr, 0);
                if (fnL > 0) {
                    std::vector<char> fnB(fnL + 1, 0);
                    FPDFFont_GetBaseFontName(fnt, fnB.data(), fnL);
                    reopenedFontName = fnB.data();
                }
                size_t famL = FPDFFont_GetFamilyName(fnt, nullptr, 0);
                if (famL > 0) {
                    std::vector<char> famB(famL + 1, 0);
                    FPDFFont_GetFamilyName(fnt, famB.data(), famL);
                    reopenedFamilyName = famB.data();
                }
                reopenedIsEmbedded = (FPDFFont_GetIsEmbedded(fnt) == 1);
                reopenedFontWeight = FPDFFont_GetWeight(fnt);
                reopenedFontFlags = FPDFFont_GetFlags(fnt);
                reopenedIsSubset = isSubsetFont(reopenedFontName);
            }

            if (FPDFPageObj_GetFillColor(obj, &repR, &repG, &repB, &repA)) {
                char cBuf[16];
                snprintf(cBuf, sizeof(cBuf), "#%02X%02X%02X", repR, repG, repB);
                reopenedColor = cBuf;
            }

            hasRepMatrix = FPDFPageObj_GetMatrix(obj, &repMatrix);
        }
    }

    if (newTextPage) FPDFText_ClosePage(newTextPage);
    FPDF_ClosePage(newPage);
    FPDF_CloseDocument(newDoc);

    {
        std::vector<pie::PageVerifyInput> verifyInputs(1);
        verifyInputs[0].type = "replace";
        verifyInputs[0].preText = preEditText;
        verifyInputs[0].newText = replacementText;
        verifyInputs[0].objectFound = expectedObjectFound;
        verifyInputs[0].objectText = expectedObjectText;
        pie::verifyPageEdits(beforeRootTexts, afterRootTexts, verifyInputs);
        replacementFoundInReopened = verifyInputs[0].verified;
        if (!replacementFoundInReopened) {
            limitations.push_back("Reopen verification failed: " + verifyInputs[0].error);
        }

        const std::string pre = pie::normalizeVerifyText(preEditText);
        if (!pre.empty() && pre != pie::normalizeVerifyText(replacementText)) {
            const int beforeCount = pie::countOf(pie::countNormalizedTexts(beforeRootTexts), pre);
            const int afterCount = pie::countOf(pie::countNormalizedTexts(afterRootTexts), pre);
            oldTextStillPresentInReopened = afterCount > beforeCount - 1;
        }
    }

    bool fontReused = (replacedInPlace && (reopenedFontName == oldFontName || (!oldFontName.empty() && reopenedFontName.find(oldFontName) != std::string::npos)));
    if (fontReused) {
        limitations.push_back("Original font resource (" + oldFontName + ") successfully preserved and reused in-place. Embedded: " + (oldIsEmbedded ? "true" : "false") + ", Subset: " + (oldIsSubset ? "true" : "false") + ".");
    } else {
        limitations.push_back("Font could not be reused directly in-place (Strategy: " + fontStrategy + "). Used fallback font (" + reopenedFontName + ") while preserving font size, color, and affine transformation matrix.");
    }
    if (oldIsSubset) {
        limitations.push_back("Original font is an embedded subset (" + oldFontName + "). Embedded subsets lack glyph outlines for characters not originally used; PDFium does not generate new glyph bezier curves for subset fonts.");
    }

    // 11. Build structured JSON response
    std::ostringstream ss;
    ss << "{";
    ss << "\"success\":true,";
    ss << "\"inputPath\":\"" << escapeJsonString(inputPath) << "\",";
    ss << "\"outputPath\":\"" << escapeJsonString(outputPath) << "\",";
    ss << "\"pageIndex\":" << pageIndex << ",";
    ss << "\"objectIndex\":" << objectIndex << ",";
    ss << "\"oldText\":\"" << escapeJsonString(oldText) << "\",";
    ss << "\"replacementText\":\"" << escapeJsonString(replacementText) << "\",";
    ss << "\"replacedInPlace\":" << (replacedInPlace ? "true" : "false") << ",";
    ss << "\"fontReused\":" << (fontReused ? "true" : "false") << ",";
    ss << "\"fontStrategy\":\"" << escapeJsonString(fontStrategy) << "\",";
    ss << "\"replacementFoundInReopened\":" << (replacementFoundInReopened ? "true" : "false") << ",";
    ss << "\"oldTextStillPresentInReopened\":" << (oldTextStillPresentInReopened ? "true" : "false") << ",";
    ss << "\"pageCountBefore\":" << pageCountBefore << ",";
    ss << "\"pageCountAfter\":" << pageCountAfter << ",";
    ss << "\"sourceFileUnchanged\":" << (sourceUnchanged ? "true" : "false") << ",";
    ss << "\"sourceShaBefore\":\"" << hashBefore << "\",";
    ss << "\"sourceShaAfter\":\"" << hashAfter << "\",";

    ss << "\"originalFont\":{";
    ss << "\"baseFontName\":\"" << escapeJsonString(oldFontName) << "\",";
    ss << "\"familyName\":\"" << escapeJsonString(oldFamilyName) << "\",";
    ss << "\"isEmbedded\":" << (oldIsEmbedded ? "true" : "false") << ",";
    ss << "\"isSubset\":" << (oldIsSubset ? "true" : "false") << ",";
    ss << "\"weight\":" << (oldFontWeight >= 0 ? std::to_string(oldFontWeight) : "null") << ",";
    ss << "\"flags\":" << (oldFontFlags >= 0 ? std::to_string(oldFontFlags) : "null");
    ss << "},";

    ss << "\"reopenedFont\":{";
    ss << "\"baseFontName\":\"" << escapeJsonString(reopenedFontName) << "\",";
    ss << "\"familyName\":\"" << escapeJsonString(reopenedFamilyName) << "\",";
    ss << "\"isEmbedded\":" << (reopenedIsEmbedded ? "true" : "false") << ",";
    ss << "\"isSubset\":" << (reopenedIsSubset ? "true" : "false") << ",";
    ss << "\"weight\":" << (reopenedFontWeight >= 0 ? std::to_string(reopenedFontWeight) : "null") << ",";
    ss << "\"flags\":" << (reopenedFontFlags >= 0 ? std::to_string(reopenedFontFlags) : "null");
    ss << "},";

    ss << "\"reopenedObject\":{";
    ss << "\"id\":\"" << reopenedObjId << "\",";
    ss << "\"text\":\"" << escapeJsonString(reopenedText) << "\",";
    ss << "\"bounds\":{\"x\":" << reopenedX << ",\"y\":" << reopenedY << ",\"width\":" << reopenedW << ",\"height\":" << reopenedH << "},";
    ss << "\"pdfBounds\":{\"left\":" << repLeft << ",\"bottom\":" << repBottom << ",\"right\":" << repRight << ",\"top\":" << repTop << "},";
    ss << "\"fontSize\":" << (reopenedFontSize > 0 ? std::to_string(reopenedFontSize) : "null") << ",";
    ss << "\"fontName\":\"" << escapeJsonString(reopenedFontName) << "\",";
    ss << "\"color\":\"" << reopenedColor << "\",";
    ss << "\"colorRgba\":{\"r\":" << repR << ",\"g\":" << repG << ",\"b\":" << repB << ",\"a\":" << repA << "},";
    if (hasRepMatrix) {
        ss << "\"matrix\":{\"a\":" << repMatrix.a << ",\"b\":" << repMatrix.b
           << ",\"c\":" << repMatrix.c << ",\"d\":" << repMatrix.d
           << ",\"e\":" << repMatrix.e << ",\"f\":" << repMatrix.f << "}";
    } else {
        ss << "\"matrix\":null";
    }
    ss << "},";

    ss << "\"preservedProperties\":{";
    ss << "\"pageIndex\":true,";
    ss << "\"position\":" << (reopenedW > 0 ? "true" : "false") << ",";
    ss << "\"fontSize\":" << (reopenedFontSize > 0 ? "true" : "false") << ",";
    ss << "\"color\":" << (!reopenedColor.empty() ? "true" : "false") << ",";
    ss << "\"matrix\":" << (hasRepMatrix ? "true" : "false") << ",";
    ss << "\"fontName\":" << (!reopenedFontName.empty() ? "true" : "false") << ",";
    ss << "\"fontResourceReused\":" << (fontReused ? "true" : "false") << ",";
    ss << "\"fontStrategy\":\"" << escapeJsonString(fontStrategy) << "\"";
    ss << "},";

    ss << "\"limitations\":[";
    for (size_t l = 0; l < limitations.size(); ++l) {
        if (l > 0) ss << ",";
        ss << "\"" << escapeJsonString(limitations[l]) << "\"";
    }
    ss << "]";

    ss << "}";

    std::string outJson = ss.str();
    return outJson;
}

std::string applyBatchEditsJson(const std::string& inputPath, const std::string& outputPath,
                                const std::string& editsJson) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();

    auto makeErrorJson = [&](const std::string& code, const std::string& msg) -> std::string {
        std::string json = "{\"success\":false,\"errorCode\":\"" + escapeJsonString(code) +
                           "\",\"errorMessage\":\"" + escapeJsonString(msg) + "\"}";
        return json;
    };



    if (inputPath == outputPath) {
        return makeErrorJson("SAME_INPUT_OUTPUT", "Input path and output path must be different to preserve source immutability");
    }

    // A malformed batch is an error, never a silent zero-command copy. "[]" (copyDocument)
    // is valid and yields zero commands.
    std::vector<EditCommand> commands;
    std::string parseError;
    if (!pie::parseEditCommands(editsJson, commands, parseError)) {
        return makeErrorJson("INVALID_EDITS_JSON", "Edit batch JSON could not be parsed: " + parseError);
    }

    // 1. Source immutability verification: Checksum before operation
    std::string hashBefore = computeFileChecksum(inputPath);
    if (hashBefore.empty()) {
        return makeErrorJson("PDF_FILE_NOT_FOUND", "Input PDF file not found or inaccessible: " + inputPath);
    }

    // 2. Open source document
    FPDF_DOCUMENT doc = FPDF_LoadDocument(inputPath.c_str(), nullptr);
    if (!doc) {
        unsigned long err = FPDF_GetLastError();
        return makeErrorJson("PDF_OPEN_FAILED", "Failed to open source PDF, error code: " + std::to_string(err));
    }

    int pageCountBefore = FPDF_GetPageCount(doc);

    // 3. Group commands by pageIndex
    std::map<int, std::vector<size_t>> pageToCmdIndices;
    for (size_t ci = 0; ci < commands.size(); ++ci) {
        int p = commands[ci].pageIndex;
        if (p < 0 || p >= pageCountBefore) {
            FPDF_CloseDocument(doc);
            return makeErrorJson("PDF_PAGE_OUT_OF_RANGE", "Page index " + std::to_string(p) + " is out of range [0, " + std::to_string(pageCountBefore - 1) + "]");
        }
        pageToCmdIndices[p].push_back(ci);
    }

    struct CommandResult {
        std::string type;
        std::string objectId;
        int pageIndex = 0;
        int objectIndex = 0;
        std::string originalText;
        std::string newText;
        bool applied = false;
        std::string fontStrategy;
        bool fontReused = false;
        std::string error;
        std::vector<std::string> unsupportedFormatting;
        bool verifiedInReopened = false;
        std::string verificationError;
        // Reopen verification bookkeeping
        std::string preText;                     // text of the targeted object before editing
        FPDF_PAGEOBJECT resultObject = nullptr;  // object holding the edit (valid until page close)
        std::vector<int> expectedPath;           // location of resultObject in the saved page
        bool hasExpectedPath = false;
        long supersededBy = -1;                  // later command in this batch that replaced/deleted resultObject
    };

    // Text of every text object per edited page before editing (verification baseline)
    std::map<int, std::vector<std::string>> beforeTextsByPage;

    // Marks earlier commands whose edited object is edited again (or deleted) by `ci`.
    auto supersedeEarlierEdits = [](std::vector<CommandResult>& all, const std::vector<size_t>& indices,
                                     size_t ci, FPDF_PAGEOBJECT object) {
        for (size_t other : indices) {
            if (other != ci && all[other].resultObject == object) {
                all[other].supersededBy = static_cast<long>(ci);
                all[other].resultObject = nullptr;
            }
        }
    };

    std::vector<CommandResult> results(commands.size());
    for (size_t ci = 0; ci < commands.size(); ++ci) {
        results[ci].type = commands[ci].type;
        results[ci].objectId = commands[ci].objectId;
        results[ci].pageIndex = commands[ci].pageIndex;
        results[ci].objectIndex = commands[ci].objectIndex;
        results[ci].originalText = commands[ci].originalText;
        results[ci].newText = commands[ci].newText;
    }

    // 4. Process each page with edits
    for (auto& entry : pageToCmdIndices) {
        int pageIndex = entry.first;
        const auto& cmdIndices = entry.second;

        FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
        if (!page) {
            FPDF_CloseDocument(doc);
            return makeErrorJson("PDF_PAGE_LOAD_FAILED", "Failed to load page " + std::to_string(pageIndex));
        }

        // User space -> displayed page (rotation / crop box), used to orient inserted text
        const FS_MATRIX pageDisplay = pageDisplayMatrix(doc, page, pageIndex);

        // Objects detached by font substitution; freed once the page's edits are finished
        std::vector<FPDF_PAGEOBJECT> detachedObjects;

        // Map command index -> target FPDF_PAGEOBJECT (for replace and delete)
        std::map<size_t, ResolvedObjectPath> resolvedObjects;
        for (size_t ci : cmdIndices) {
            if (commands[ci].type == "insert") continue;
            std::vector<int> path = commands[ci].objectPath;
            if (path.empty()) path.push_back(commands[ci].objectIndex);
            ResolvedObjectPath resolved;
            if (!resolveObjectPath(page, path, resolved)) {
                results[ci].error = "Object locator path could not be resolved";
                continue;
            }
            if (FPDFPageObj_GetType(resolved.object) != FPDF_PAGEOBJ_TEXT) {
                results[ci].error = "Object locator path does not resolve to a text object";
                continue;
            }
            resolvedObjects[ci] = resolved;
        }

        // Text inside a Form XObject: convert the enclosing (outermost) form into page content
        // first, so the edit is actually written on save. Resolved object pointers stay valid.
        for (auto& resolvedEntry : resolvedObjects) {
            if (!resolvedEntry.second.parentForm) continue;
            FPDF_PAGEOBJECT target = resolvedEntry.second.object;
            std::vector<int> where;
            std::string flattenError;
            bool ok = true;
            while (ok && locateObjectPath(page, target, where) && where.size() > 1) {
                ok = flattenRootForm(page, FPDFPage_GetObject(page, where[0]), flattenError);
            }
            if (!ok) {
                results[resolvedEntry.first].error = flattenError;
                continue;
            }
            resolvedEntry.second.parentForm = nullptr;
            commands[resolvedEntry.first].objectPath = where;
        }
        for (auto it = resolvedObjects.begin(); it != resolvedObjects.end();) {
            if (!results[it->first].error.empty()) it = resolvedObjects.erase(it);
            else ++it;
        }

        // Pre-edit snapshot for reopen verification: text of every text object on the page
        // (whole object tree) and of each targeted object. The text page is closed before
        // any object is modified.
        {
            FPDF_TEXTPAGE preTextPage = FPDFText_LoadPage(page);
            std::vector<std::string>& beforeTexts = beforeTextsByPage[pageIndex];
            const int rootCount = FPDFPage_CountObjects(page);
            for (int i = 0; i < rootCount; ++i) {
                collectTextObjectStrings(FPDFPage_GetObject(page, i), preTextPage, beforeTexts);
            }
            for (const auto& resolvedEntry : resolvedObjects) {
                std::vector<int> path = commands[resolvedEntry.first].objectPath;
                if (path.empty()) path.push_back(commands[resolvedEntry.first].objectIndex);
                std::string text;
                if (extractTextAtPath(page, preTextPage, path, text)) {
                    results[resolvedEntry.first].preText = text;
                }
            }
            if (preTextPage) FPDFText_ClosePage(preTextPage);
        }

        // Execute Replacements on this page
        for (size_t ci : cmdIndices) {
            if (commands[ci].type != "replace") continue;
            auto it = resolvedObjects.find(ci);
            if (it == resolvedObjects.end()) continue;
            FPDF_PAGEOBJECT targetObj = it->second.object;
            FPDF_PAGEOBJECT parentForm = it->second.parentForm;

            if (commands[ci].newText.empty()) {
                results[ci].error = "Replacement text cannot be empty";
                continue;
            }

            std::vector<FPDF_WCHAR> wideRep = utf8ToUtf16(commands[ci].newText);
            bool replaced = false;
            FPDF_PAGEOBJECT editedObject = nullptr;

            // Inspect original font details
            FPDF_FONT origFont = FPDFTextObj_GetFont(targetObj);
            std::string origFontName;
            bool origIsEmbedded = false;
            bool origIsSubset = false;
            int origFontWeight = -1;
            if (origFont) {
                size_t fnLen = FPDFFont_GetBaseFontName(origFont, nullptr, 0);
                if (fnLen > 0) {
                    std::vector<char> fnBuf(fnLen + 1, 0);
                    FPDFFont_GetBaseFontName(origFont, fnBuf.data(), fnLen);
                    origFontName = fnBuf.data();
                }
                origIsEmbedded = (FPDFFont_GetIsEmbedded(origFont) == 1);
                origIsSubset = isSubsetFont(origFontName);
                origFontWeight = FPDFFont_GetWeight(origFont);
            }

            // Check if font change (style/family) is requested
            bool fontChangeRequested = (commands[ci].hasBold || commands[ci].hasItalic || !commands[ci].fontFamily.empty());

            // If font change requested on nested Form XObject:
            if (fontChangeRequested && parentForm) {
                results[ci].error = "Nested Form XObject text cannot change font family or bold/italic style. Native PDFium cannot insert replacement objects into Form XObjects.";
                results[ci].unsupportedFormatting.push_back("Font family/style change on nested Form XObject is unsupported");
                continue;
            }

            // If embedded subset font and font change requested:
            if (fontChangeRequested && (origIsSubset || origIsEmbedded)) {
                results[ci].error = "Cannot substitute font family or bold/italic on embedded subset font (" + origFontName + "). Font substitution on subset fonts destroys typographic fidelity.";
                results[ci].unsupportedFormatting.push_back("Font style change on embedded subset font is unsupported");
                continue;
            }

            // Phase 15 glyph safety: the original font must contain every new character
            // (characters it already renders in this object are trusted). Otherwise the edit
            // fails clearly instead of producing missing/substituted glyphs.
            if (!fontChangeRequested) {
                const std::vector<uint32_t> missing = findMissingGlyphs(origFont, commands[ci].newText, results[ci].preText);
                if (!missing.empty()) {
                    results[ci].error = unsupportedGlyphsMessage(
                        missing, "The original font" + (origFontName.empty() ? std::string() : " (" + origFontName + ")"));
                    continue;
                }
            }

            // Reflow: the run that follows the object on its line, before the edit
            PieBox reflowOld;
            const bool canReflow = commands[ci].reflow && !parentForm && pieUprightTextBox(targetObj, reflowOld);
            std::vector<std::pair<FPDF_PAGEOBJECT, PieBox>> reflowRun;
            if (canReflow) reflowRun = pieFollowingRun(page, reflowOld, reflowOld.r, {targetObj});

            // Strategy 1: Direct in-place replacement (reusing original font resource)
            if (!fontChangeRequested && FPDFText_SetText(targetObj, (FPDF_WIDESTRING)wideRep.data())) {
                if (commands[ci].hasFontSize && commands[ci].fontSize > 0) {
                    FPDFTextObj_SetFontSize(targetObj, static_cast<float>(commands[ci].fontSize));
                }
                if (commands[ci].hasColor) {
                    FPDFPageObj_SetFillColor(targetObj, commands[ci].colorR, commands[ci].colorG, commands[ci].colorB, commands[ci].colorA);
                }
                replaced = true;
                editedObject = targetObj;
                results[ci].fontStrategy = "REUSED_ORIGINAL";
                results[ci].fontReused = true;
            } else if (parentForm) {
                results[ci].error = "Nested Form XObject text replacement failed: glyph not available in original font resource";
            } else {
                // Strategy 2: Reconstruct text object with requested or fallback font (root-level only)
                // Standard 14 fonts only cover WinAnsi: anything else would render as missing glyphs.
                const std::vector<uint32_t> nonWinAnsi = pie::findNonWinAnsiCodePoints(commands[ci].newText);
                if (!nonWinAnsi.empty()) {
                    results[ci].error = unsupportedGlyphsMessage(nonWinAnsi, "The standard PDF fonts");
                    continue;
                }
                float fontSizeToUse = 12.0f;
                if (commands[ci].hasFontSize && commands[ci].fontSize > 0) {
                    fontSizeToUse = static_cast<float>(commands[ci].fontSize);
                } else {
                    FPDFTextObj_GetFontSize(targetObj, &fontSizeToUse);
                }

                FS_MATRIX matrix;
                bool hasMatrix = FPDFPageObj_GetMatrix(targetObj, &matrix);

                unsigned int r = 0, g = 0, b = 0, a = 255;
                if (commands[ci].hasColor) {
                    r = commands[ci].colorR;
                    g = commands[ci].colorG;
                    b = commands[ci].colorB;
                    a = commands[ci].colorA;
                } else {
                    FPDFPageObj_GetFillColor(targetObj, &r, &g, &b, &a);
                }

                std::string targetFontName = "Helvetica";
                if (!commands[ci].fontFamily.empty()) {
                    targetFontName = commands[ci].fontFamily;
                } else if (!origFontName.empty()) {
                    targetFontName = origFontName;
                }

                bool wantBold = commands[ci].hasBold ? commands[ci].isBold : (origFontWeight >= 700 || origFontName.find("Bold") != std::string::npos);
                bool wantItalic = commands[ci].hasItalic ? commands[ci].isItalic : (origFontName.find("Italic") != std::string::npos || origFontName.find("Oblique") != std::string::npos);

                std::string resolvedStandard = resolveStandardFontNameCpp(targetFontName, wantBold, wantItalic);
                FPDF_FONT repFont = FPDFText_LoadStandardFont(doc, resolvedStandard.c_str());
                if (!repFont) {
                    repFont = FPDFText_LoadStandardFont(doc, "Helvetica");
                }

                if (repFont) {
                    FPDF_PAGEOBJECT newTextObj = FPDFPageObj_CreateTextObj(doc, repFont, fontSizeToUse);
                    if (newTextObj) {
                        if (FPDFText_SetText(newTextObj, (FPDF_WIDESTRING)wideRep.data())) {
                            if (hasMatrix) FPDFPageObj_SetMatrix(newTextObj, &matrix);
                            FPDFPageObj_SetFillColor(newTextObj, r, g, b, a);
                            if (replaceRootObjectInPlace(page, targetObj, newTextObj)) {
                                detachedObjects.push_back(targetObj);
                                replaced = true;
                                editedObject = newTextObj;
                                results[ci].fontStrategy = "LOADED_STANDARD";
                                results[ci].fontReused = false;
                            } else {
                                FPDFPageObj_Destroy(newTextObj);
                                results[ci].error = "The substituted text object could not replace the original";
                            }
                        } else {
                            FPDFPageObj_Destroy(newTextObj);
                        }
                    }
                    FPDFFont_Close(repFont);
                }
            }

            if (replaced && canReflow) {
                PieBox reflowNew;
                if (pieUprightTextBox(editedObject, reflowNew)) pieShiftRun(reflowRun, reflowNew.r - reflowOld.r);
            }

            if (replaced) {
                supersedeEarlierEdits(results, cmdIndices, ci, targetObj);
                results[ci].applied = true;
                results[ci].resultObject = editedObject;
            } else if (results[ci].error.empty()) {
                results[ci].error = "FPDFText_SetText failed on object";
            }
        }

        // Execute Deletions on this page
        std::vector<PieBox> reflowDeleted;  // boxes of reflow deletions (page space, before removal)
        for (size_t ci : cmdIndices) {
            if (commands[ci].type != "delete") continue;
            auto it = resolvedObjects.find(ci);
            if (it == resolvedObjects.end()) continue;
            FPDF_PAGEOBJECT targetObj = it->second.object;
            FPDF_PAGEOBJECT parentForm = it->second.parentForm;
            PieBox deletedBox;
            const bool reflowThis = commands[ci].reflow && !parentForm && pieUprightTextBox(targetObj, deletedBox);

            const bool removed = parentForm
                ? FPDFFormObj_RemoveObject(parentForm, targetObj)
                : FPDFPage_RemoveObject(page, targetObj);
            if (removed) {
                supersedeEarlierEdits(results, cmdIndices, ci, targetObj);
                FPDFPageObj_Destroy(targetObj);
                results[ci].applied = true;
                if (reflowThis) reflowDeleted.push_back(deletedBox);
            } else {
                results[ci].error = parentForm
                    ? "FPDFFormObj_RemoveObject failed"
                    : "FPDFPage_RemoveObject failed";
            }
        }

        // Reflow deletions: per line, contiguous deleted spans close up. The first remaining text
        // after a span moves to where the span started (exact for whole words, whatever the
        // glyph side bearings), carrying the rest of its run. Spans are processed right to left
        // so shifts accumulate correctly.
        if (!reflowDeleted.empty()) {
            std::sort(reflowDeleted.begin(), reflowDeleted.end(),
                      [](const PieBox& x, const PieBox& y) { return x.l < y.l; });
            std::vector<std::pair<PieBox, std::vector<PieBox>>> lines;  // line box, its boxes
            for (const PieBox& box : reflowDeleted) {
                bool placed = false;
                for (auto& line : lines) {
                    if (pieSameLine(line.first, box)) {
                        line.second.push_back(box);
                        placed = true;
                        break;
                    }
                }
                if (!placed) lines.push_back({box, {box}});
            }
            for (auto& line : lines) {
                // Merge into spans: consecutive deleted boxes with no remaining text between them
                std::vector<PieBox> spans;
                for (const PieBox& box : line.second) {
                    if (!spans.empty()) {
                        PieBox& last = spans.back();
                        auto between = pieFollowingRun(page, line.first, last.r, {});
                        const bool remainingBetween =
                            !between.empty() && between.front().second.l < box.l - 0.5f;
                        if (!remainingBetween) {
                            last.r = std::max(last.r, box.r);
                            last.b = std::min(last.b, box.b);
                            last.t = std::max(last.t, box.t);
                            continue;
                        }
                    }
                    spans.push_back(box);
                }
                for (auto span = spans.rbegin(); span != spans.rend(); ++span) {
                    auto run = pieFollowingRun(page, line.first, span->r, {});
                    if (run.empty()) continue;
                    // The gaps on both sides of the span collapse into one; the larger is kept,
                    // so removing the start or end of a letter-spaced word (or the pieces after a
                    // replaced part) keeps the word gap instead of the letter gap.
                    float target = span->l;
                    float prevRight = 0;
                    if (pieLeftNeighbourRight(page, line.first, span->l, prevRight)) {
                        const float gapBefore = std::max(0.0f, span->l - prevRight);
                        const float gapAfter = std::max(0.0f, run.front().second.l - span->r);
                        target = prevRight + std::max(gapBefore, gapAfter);
                    }
                    pieShiftRun(run, target - run.front().second.l);
                }
            }
        }

        // Execute Insertions on this page
        for (size_t ci : cmdIndices) {
            if (commands[ci].type != "insert") continue;
            if (commands[ci].text.empty()) {
                results[ci].error = "Inserted text cannot be empty";
                continue;
            }
            {
                // Inserted text uses a standard 14 font (WinAnsi only).
                const std::vector<uint32_t> nonWinAnsi = pie::findNonWinAnsiCodePoints(commands[ci].text);
                if (!nonWinAnsi.empty()) {
                    results[ci].error = unsupportedGlyphsMessage(nonWinAnsi, "The standard PDF fonts");
                    continue;
                }
            }

            std::string fontName = commands[ci].fontName.empty() ? "Helvetica" : commands[ci].fontName;
            FPDF_FONT insertFont = FPDFText_LoadStandardFont(doc, fontName.c_str());
            if (!insertFont) {
                insertFont = FPDFText_LoadStandardFont(doc, "Helvetica");
            }
            if (!insertFont) {
                results[ci].error = "Failed to load standard font for insertion";
                continue;
            }

            float fontSize = static_cast<float>(commands[ci].fontSize > 0 ? commands[ci].fontSize : 14.0);
            FPDF_PAGEOBJECT newObj = FPDFPageObj_CreateTextObj(doc, insertFont, fontSize);
            if (!newObj) {
                results[ci].error = "FPDFPageObj_CreateTextObj failed";
                FPDFFont_Close(insertFont);
                continue;
            }

            std::vector<FPDF_WCHAR> wideText = utf8ToUtf16(commands[ci].text);
            if (!FPDFText_SetText(newObj, (FPDF_WIDESTRING)wideText.data())) {
                FPDFPageObj_Destroy(newObj);
                FPDFFont_Close(insertFont);
                results[ci].error = "FPDFText_SetText failed on inserted object";
                continue;
            }

            // Set fill color
            FPDFPageObj_SetFillColor(newObj, commands[ci].colorR, commands[ci].colorG, commands[ci].colorB, commands[ci].colorA);

            // Position at the user-space baseline origin (x, y). On rotated pages the text is
            // counter-rotated so it reads upright in the displayed page; unrotated pages get the
            // identity basis (1, 0, 0, 1) exactly as before.
            float ta = 1, tb = 0, tc = 0, td = 1;
            uprightTextBasis(pageDisplay, ta, tb, tc, td);
            FPDFPageObj_Transform(newObj, ta, tb, tc, td, commands[ci].x, commands[ci].y);

            if (FPDFPage_InsertObject(page, newObj)) {
                results[ci].applied = true;
                results[ci].resultObject = newObj;
                results[ci].fontStrategy = "LOADED_STANDARD";
                results[ci].newText = commands[ci].text;
            } else {
                FPDFPageObj_Destroy(newObj);
                results[ci].error = "FPDFPage_InsertObject failed";
            }
            FPDFFont_Close(insertFont);
        }

        // Regenerate page content once per modified page. A failure here would save a page whose
        // content stream does not reflect the edits, so it fails the whole batch.
        if (!FPDFPage_GenerateContent(page)) {
            for (FPDF_PAGEOBJECT o : detachedObjects) FPDFPageObj_Destroy(o);
            FPDF_ClosePage(page);
            FPDF_CloseDocument(doc);
            return makeErrorJson("GENERATE_CONTENT_FAILED",
                                 "FPDFPage_GenerateContent failed to rebuild page " + std::to_string(pageIndex));
        }

        // Record where each edited object sits in the page's object tree (content is written
        // in this order, so the reopened page has the same structure). Object pointers are
        // never used after the page is closed.
        for (size_t ci : cmdIndices) {
            if (!results[ci].applied || !results[ci].resultObject) continue;
            results[ci].hasExpectedPath = locateObjectPath(page, results[ci].resultObject, results[ci].expectedPath);
            results[ci].resultObject = nullptr;
        }

        // Nothing refers to the substituted originals any more (same document, still open)
        for (FPDF_PAGEOBJECT o : detachedObjects) FPDFPageObj_Destroy(o);
        detachedObjects.clear();

        FPDF_ClosePage(page);
    }

    // 5. Save modified document once to output path
    FILE* fp = fopen(outputPath.c_str(), "wb");
    if (!fp) {
        FPDF_CloseDocument(doc);
        return makeErrorJson("OUTPUT_FILE_CREATE_FAILED", "Failed to create output file: " + outputPath);
    }

    CustomFileWriter writer(fp);
    FPDF_BOOL okSave = FPDF_SaveAsCopy(doc, &writer, 0);
    fclose(fp);
    FPDF_CloseDocument(doc);

    if (!okSave) {
        return makeErrorJson("PDF_SAVE_FAILED", "FPDF_SaveAsCopy failed to save edited document");
    }

    // 6. Source immutability check
    std::string hashAfter = computeFileChecksum(inputPath);
    bool sourceUnchanged = (!hashBefore.empty() && hashBefore == hashAfter);

    // 7. Reopen generated document and verify all replacements, deletions, and insertions
    FPDF_DOCUMENT newDoc = FPDF_LoadDocument(outputPath.c_str(), nullptr);
    if (!newDoc) {
        return makeErrorJson("REOPEN_FAILED", "Could not reopen saved output PDF with PDFium");
    }

    int pageCountAfter = FPDF_GetPageCount(newDoc);

    // Verify every applied command against the reopened document: the edited object itself
    // (located by its recorded object path) must hold exactly the requested text, and exact
    // occurrence counts on the page must match the expected result, so duplicate text
    // elsewhere on the page cannot produce a false verification (see pie::verifyPageEdits).
    for (auto& entry : pageToCmdIndices) {
        int pageIndex = entry.first;
        const auto& cmdIndices = entry.second;

        std::vector<size_t> verifyIndices;
        for (size_t ci : cmdIndices) {
            if (results[ci].applied && results[ci].supersededBy < 0) verifyIndices.push_back(ci);
        }
        if (verifyIndices.empty()) continue;

        if (pageCountAfter != pageCountBefore) {
            for (size_t ci : verifyIndices) {
                results[ci].verificationError = "Reopened document page count differs from the source";
            }
            continue;
        }

        FPDF_PAGE newPage = FPDF_LoadPage(newDoc, pageIndex);
        if (!newPage) {
            for (size_t ci : verifyIndices) {
                results[ci].verificationError = "Edited page could not be loaded from the reopened document";
            }
            continue;
        }

        FPDF_TEXTPAGE newTextPage = FPDFText_LoadPage(newPage);
        std::vector<std::string> afterTexts;
        const int newRootObjectCount = FPDFPage_CountObjects(newPage);
        for (int i = 0; i < newRootObjectCount; ++i) {
            collectTextObjectStrings(FPDFPage_GetObject(newPage, i), newTextPage, afterTexts);
        }

        std::vector<pie::PageVerifyInput> inputs(verifyIndices.size());
        for (size_t k = 0; k < verifyIndices.size(); ++k) {
            const CommandResult& r = results[verifyIndices[k]];
            inputs[k].type = r.type;
            inputs[k].preText = r.preText;
            inputs[k].newText = r.newText;
            if ((r.type == "replace" || r.type == "insert") && r.hasExpectedPath) {
                inputs[k].objectFound = extractTextAtPath(newPage, newTextPage, r.expectedPath, inputs[k].objectText);
            }
        }
        pie::verifyPageEdits(beforeTextsByPage[pageIndex], afterTexts, inputs);
        for (size_t k = 0; k < verifyIndices.size(); ++k) {
            results[verifyIndices[k]].verifiedInReopened = inputs[k].verified;
            results[verifyIndices[k]].verificationError = inputs[k].error;
        }

        if (newTextPage) FPDFText_ClosePage(newTextPage);
        FPDF_ClosePage(newPage);
    }

    // An edit superseded within this batch (its object was edited again or deleted by a later
    // command) is verified through the command that superseded it.
    for (size_t ci = 0; ci < results.size(); ++ci) {
        if (!results[ci].applied || results[ci].supersededBy < 0) continue;
        size_t last = static_cast<size_t>(results[ci].supersededBy);
        for (size_t guard = 0; guard < results.size() && results[last].supersededBy >= 0; ++guard) {
            last = static_cast<size_t>(results[last].supersededBy);
        }
        results[ci].verifiedInReopened = results[last].verifiedInReopened;
        results[ci].verificationError = results[last].verificationError;
    }

    FPDF_CloseDocument(newDoc);

    // 8. Serialize structured JSON result
    std::ostringstream ss;
    ss << "{";
    ss << "\"success\":true,";
    ss << "\"inputPath\":\"" << escapeJsonString(inputPath) << "\",";
    ss << "\"outputPath\":\"" << escapeJsonString(outputPath) << "\",";
    ss << "\"commandsApplied\":" << commands.size() << ",";
    ss << "\"sourceUnchanged\":" << (sourceUnchanged ? "true" : "false") << ",";
    ss << "\"sourceShaBefore\":\"" << hashBefore << "\",";
    ss << "\"sourceShaAfter\":\"" << hashAfter << "\",";
    ss << "\"pageCountBefore\":" << pageCountBefore << ",";
    ss << "\"pageCountAfter\":" << pageCountAfter << ",";

    ss << "\"commandResults\":[";
    for (size_t ci = 0; ci < results.size(); ++ci) {
        if (ci > 0) ss << ",";
        ss << "{";
        ss << "\"type\":\"" << escapeJsonString(results[ci].type) << "\",";
        ss << "\"objectId\":\"" << escapeJsonString(results[ci].objectId) << "\",";
        ss << "\"pageIndex\":" << results[ci].pageIndex << ",";
        ss << "\"objectIndex\":" << results[ci].objectIndex << ",";
        ss << "\"originalText\":\"" << escapeJsonString(results[ci].originalText) << "\",";
        ss << "\"newText\":\"" << escapeJsonString(results[ci].newText) << "\",";
        ss << "\"applied\":" << (results[ci].applied ? "true" : "false") << ",";
        ss << "\"verifiedInReopened\":" << (results[ci].verifiedInReopened ? "true" : "false") << ",";
        ss << "\"verificationError\":\"" << escapeJsonString(results[ci].verificationError) << "\",";
        ss << "\"fontStrategy\":\"" << escapeJsonString(results[ci].fontStrategy) << "\",";
        ss << "\"fontReused\":" << (results[ci].fontReused ? "true" : "false") << ",";
        ss << "\"error\":\"" << escapeJsonString(results[ci].error) << "\"";
        ss << "}";
    }
    ss << "]";

    ss << "}";

    std::string outJson = ss.str();
    return outJson;
}

std::string applyDocumentOperationsJson(const std::string& inputPath, const std::string& outputPath,
                                        const std::string& opsJson) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();
    return pie_pdf::applyDocumentOperationsJson(inputPath, outputPath, opsJson);
}

std::string mergeDocumentsJson(const std::string& inputsJson, const std::string& outputPath) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();
    return pie_pdf::mergeDocumentsJson(inputsJson, outputPath);
}

std::string createPdfFromImagesJson(const std::string& specJson, const std::string& outputPath) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();
    return pie_pdf::createPdfFromImagesJson(specJson, outputPath);
}

std::string searchDocumentJson(int64_t docHandle, const std::string& query, int maxResults) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return pie_pdf::searchDocumentJson(getDoc(docHandle), query, maxResults);
}

std::string pageTextJson(int64_t docHandle, int pageIndex) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return pie_pdf::pageTextJson(getDoc(docHandle), pageIndex);
}

}  // namespace pie_engine


namespace {

void pieIndexObjects(FPDF_PAGEOBJECT object, std::vector<int>& path,
                     std::unordered_map<FPDF_PAGEOBJECT, std::vector<int>>& out) {
    if (!object) return;
    const int type = FPDFPageObj_GetType(object);
    if (type == FPDF_PAGEOBJ_TEXT) {
        out[object] = path;
        return;
    }
    if (type != FPDF_PAGEOBJ_FORM) return;
    const int n = FPDFFormObj_CountObjects(object);
    for (int i = 0; i < n; ++i) {
        path.push_back(i);
        pieIndexObjects(FPDFFormObj_GetObject(object, static_cast<unsigned long>(i)), path, out);
        path.pop_back();
    }
}

}  // namespace

namespace pie_engine {

/**
 * Characters of a page in reading order (PDFium text page), for character-level selection:
 *   {"pageIndex":n,"objects":["p0_path3", ...],
 *    "chars":[[codepoint, x, y, w, h, baselineY, objectIdx, offsetInObject, generated], ...]}
 * Boxes are display-space (rotation / crop box applied, top-left origin) loose character boxes
 * (font ascent to descent, so a line's characters share top and bottom); baselineY is the
 * display-space y of the character origin. objectIdx indexes "objects" (ids identical to
 * getTextObjectsJson) or is -1 for characters PDFium generated (spaces / line breaks between
 * runs). offsetInObject counts the object's own characters in reading order.
 */
std::string pageCharsJson(int64_t docHandle, int pageIndex) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) return "{\"pageIndex\":" + std::to_string(pageIndex) + ",\"objects\":[],\"chars\":[]}";
    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) return "{\"pageIndex\":" + std::to_string(pageIndex) + ",\"objects\":[],\"chars\":[]}";
    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    const FS_MATRIX display = pageDisplayMatrix(doc, page, pageIndex);

    std::unordered_map<FPDF_PAGEOBJECT, std::vector<int>> paths;
    {
        std::vector<int> path;
        const int rootCount = FPDFPage_CountObjects(page);
        for (int i = 0; i < rootCount; ++i) {
            path.assign(1, i);
            pieIndexObjects(FPDFPage_GetObject(page, i), path, paths);
        }
    }

    std::unordered_map<FPDF_PAGEOBJECT, int> objectIndex;
    std::unordered_map<FPDF_PAGEOBJECT, int> objectOffset;
    std::vector<std::string> objectIds;
    std::ostringstream chars;
    chars << std::fixed << std::setprecision(2);
    const int count = textPage ? FPDFText_CountChars(textPage) : 0;
    bool first = true;
    for (int i = 0; i < count; ++i) {
        const unsigned int cp = FPDFText_GetUnicode(textPage, i);
        FS_RECTF r{0, 0, 0, 0};
        if (!FPDFText_GetLooseCharBox(textPage, i, &r)) continue;
        float dl, db, dr, dt;
        transformBounds(display, r.left, r.bottom, r.right, r.top, dl, db, dr, dt);
        double ox = 0, oy = 0;
        float bx = 0, by = dt;
        if (FPDFText_GetCharOrigin(textPage, i, &ox, &oy)) {
            transformPoint(display, static_cast<float>(ox), static_cast<float>(oy), bx, by);
        }
        const bool generated = FPDFText_IsGenerated(textPage, i) == 1;
        int objIdx = -1;
        int offset = 0;
        if (!generated) {
            FPDF_PAGEOBJECT obj = FPDFText_GetTextObject(textPage, i);
            auto p = obj ? paths.find(obj) : paths.end();
            if (p != paths.end()) {
                auto known = objectIndex.find(obj);
                if (known == objectIndex.end()) {
                    objIdx = static_cast<int>(objectIds.size());
                    objectIndex[obj] = objIdx;
                    objectIds.push_back(objectPathId(pageIndex, p->second));
                } else {
                    objIdx = known->second;
                }
                offset = objectOffset[obj]++;
            }
        }
        if (!first) chars << ",";
        first = false;
        // display rect: transformBounds returns display-space min/max with y "bottom" = min
        chars << "[" << cp << "," << dl << "," << db << "," << (dr - dl) << "," << (dt - db) << "," << by << ","
              << objIdx << "," << offset << "," << (generated ? 1 : 0) << "]";
    }
    if (textPage) FPDFText_ClosePage(textPage);
    FPDF_ClosePage(page);

    std::ostringstream out;
    out << "{\"pageIndex\":" << pageIndex << ",\"objects\":[";
    for (size_t k = 0; k < objectIds.size(); ++k) {
        if (k) out << ",";
        out << "\"" << escapeJsonString(objectIds[k]) << "\"";
    }
    out << "],\"chars\":[" << chars.str() << "]}";
    return out.str();
}

}  // namespace pie_engine

// ---------------------------------------------------------------------------
// Android JNI wrappers (string / bitmap plumbing only; logic is in pie_engine)
// ---------------------------------------------------------------------------
#if defined(__ANDROID__)

namespace {

std::string jniErrorJson(const std::string& code, const std::string& msg) {
    return "{\"success\":false,\"errorCode\":\"" + escapeJsonString(code) +
           "\",\"errorMessage\":\"" + escapeJsonString(msg) + "\"}";
}

// Locks an Android ARGB_8888 bitmap and passes its pixels to `render`.
template <typename Fn>
jboolean withBitmapPixels(JNIEnv* env, jobject jBitmap, Fn render) {
    if (!jBitmap) return JNI_FALSE;
    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, jBitmap, &info) < 0) {
        LOGE("AndroidBitmap_getInfo failed");
        return JNI_FALSE;
    }
    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, jBitmap, &pixels) < 0 || !pixels) {
        LOGE("AndroidBitmap_lockPixels failed");
        return JNI_FALSE;
    }
    const bool ok = render(pixels, static_cast<int>(info.width), static_cast<int>(info.height), static_cast<int>(info.stride));
    AndroidBitmap_unlockPixels(env, jBitmap);
    return ok ? JNI_TRUE : JNI_FALSE;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeInit(JNIEnv* /* env */, jclass /* clazz */) {
    pie_engine::initLibrary();
}

JNIEXPORT void JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeDestroy(JNIEnv* /* env */, jclass /* clazz */) {
    pie_engine::destroyLibrary();
}

JNIEXPORT jlong JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeOpenDocument(
    JNIEnv* env, jclass /* clazz */, jstring jFilePath, jstring jPassword) {
    if (!jFilePath) {
        LOGE("nativeOpenDocument: File path is null");
        return 0;
    }
    const std::string filePath = jstringToUtf8(env, jFilePath);
    const std::string password = jstringToUtf8(env, jPassword);
    return pie_engine::openDocument(filePath, jPassword ? password.c_str() : nullptr);
}

JNIEXPORT void JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeCloseDocument(
    JNIEnv* /* env */, jclass /* clazz */, jlong docHandle) {
    pie_engine::closeDocument(docHandle);
}

JNIEXPORT jint JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageCount(
    JNIEnv* /* env */, jclass /* clazz */, jlong docHandle) {
    return pie_engine::getPageCount(docHandle);
}

JNIEXPORT jdoubleArray JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageSize(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    double width = 0.0, height = 0.0;
    if (!pie_engine::getPageSize(docHandle, pageIndex, width, height)) {
        LOGE("nativeGetPageSize: Failed to get page size for index %d", pageIndex);
        return nullptr;
    }
    jdoubleArray result = env->NewDoubleArray(2);
    jdouble dims[2] = { width, height };
    env->SetDoubleArrayRegion(result, 0, 2, dims);
    return result;
}

JNIEXPORT jboolean JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeRenderPageToBitmap(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex, jobject jBitmap) {
    return withBitmapPixels(env, jBitmap, [&](void* pixels, int w, int h, int stride) {
        // ARGB_8888 stores R,G,B,A in memory: reverse PDFium's BGRA byte order.
        return pie_engine::renderPageToBuffer(docHandle, pageIndex, pixels, w, h, stride, true);
    });
}

JNIEXPORT jdoubleArray JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageGeometry(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    double values[9];
    if (!pie_engine::getPageGeometry(docHandle, pageIndex, values)) return nullptr;
    jdoubleArray result = env->NewDoubleArray(9);
    env->SetDoubleArrayRegion(result, 0, 9, values);
    return result;
}

JNIEXPORT jboolean JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeRenderPageRegionToBitmap(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex, jobject jBitmap,
    jdouble scale, jdouble left, jdouble top) {
    return withBitmapPixels(env, jBitmap, [&](void* pixels, int w, int h, int stride) {
        return pie_engine::renderRegionToBuffer(docHandle, pageIndex, pixels, w, h, stride, scale, left, top, true);
    });
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetTextObjectsJson(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    return utf8ToJstring(env, pie_engine::getTextObjectsJson(docHandle, pageIndex));
}

JNIEXPORT jint JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetLastError(
    JNIEnv* /* env */, jclass /* clazz */) {
    return static_cast<jint>(pie_engine::lastError());
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeReplaceTextObjectJson(
    JNIEnv* env, jclass /* clazz */,
    jstring jInputPath, jstring jOutputPath,
    jint pageIndex, jint objectIndex,
    jstring jReplacementText) {
    if (!jInputPath || !jOutputPath || !jReplacementText) {
        return utf8ToJstring(env, jniErrorJson("INVALID_ARGUMENTS", "Input path, output path, and replacement text must not be null"));
    }
    return utf8ToJstring(env, pie_engine::replaceTextObjectJson(
        jstringToUtf8(env, jInputPath), jstringToUtf8(env, jOutputPath), pageIndex, objectIndex,
        jstringToUtf8(env, jReplacementText)));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeApplyBatchEditsJson(
    JNIEnv* env, jclass /* clazz */,
    jstring jInputPath, jstring jOutputPath,
    jstring jEditsJson) {
    if (!jInputPath || !jOutputPath || !jEditsJson) {
        return utf8ToJstring(env, jniErrorJson("INVALID_ARGUMENTS", "Input path, output path, and edits JSON must not be null"));
    }
    return utf8ToJstring(env, pie_engine::applyBatchEditsJson(
        jstringToUtf8(env, jInputPath), jstringToUtf8(env, jOutputPath), jstringToUtf8(env, jEditsJson)));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeApplyDocumentOperationsJson(
    JNIEnv* env, jclass /* clazz */, jstring jInputPath, jstring jOutputPath, jstring jOpsJson) {
    return utf8ToJstring(env, pie_engine::applyDocumentOperationsJson(
        jstringToUtf8(env, jInputPath), jstringToUtf8(env, jOutputPath), jstringToUtf8(env, jOpsJson)));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeMergeDocumentsJson(
    JNIEnv* env, jclass /* clazz */, jstring jInputsJson, jstring jOutputPath) {
    return utf8ToJstring(env, pie_engine::mergeDocumentsJson(jstringToUtf8(env, jInputsJson), jstringToUtf8(env, jOutputPath)));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeCreatePdfFromImagesJson(
    JNIEnv* env, jclass /* clazz */, jstring jSpecJson, jstring jOutputPath) {
    return utf8ToJstring(env, pie_engine::createPdfFromImagesJson(jstringToUtf8(env, jSpecJson), jstringToUtf8(env, jOutputPath)));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeSearchDocumentJson(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jstring jQuery, jint maxResults) {
    return utf8ToJstring(env, pie_engine::searchDocumentJson(docHandle, jstringToUtf8(env, jQuery), maxResults));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageTextJson(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    return utf8ToJstring(env, pie_engine::pageTextJson(docHandle, pageIndex));
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageCharsJson(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    return utf8ToJstring(env, pie_engine::pageCharsJson(docHandle, pageIndex));
}

} // extern "C"

#endif  // __ANDROID__
