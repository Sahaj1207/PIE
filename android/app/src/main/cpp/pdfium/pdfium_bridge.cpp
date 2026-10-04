#include <jni.h>
#include <android/log.h>
#include <android/bitmap.h>
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

#define TAG "PdfiumBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

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

std::string utf16ToUtf8(const unsigned short* wstr, size_t length) {
    std::string out;
    for (size_t i = 0; i < length; ++i) {
        unsigned int cp = wstr[i];
        if (cp == 0) break;
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < length) {
            unsigned int low = wstr[i + 1];
            if (low >= 0xDC00 && low <= 0xDFFF) {
                cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
                i++;
            }
        }
        if (cp <= 0x7F) {
            out.push_back(static_cast<char>(cp));
        } else if (cp <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | ((cp >> 6) & 0x1F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp <= 0xFFFF) {
            out.push_back(static_cast<char>(0xE0 | ((cp >> 12) & 0x0F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }
    return out;
}

std::string escapeJsonString(const std::string& input) {
    std::string out;
    out.reserve(input.size() + 16);
    for (char c : input) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
                break;
        }
    }
    return out;
}

std::vector<FPDF_WCHAR> utf8ToUtf16(const std::string& utf8) {
    std::vector<FPDF_WCHAR> out;
    size_t i = 0;
    while (i < utf8.size()) {
        uint32_t cp = 0;
        unsigned char c = utf8[i];
        if (c <= 0x7F) {
            cp = c;
            i += 1;
        } else if ((c & 0xE0) == 0xC0) {
            if (i + 1 >= utf8.size()) break;
            cp = ((c & 0x1F) << 6) | (utf8[i + 1] & 0x3F);
            i += 2;
        } else if ((c & 0xF0) == 0xE0) {
            if (i + 2 >= utf8.size()) break;
            cp = ((c & 0x0F) << 12) | ((utf8[i + 1] & 0x3F) << 6) | (utf8[i + 2] & 0x3F);
            i += 3;
        } else if ((c & 0xF8) == 0xF0) {
            if (i + 3 >= utf8.size()) break;
            cp = ((c & 0x07) << 18) | ((utf8[i + 1] & 0x3F) << 12) | ((utf8[i + 2] & 0x3F) << 6) | (utf8[i + 3] & 0x3F);
            i += 4;
        } else {
            i += 1;
            continue;
        }

        if (cp <= 0xFFFF) {
            out.push_back(static_cast<FPDF_WCHAR>(cp));
        } else {
            cp -= 0x10000;
            out.push_back(static_cast<FPDF_WCHAR>(0xD800 + (cp >> 10)));
            out.push_back(static_cast<FPDF_WCHAR>(0xDC00 + (cp & 0x3FF)));
        }
    }
    out.push_back(0);
    return out;
}

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
    if (fam.find("times") != std::string::npos || fam.find("serif") != std::string::npos) {
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

struct EditCommand {
    std::string type; // "replace", "delete", or "insert"
    std::string objectId;
    int pageIndex = 0;
    int objectIndex = 0;
    std::vector<int> objectPath;
    std::string originalText;
    std::string newText;
    std::string text;
    double x = 0.0;
    double y = 0.0;
    double fontSize = 14.0;
    std::string fontName = "Helvetica";
    std::string colorHex;
    int colorR = 0;
    int colorG = 0;
    int colorB = 0;
    int colorA = 255;
    bool hasFontSize = false;
    bool hasColor = false;
    bool hasBold = false;
    bool isBold = false;
    bool hasItalic = false;
    bool isItalic = false;
    std::string fontFamily;
};

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

std::vector<int> extractJsonIntArrayField(const std::string& objStr, const std::string& key) {
    std::vector<int> values;
    const std::string needle = "\"" + key + "\"";
    size_t pos = objStr.find(needle);
    if (pos == std::string::npos) return values;
    pos = objStr.find('[', pos + needle.length());
    if (pos == std::string::npos) return values;
    const size_t close = objStr.find(']', pos + 1);
    if (close == std::string::npos) return values;
    while (++pos < close) {
        while (pos < close && (objStr[pos] == ' ' || objStr[pos] == ',' || objStr[pos] == '\t')) ++pos;
        size_t end = pos;
        if (end < close && objStr[end] == '-') ++end;
        while (end < close && isdigit(objStr[end])) ++end;
        if (end > pos) {
            try {
                values.push_back(std::stoi(objStr.substr(pos, end - pos)));
            } catch (...) {}
        }
        pos = end;
    }
    return values;
}

void parseHexColor(const std::string& hex, int& r, int& g, int& b, int& a) {
    if (hex.empty()) return;
    std::string clean = hex;
    if (clean[0] == '#') clean = clean.substr(1);
    if (clean.length() == 6) {
        try {
            r = std::stoi(clean.substr(0, 2), nullptr, 16);
            g = std::stoi(clean.substr(2, 2), nullptr, 16);
            b = std::stoi(clean.substr(4, 2), nullptr, 16);
            a = 255;
        } catch (...) {}
    } else if (clean.length() == 8) {
        try {
            r = std::stoi(clean.substr(0, 2), nullptr, 16);
            g = std::stoi(clean.substr(2, 2), nullptr, 16);
            b = std::stoi(clean.substr(4, 2), nullptr, 16);
            a = std::stoi(clean.substr(6, 2), nullptr, 16);
        } catch (...) {}
    }
}

std::string extractJsonStringField(const std::string& objStr, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t pos = objStr.find(needle);
    if (pos == std::string::npos) return "";
    pos = objStr.find(':', pos + needle.length());
    if (pos == std::string::npos) return "";
    pos = objStr.find('\"', pos);
    if (pos == std::string::npos) return "";
    size_t start = pos + 1;
    std::string val;
    for (size_t i = start; i < objStr.length(); ++i) {
        if (objStr[i] == '\\' && i + 1 < objStr.length()) {
            val += objStr[i + 1];
            i++;
        } else if (objStr[i] == '\"') {
            break;
        } else {
            val += objStr[i];
        }
    }
    return val;
}

int extractJsonIntField(const std::string& objStr, const std::string& key, int defaultVal = 0) {
    std::string needle = "\"" + key + "\"";
    size_t pos = objStr.find(needle);
    if (pos == std::string::npos) return defaultVal;
    pos = objStr.find(':', pos + needle.length());
    if (pos == std::string::npos) return defaultVal;
    while (pos < objStr.length() && (objStr[pos] == ' ' || objStr[pos] == '\t' || objStr[pos] == ':')) pos++;
    size_t end = pos;
    while (end < objStr.length() && (isdigit(objStr[end]) || objStr[end] == '-')) end++;
    if (end > pos) {
        try {
            return std::stoi(objStr.substr(pos, end - pos));
        } catch (...) {}
    }
    return defaultVal;
}

double extractJsonDoubleField(const std::string& objStr, const std::string& key, double defaultVal = 0.0) {
    std::string needle = "\"" + key + "\"";
    size_t pos = objStr.find(needle);
    if (pos == std::string::npos) return defaultVal;
    pos = objStr.find(':', pos + needle.length());
    if (pos == std::string::npos) return defaultVal;
    while (pos < objStr.length() && (objStr[pos] == ' ' || objStr[pos] == '\t' || objStr[pos] == ':')) pos++;
    size_t end = pos;
    while (end < objStr.length() && (isdigit(objStr[end]) || objStr[end] == '-' || objStr[end] == '.')) end++;
    if (end > pos) {
        try {
            return std::stod(objStr.substr(pos, end - pos));
        } catch (...) {}
    }
    return defaultVal;
}

std::vector<EditCommand> parseEditCommands(const std::string& json) {
    std::vector<EditCommand> commands;
    size_t i = 0;
    while (i < json.length()) {
        size_t openBrace = json.find('{', i);
        if (openBrace == std::string::npos) break;
        int depth = 0;
        size_t closeBrace = std::string::npos;
        bool inQuote = false;
        for (size_t pos = openBrace; pos < json.length(); ++pos) {
            char c = json[pos];
            if (c == '\\' && inQuote && pos + 1 < json.length()) {
                pos++;
                continue;
            }
            if (c == '\"') {
                inQuote = !inQuote;
            } else if (!inQuote) {
                if (c == '{') depth++;
                else if (c == '}') {
                    depth--;
                    if (depth == 0) {
                        closeBrace = pos;
                        break;
                    }
                }
            }
        }
        if (closeBrace == std::string::npos) break;
        std::string objStr = json.substr(openBrace, closeBrace - openBrace + 1);

        EditCommand cmd;
        cmd.type = extractJsonStringField(objStr, "type");
        cmd.objectId = extractJsonStringField(objStr, "objectId");
        cmd.pageIndex = extractJsonIntField(objStr, "pageIndex", 0);
        cmd.objectIndex = extractJsonIntField(objStr, "objectIndex", 0);
        cmd.objectPath = extractJsonIntArrayField(objStr, "objectPath");
        cmd.originalText = extractJsonStringField(objStr, "originalText");
        cmd.newText = extractJsonStringField(objStr, "newText");
        cmd.text = extractJsonStringField(objStr, "text");
        cmd.x = extractJsonDoubleField(objStr, "x", 0.0);
        cmd.y = extractJsonDoubleField(objStr, "y", 0.0);
        cmd.fontSize = extractJsonDoubleField(objStr, "fontSize", 14.0);
        cmd.fontName = extractJsonStringField(objStr, "fontName");
        cmd.colorHex = extractJsonStringField(objStr, "color");
        cmd.colorR = extractJsonIntField(objStr, "colorR", 0);
        cmd.colorG = extractJsonIntField(objStr, "colorG", 0);
        cmd.colorB = extractJsonIntField(objStr, "colorB", 0);
        cmd.colorA = extractJsonIntField(objStr, "colorA", 255);

        if (cmd.colorR == 0 && cmd.colorG == 0 && cmd.colorB == 0 && !cmd.colorHex.empty()) {
            parseHexColor(cmd.colorHex, cmd.colorR, cmd.colorG, cmd.colorB, cmd.colorA);
            cmd.hasColor = true;
        }

        // Check for nested "format" object
        size_t formatPos = objStr.find("\"format\"");
        if (formatPos != std::string::npos) {
            size_t fOpen = objStr.find('{', formatPos);
            if (fOpen != std::string::npos) {
                int fDepth = 0;
                size_t fClose = std::string::npos;
                bool fInQuote = false;
                for (size_t p = fOpen; p < objStr.length(); ++p) {
                    char c = objStr[p];
                    if (c == '\\' && fInQuote && p + 1 < objStr.length()) { p++; continue; }
                    if (c == '\"') fInQuote = !fInQuote;
                    else if (!fInQuote) {
                        if (c == '{') fDepth++;
                        else if (c == '}') {
                            fDepth--;
                            if (fDepth == 0) { fClose = p; break; }
                        }
                    }
                }
                if (fClose != std::string::npos) {
                    std::string formatStr = objStr.substr(fOpen, fClose - fOpen + 1);
                    double fSize = extractJsonDoubleField(formatStr, "fontSize", 0.0);
                    if (fSize > 0) {
                        cmd.hasFontSize = true;
                        cmd.fontSize = fSize;
                    }
                    std::string fColor = extractJsonStringField(formatStr, "color");
                    if (!fColor.empty()) {
                        cmd.hasColor = true;
                        cmd.colorHex = fColor;
                        parseHexColor(fColor, cmd.colorR, cmd.colorG, cmd.colorB, cmd.colorA);
                    }
                    if (formatStr.find("\"isBold\":true") != std::string::npos) {
                        cmd.hasBold = true;
                        cmd.isBold = true;
                    } else if (formatStr.find("\"isBold\":false") != std::string::npos) {
                        cmd.hasBold = true;
                        cmd.isBold = false;
                    }
                    if (formatStr.find("\"isItalic\":true") != std::string::npos) {
                        cmd.hasItalic = true;
                        cmd.isItalic = true;
                    } else if (formatStr.find("\"isItalic\":false") != std::string::npos) {
                        cmd.hasItalic = true;
                        cmd.isItalic = false;
                    }
                    std::string fFamily = extractJsonStringField(formatStr, "fontFamily");
                    if (!fFamily.empty()) {
                        cmd.fontFamily = fFamily;
                    }
                }
            }
        }

        if (!cmd.type.empty()) {
            commands.push_back(cmd);
        }
        i = closeBrace + 1;
    }
    return commands;
}

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

void appendTextObjectJson(
    std::ostringstream& ss,
    bool& first,
    FPDF_PAGEOBJECT object,
    int pageIndex,
    double pageHeight,
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
    ss << "\"bounds\":{\"x\":" << pageLeft << ",\"y\":" << (pageHeight - pageTop)
       << ",\"width\":" << std::abs(pageRight - pageLeft) << ",\"height\":" << std::abs(pageTop - pageBottom) << "},";
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
    double pageHeight,
    FPDF_TEXTPAGE textPage,
    const std::vector<int>& path,
    const FS_MATRIX& parentMatrix,
    std::ostringstream& ss,
    bool& first) {
    if (!object) return;
    const int type = FPDFPageObj_GetType(object);
    if (type == FPDF_PAGEOBJ_TEXT) {
        appendTextObjectJson(ss, first, object, pageIndex, pageHeight, textPage, path, parentMatrix);
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
            pageHeight,
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

FPDF_DOCUMENT getDoc(int64_t handle) {
    auto it = g_documents.find(handle);
    if (it == g_documents.end()) {
        return nullptr;
    }
    return it->second;
}

} // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeInit(JNIEnv* /* env */, jclass /* clazz */) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();
}

JNIEXPORT void JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeDestroy(JNIEnv* /* env */, jclass /* clazz */) {
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

JNIEXPORT jlong JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeOpenDocument(
    JNIEnv* env, jclass /* clazz */, jstring jFilePath, jstring jPassword) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();

    if (!jFilePath) {
        LOGE("nativeOpenDocument: File path is null");
        return 0;
    }

    const char* filePath = env->GetStringUTFChars(jFilePath, nullptr);
    const char* password = jPassword ? env->GetStringUTFChars(jPassword, nullptr) : nullptr;

    FPDF_DOCUMENT doc = FPDF_LoadDocument(filePath, password);

    env->ReleaseStringUTFChars(jFilePath, filePath);
    if (password) {
        env->ReleaseStringUTFChars(jPassword, password);
    }

    if (!doc) {
        unsigned long err = FPDF_GetLastError();
        LOGE("Failed to open PDF document, FPDF_GetLastError: %lu", err);
        return 0;
    }

    int64_t handle = g_nextDocHandle++;
    g_documents[handle] = doc;
    LOGI("Opened PDF document with handle %lld", (long long)handle);
    return handle;
}

JNIEXPORT void JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeCloseDocument(
    JNIEnv* /* env */, jclass /* clazz */, jlong docHandle) {
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

JNIEXPORT jint JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageCount(
    JNIEnv* /* env */, jclass /* clazz */, jlong docHandle) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) {
        LOGE("nativeGetPageCount: Invalid document handle %lld", (long long)docHandle);
        return -1;
    }
    return FPDF_GetPageCount(doc);
}

JNIEXPORT jdoubleArray JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetPageSize(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) {
        LOGE("nativeGetPageSize: Invalid document handle %lld", (long long)docHandle);
        return nullptr;
    }

    double width = 0.0;
    double height = 0.0;
    int res = FPDF_GetPageSizeByIndex(doc, pageIndex, &width, &height);
    if (!res) {
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
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) {
        LOGE("nativeRenderPageToBitmap: Invalid document handle %lld", (long long)docHandle);
        return JNI_FALSE;
    }

    if (!jBitmap) {
        LOGE("nativeRenderPageToBitmap: Destination bitmap is null");
        return JNI_FALSE;
    }

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, jBitmap, &info) < 0) {
        LOGE("nativeRenderPageToBitmap: AndroidBitmap_getInfo failed");
        return JNI_FALSE;
    }

    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, jBitmap, &pixels) < 0 || !pixels) {
        LOGE("nativeRenderPageToBitmap: AndroidBitmap_lockPixels failed");
        return JNI_FALSE;
    }

    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) {
        LOGE("nativeRenderPageToBitmap: Failed to load page %d", pageIndex);
        AndroidBitmap_unlockPixels(env, jBitmap);
        return JNI_FALSE;
    }

    // PDFium bitmap wrapping the Android Bitmap's pixel memory
    FPDF_BITMAP fpdfBitmap = FPDFBitmap_CreateEx(
        info.width, info.height, FPDFBitmap_BGRA, pixels, info.stride);

    if (!fpdfBitmap) {
        LOGE("nativeRenderPageToBitmap: FPDFBitmap_CreateEx failed");
        FPDF_ClosePage(page);
        AndroidBitmap_unlockPixels(env, jBitmap);
        return JNI_FALSE;
    }

    // Fill background with opaque white
    FPDFBitmap_FillRect(fpdfBitmap, 0, 0, info.width, info.height, 0xFFFFFFFF);

    // Render page with annotations and reverse byte order for Android ARGB_8888
    FPDF_RenderPageBitmap(
        fpdfBitmap, page, 0, 0, info.width, info.height, 0,
        FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);

    FPDFBitmap_Destroy(fpdfBitmap);
    FPDF_ClosePage(page);
    AndroidBitmap_unlockPixels(env, jBitmap);

    return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetTextObjectsJson(
    JNIEnv* env, jclass /* clazz */, jlong docHandle, jint pageIndex) {
    std::lock_guard<std::mutex> lock(g_mutex);
    FPDF_DOCUMENT doc = getDoc(docHandle);
    if (!doc) {
        LOGE("nativeGetTextObjectsJson: Invalid document handle %lld", (long long)docHandle);
        return env->NewStringUTF("[]");
    }

    FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex);
    if (!page) {
        LOGE("nativeGetTextObjectsJson: Failed to load page %d", pageIndex);
        return env->NewStringUTF("[]");
    }

    double pageW = 0.0;
    double pageH = 0.0;
    FPDF_GetPageSizeByIndex(doc, pageIndex, &pageW, &pageH);

    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    std::ostringstream recursiveJson;
    recursiveJson << "[";
    bool recursiveFirst = true;
    const int rootObjectCount = FPDFPage_CountObjects(page);
    for (int i = 0; i < rootObjectCount; ++i) {
        traverseTextObjects(
            FPDFPage_GetObject(page, i),
            pageIndex,
            pageH,
            textPage,
            std::vector<int>{i},
            identityMatrix(),
            recursiveJson,
            recursiveFirst);
    }
    recursiveJson << "]";
    if (textPage) FPDFText_ClosePage(textPage);
    FPDF_ClosePage(page);
    return env->NewStringUTF(recursiveJson.str().c_str());

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
    return env->NewStringUTF(jsonStr.c_str());
}

JNIEXPORT jint JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeGetLastError(
    JNIEnv* /* env */, jclass /* clazz */) {
    return static_cast<jint>(FPDF_GetLastError());
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeReplaceTextObjectJson(
    JNIEnv* env, jclass /* clazz */,
    jstring jInputPath, jstring jOutputPath,
    jint pageIndex, jint objectIndex,
    jstring jReplacementText) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();

    auto makeErrorJson = [&](const std::string& code, const std::string& msg) -> jstring {
        std::string json = "{\"success\":false,\"errorCode\":\"" + escapeJsonString(code) +
                           "\",\"errorMessage\":\"" + escapeJsonString(msg) + "\"}";
        return env->NewStringUTF(json.c_str());
    };

    if (!jInputPath || !jOutputPath || !jReplacementText) {
        return makeErrorJson("INVALID_ARGUMENTS", "Input path, output path, and replacement text must not be null");
    }

    const char* inputPathStr = env->GetStringUTFChars(jInputPath, nullptr);
    const char* outputPathStr = env->GetStringUTFChars(jOutputPath, nullptr);
    const char* repTextStr = env->GetStringUTFChars(jReplacementText, nullptr);

    std::string inputPath(inputPathStr);
    std::string outputPath(outputPathStr);
    std::string replacementText(repTextStr);

    env->ReleaseStringUTFChars(jInputPath, inputPathStr);
    env->ReleaseStringUTFChars(jOutputPath, outputPathStr);
    env->ReleaseStringUTFChars(jReplacementText, repTextStr);

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
                    FPDFPage_RemoveObject(page, targetObj);
                    FPDFPage_InsertObject(page, newTextObj);
                    genuineSuccess = true;
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

    for (int i = 0; i < newObjCount; ++i) {
        FPDF_PAGEOBJECT obj = FPDFPage_GetObject(newPage, i);
        if (!obj || FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) continue;

        std::string txt;
        if (newTextPage) {
            unsigned long len = FPDFTextObj_GetText(obj, newTextPage, nullptr, 0);
            if (len > 0) {
                std::vector<FPDF_WCHAR> wbuf(len / sizeof(FPDF_WCHAR) + 1, 0);
                unsigned long rBytes = FPDFTextObj_GetText(obj, newTextPage, wbuf.data(), len);
                if (rBytes > 0) {
                    txt = utf16ToUtf8(wbuf.data(), rBytes / sizeof(FPDF_WCHAR));
                }
            }
        }

        if (!oldText.empty() && txt == oldText) {
            oldTextStillPresentInReopened = true;
        }

        if (txt == replacementText || (!replacementText.empty() && txt.find(replacementText) != std::string::npos)) {
            replacementFoundInReopened = true;
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
    return env->NewStringUTF(outJson.c_str());
}

JNIEXPORT jstring JNICALL
Java_com_pdfimageeditor_pdf_NativePdfiumBridge_nativeApplyBatchEditsJson(
    JNIEnv* env, jclass /* clazz */,
    jstring jInputPath, jstring jOutputPath,
    jstring jEditsJson) {
    std::lock_guard<std::mutex> lock(g_mutex);
    ensureLibraryInitialized();

    auto makeErrorJson = [&](const std::string& code, const std::string& msg) -> jstring {
        std::string json = "{\"success\":false,\"errorCode\":\"" + escapeJsonString(code) +
                           "\",\"errorMessage\":\"" + escapeJsonString(msg) + "\"}";
        return env->NewStringUTF(json.c_str());
    };

    if (!jInputPath || !jOutputPath || !jEditsJson) {
        return makeErrorJson("INVALID_ARGUMENTS", "Input path, output path, and edits JSON must not be null");
    }

    const char* inputPathStr = env->GetStringUTFChars(jInputPath, nullptr);
    const char* outputPathStr = env->GetStringUTFChars(jOutputPath, nullptr);
    const char* editsJsonStr = env->GetStringUTFChars(jEditsJson, nullptr);

    std::string inputPath(inputPathStr);
    std::string outputPath(outputPathStr);
    std::string editsJson(editsJsonStr);

    env->ReleaseStringUTFChars(jInputPath, inputPathStr);
    env->ReleaseStringUTFChars(jOutputPath, outputPathStr);
    env->ReleaseStringUTFChars(jEditsJson, editsJsonStr);

    if (inputPath == outputPath) {
        return makeErrorJson("SAME_INPUT_OUTPUT", "Input path and output path must be different to preserve source immutability");
    }

    std::vector<EditCommand> commands = parseEditCommands(editsJson);

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

            // Strategy 1: Direct in-place replacement (reusing original font resource)
            if (!fontChangeRequested && FPDFText_SetText(targetObj, (FPDF_WIDESTRING)wideRep.data())) {
                if (commands[ci].hasFontSize && commands[ci].fontSize > 0) {
                    FPDFTextObj_SetFontSize(targetObj, static_cast<float>(commands[ci].fontSize));
                }
                if (commands[ci].hasColor) {
                    FPDFPageObj_SetFillColor(targetObj, commands[ci].colorR, commands[ci].colorG, commands[ci].colorB, commands[ci].colorA);
                }
                replaced = true;
                results[ci].fontStrategy = "REUSED_ORIGINAL";
                results[ci].fontReused = true;
            } else if (parentForm) {
                results[ci].error = "Nested Form XObject text replacement failed: glyph not available in original font resource";
            } else {
                // Strategy 2: Reconstruct text object with requested or fallback font (root-level only)
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
                            FPDFPage_RemoveObject(page, targetObj);
                            FPDFPage_InsertObject(page, newTextObj);
                            replaced = true;
                            results[ci].fontStrategy = "LOADED_STANDARD";
                            results[ci].fontReused = false;
                        } else {
                            FPDFPageObj_Destroy(newTextObj);
                        }
                    }
                    FPDFFont_Close(repFont);
                }
            }

            if (replaced) {
                results[ci].applied = true;
            } else if (results[ci].error.empty()) {
                results[ci].error = "FPDFText_SetText failed on object";
            }
        }

        // Execute Deletions on this page
        for (size_t ci : cmdIndices) {
            if (commands[ci].type != "delete") continue;
            auto it = resolvedObjects.find(ci);
            if (it == resolvedObjects.end()) continue;
            FPDF_PAGEOBJECT targetObj = it->second.object;
            FPDF_PAGEOBJECT parentForm = it->second.parentForm;

            const bool removed = parentForm
                ? FPDFFormObj_RemoveObject(parentForm, targetObj)
                : FPDFPage_RemoveObject(page, targetObj);
            if (removed) {
                FPDFPageObj_Destroy(targetObj);
                results[ci].applied = true;
            } else {
                results[ci].error = parentForm
                    ? "FPDFFormObj_RemoveObject failed"
                    : "FPDFPage_RemoveObject failed";
            }
        }

        // Execute Insertions on this page
        for (size_t ci : cmdIndices) {
            if (commands[ci].type != "insert") continue;
            if (commands[ci].text.empty()) {
                results[ci].error = "Inserted text cannot be empty";
                continue;
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

            // Position: transform by (1, 0, 0, 1, x, y)
            FPDFPageObj_Transform(newObj, 1.0, 0.0, 0.0, 1.0, commands[ci].x, commands[ci].y);

            if (FPDFPage_InsertObject(page, newObj)) {
                results[ci].applied = true;
                results[ci].fontStrategy = "LOADED_STANDARD";
                results[ci].newText = commands[ci].text;
            } else {
                FPDFPageObj_Destroy(newObj);
                results[ci].error = "FPDFPage_InsertObject failed";
            }
            FPDFFont_Close(insertFont);
        }

        // Regenerate page content once per modified page
        FPDFPage_GenerateContent(page);
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

    // Scan each modified page in reopened document
    for (auto& entry : pageToCmdIndices) {
        int pageIndex = entry.first;
        const auto& cmdIndices = entry.second;

        FPDF_PAGE newPage = FPDF_LoadPage(newDoc, pageIndex);
        if (!newPage) continue;

        FPDF_TEXTPAGE newTextPage = FPDFText_LoadPage(newPage);
        std::vector<std::string> pageTexts;
        const int newRootObjectCount = FPDFPage_CountObjects(newPage);
        for (int i = 0; i < newRootObjectCount; ++i) {
            collectTextObjectStrings(FPDFPage_GetObject(newPage, i), newTextPage, pageTexts);
        }

        for (size_t ci : cmdIndices) {
            if (!results[ci].applied) continue;

            if (results[ci].type == "replace" || results[ci].type == "insert") {
                bool foundNew = false;
                for (const auto& t : pageTexts) {
                    if (t == results[ci].newText || t.find(results[ci].newText) != std::string::npos) {
                        foundNew = true;
                        break;
                    }
                }
                results[ci].verifiedInReopened = foundNew;
            } else if (results[ci].type == "delete") {
                bool foundOld = false;
                for (const auto& t : pageTexts) {
                    if (t == results[ci].originalText && !results[ci].originalText.empty()) {
                        foundOld = true;
                        break;
                    }
                }
                results[ci].verifiedInReopened = !foundOld;
            }
        }

        if (newTextPage) FPDFText_ClosePage(newTextPage);
        FPDF_ClosePage(newPage);
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
        ss << "\"fontStrategy\":\"" << escapeJsonString(results[ci].fontStrategy) << "\",";
        ss << "\"fontReused\":" << (results[ci].fontReused ? "true" : "false") << ",";
        ss << "\"error\":\"" << escapeJsonString(results[ci].error) << "\"";
        ss << "}";
    }
    ss << "]";

    ss << "}";

    std::string outJson = ss.str();
    return env->NewStringUTF(outJson.c_str());
}

} // extern "C"
