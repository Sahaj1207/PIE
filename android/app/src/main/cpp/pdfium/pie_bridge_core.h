// Pure C++ helpers shared by the PDFium JNI bridge (pdfium_bridge.cpp).
//
// Nothing in this header depends on JNI, Android or PDFium, so it can be compiled and tested
// standalone (see android/app/src/test/cpp/pie_bridge_core_test.cpp).
//
// Contents:
//   - Standard UTF-8 <-> UTF-16 conversion (surrogate pairs, invalid input -> U+FFFD).
//   - A small strict JSON parser (escapes incl. \uXXXX surrogate pairs) used to read the
//     edit-command batch sent by the TypeScript bridge. The JSON contract is unchanged.
//   - Edit-command parsing on top of the parsed JSON.
//   - Duplicate-safe reopen verification of applied edits.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace pie {

// ---------------------------------------------------------------------------
// UTF-8 / UTF-16
// ---------------------------------------------------------------------------

constexpr uint32_t kReplacementChar = 0xFFFD;

inline void appendUtf8(std::string& out, uint32_t cp) {
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = kReplacementChar;
    if (cp <= 0x7F) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

/**
 * UTF-16 -> standard UTF-8 (4-byte sequences for non-BMP characters, never the JNI
 * "modified UTF-8" form). Lone surrogates become U+FFFD. With stopAtNul, conversion ends at
 * the first NUL code unit (PDFium buffers are NUL terminated).
 */
inline std::string utf16ToUtf8(const uint16_t* data, size_t length, bool stopAtNul = true) {
    std::string out;
    if (!data) return out;
    out.reserve(length);
    for (size_t i = 0; i < length; ++i) {
        uint32_t cu = data[i];
        if (cu == 0 && stopAtNul) break;
        if (cu >= 0xD800 && cu <= 0xDBFF) {
            if (i + 1 < length && data[i + 1] >= 0xDC00 && data[i + 1] <= 0xDFFF) {
                const uint32_t low = data[i + 1];
                appendUtf8(out, 0x10000 + (((cu - 0xD800) << 10) | (low - 0xDC00)));
                ++i;
            } else {
                appendUtf8(out, kReplacementChar);
            }
        } else if (cu >= 0xDC00 && cu <= 0xDFFF) {
            appendUtf8(out, kReplacementChar);
        } else {
            appendUtf8(out, cu);
        }
    }
    return out;
}

/**
 * Decodes the next code point of standard UTF-8 starting at `i` and advances `i`.
 * Malformed, overlong, surrogate or out-of-range sequences yield U+FFFD and advance by one
 * byte, so invalid input can never swallow following valid characters.
 */
inline uint32_t decodeUtf8At(const std::string& s, size_t& i) {
    const auto byteAt = [&](size_t k) { return static_cast<unsigned char>(s[k]); };
    const unsigned char c = byteAt(i);
    if (c < 0x80) {
        ++i;
        return c;
    }
    size_t len = 0;
    uint32_t cp = 0;
    uint32_t minCp = 0;
    if ((c & 0xE0) == 0xC0) {
        len = 2; cp = c & 0x1F; minCp = 0x80;
    } else if ((c & 0xF0) == 0xE0) {
        len = 3; cp = c & 0x0F; minCp = 0x800;
    } else if ((c & 0xF8) == 0xF0) {
        len = 4; cp = c & 0x07; minCp = 0x10000;
    } else {
        ++i;
        return kReplacementChar;
    }
    if (i + len > s.size()) {
        ++i;
        return kReplacementChar;
    }
    for (size_t k = 1; k < len; ++k) {
        const unsigned char cc = byteAt(i + k);
        if ((cc & 0xC0) != 0x80) {
            ++i;
            return kReplacementChar;
        }
        cp = (cp << 6) | (cc & 0x3F);
    }
    if (cp < minCp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
        ++i;
        return kReplacementChar;
    }
    i += len;
    return cp;
}

/** Standard UTF-8 -> UTF-16 code units (no terminator). Non-BMP -> surrogate pairs. */
inline std::vector<uint16_t> utf8ToUtf16(const std::string& utf8) {
    std::vector<uint16_t> out;
    out.reserve(utf8.size());
    size_t i = 0;
    while (i < utf8.size()) {
        uint32_t cp = decodeUtf8At(utf8, i);
        if (cp <= 0xFFFF) {
            out.push_back(static_cast<uint16_t>(cp));
        } else {
            cp -= 0x10000;
            out.push_back(static_cast<uint16_t>(0xD800 + (cp >> 10)));
            out.push_back(static_cast<uint16_t>(0xDC00 + (cp & 0x3FF)));
        }
    }
    return out;
}

/** Escapes a UTF-8 string for embedding in a JSON string literal (UTF-8 kept as-is). */
inline std::string escapeJsonString(const std::string& input) {
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

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

struct JsonValue {
    enum class Type { Null, Bool, Number, String, Array, Object };
    Type type = Type::Null;
    bool boolValue = false;
    double numberValue = 0.0;
    std::string stringValue;
    std::vector<JsonValue> arrayValue;
    std::vector<std::pair<std::string, JsonValue>> objectValue;

    bool isObject() const { return type == Type::Object; }
    bool isArray() const { return type == Type::Array; }
    bool isString() const { return type == Type::String; }
    bool isNumber() const { return type == Type::Number; }
    bool isBool() const { return type == Type::Bool; }

    /** Member lookup on THIS object only (never nested values). Last duplicate key wins, as in JS. */
    const JsonValue* get(const std::string& key) const {
        if (type != Type::Object) return nullptr;
        const JsonValue* found = nullptr;
        for (const auto& member : objectValue) {
            if (member.first == key) found = &member.second;
        }
        return found;
    }
};

class JsonParser {
public:
    explicit JsonParser(const std::string& text) : s_(text) {}

    bool parse(JsonValue& out, std::string& error) {
        skipWhitespace();
        if (!parseValue(out, 0)) {
            error = error_.empty() ? "Invalid JSON" : error_;
            return false;
        }
        skipWhitespace();
        if (i_ != s_.size()) {
            error = "Unexpected trailing characters in JSON at offset " + std::to_string(i_);
            return false;
        }
        return true;
    }

private:
    static constexpr int kMaxDepth = 64;
    const std::string& s_;
    size_t i_ = 0;
    std::string error_;

    bool fail(const std::string& message) {
        if (error_.empty()) error_ = message + " at offset " + std::to_string(i_);
        return false;
    }

    void skipWhitespace() {
        while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) ++i_;
    }

    bool parseValue(JsonValue& out, int depth) {
        if (depth > kMaxDepth) return fail("JSON nesting too deep");
        skipWhitespace();
        if (i_ >= s_.size()) return fail("Unexpected end of JSON");
        const char c = s_[i_];
        if (c == '{') return parseObject(out, depth);
        if (c == '[') return parseArray(out, depth);
        if (c == '"') {
            out.type = JsonValue::Type::String;
            return parseString(out.stringValue);
        }
        if (c == '-' || (c >= '0' && c <= '9')) return parseNumber(out);
        if (s_.compare(i_, 4, "true") == 0) {
            out.type = JsonValue::Type::Bool; out.boolValue = true; i_ += 4; return true;
        }
        if (s_.compare(i_, 5, "false") == 0) {
            out.type = JsonValue::Type::Bool; out.boolValue = false; i_ += 5; return true;
        }
        if (s_.compare(i_, 4, "null") == 0) {
            out.type = JsonValue::Type::Null; i_ += 4; return true;
        }
        return fail("Unexpected character in JSON");
    }

    bool parseObject(JsonValue& out, int depth) {
        out.type = JsonValue::Type::Object;
        ++i_;  // '{'
        skipWhitespace();
        if (i_ < s_.size() && s_[i_] == '}') { ++i_; return true; }
        while (true) {
            skipWhitespace();
            if (i_ >= s_.size() || s_[i_] != '"') return fail("Expected object key");
            std::string key;
            if (!parseString(key)) return false;
            skipWhitespace();
            if (i_ >= s_.size() || s_[i_] != ':') return fail("Expected ':' after object key");
            ++i_;
            JsonValue value;
            if (!parseValue(value, depth + 1)) return false;
            out.objectValue.emplace_back(std::move(key), std::move(value));
            skipWhitespace();
            if (i_ < s_.size() && s_[i_] == ',') { ++i_; continue; }
            if (i_ < s_.size() && s_[i_] == '}') { ++i_; return true; }
            return fail("Expected ',' or '}' in object");
        }
    }

    bool parseArray(JsonValue& out, int depth) {
        out.type = JsonValue::Type::Array;
        ++i_;  // '['
        skipWhitespace();
        if (i_ < s_.size() && s_[i_] == ']') { ++i_; return true; }
        while (true) {
            JsonValue value;
            if (!parseValue(value, depth + 1)) return false;
            out.arrayValue.push_back(std::move(value));
            skipWhitespace();
            if (i_ < s_.size() && s_[i_] == ',') { ++i_; continue; }
            if (i_ < s_.size() && s_[i_] == ']') { ++i_; return true; }
            return fail("Expected ',' or ']' in array");
        }
    }

    bool parseHex4(uint32_t& out) {
        if (i_ + 4 > s_.size()) return fail("Truncated \\u escape");
        uint32_t v = 0;
        for (int k = 0; k < 4; ++k) {
            const char h = s_[i_ + k];
            v <<= 4;
            if (h >= '0' && h <= '9') v |= static_cast<uint32_t>(h - '0');
            else if (h >= 'a' && h <= 'f') v |= static_cast<uint32_t>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') v |= static_cast<uint32_t>(h - 'A' + 10);
            else return fail("Invalid hex digit in \\u escape");
        }
        i_ += 4;
        out = v;
        return true;
    }

    // Decodes a JSON string (positioned at the opening quote) into UTF-8.
    bool parseString(std::string& out) {
        ++i_;  // opening quote
        out.clear();
        while (true) {
            if (i_ >= s_.size()) return fail("Unterminated string");
            const unsigned char c = static_cast<unsigned char>(s_[i_]);
            if (c == '"') { ++i_; return true; }
            if (c < 0x20) return fail("Unescaped control character in string");
            if (c != '\\') {
                // Raw (already UTF-8) byte: validate/normalize the code point it starts.
                appendUtf8(out, decodeUtf8At(s_, i_));
                continue;
            }
            ++i_;  // backslash
            if (i_ >= s_.size()) return fail("Unterminated escape");
            const char e = s_[i_++];
            switch (e) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!parseHex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        // High surrogate: combine with a following \uDC00-\uDFFF escape.
                        uint32_t low = 0;
                        if (i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                            const size_t save = i_;
                            i_ += 2;
                            if (!parseHex4(low)) return false;
                            if (low >= 0xDC00 && low <= 0xDFFF) {
                                cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
                            } else {
                                i_ = save;  // not a pair: re-read the next escape on its own
                                cp = kReplacementChar;
                            }
                        } else {
                            cp = kReplacementChar;
                        }
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        cp = kReplacementChar;
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default:
                    return fail("Invalid escape sequence in string");
            }
        }
    }

    bool parseNumber(JsonValue& out) {
        const size_t start = i_;
        if (s_[i_] == '-') ++i_;
        if (i_ >= s_.size()) return fail("Invalid number");
        if (s_[i_] == '0') {
            ++i_;
        } else if (s_[i_] >= '1' && s_[i_] <= '9') {
            while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
        } else {
            return fail("Invalid number");
        }
        if (i_ < s_.size() && s_[i_] == '.') {
            ++i_;
            if (i_ >= s_.size() || s_[i_] < '0' || s_[i_] > '9') return fail("Invalid number fraction");
            while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
        }
        if (i_ < s_.size() && (s_[i_] == 'e' || s_[i_] == 'E')) {
            ++i_;
            if (i_ < s_.size() && (s_[i_] == '+' || s_[i_] == '-')) ++i_;
            if (i_ >= s_.size() || s_[i_] < '0' || s_[i_] > '9') return fail("Invalid number exponent");
            while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
        }
        const std::string token = s_.substr(start, i_ - start);
        out.type = JsonValue::Type::Number;
        out.numberValue = std::strtod(token.c_str(), nullptr);
        return true;
    }
};

inline bool parseJson(const std::string& text, JsonValue& out, std::string& error) {
    JsonParser parser(text);
    return parser.parse(out, error);
}

inline std::string jsonString(const JsonValue* v, const std::string& def = "") {
    return (v && v->isString()) ? v->stringValue : def;
}

inline double jsonNumber(const JsonValue* v, double def) {
    return (v && v->isNumber() && std::isfinite(v->numberValue)) ? v->numberValue : def;
}

inline int jsonInt(const JsonValue* v, int def) {
    if (!v || !v->isNumber() || !std::isfinite(v->numberValue)) return def;
    const double d = v->numberValue;
    if (d < -2147483648.0 || d > 2147483647.0) return def;
    return static_cast<int>(d);
}

// ---------------------------------------------------------------------------
// Edit commands (JSON contract produced by PdfiumEngine.applyBatchEdits / copyDocument)
// ---------------------------------------------------------------------------

struct EditCommand {
    std::string type;  // "replace", "delete", or "insert"
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
    std::string fontName;
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
    // Replace / delete: shift the text that follows on the same line by the width change, so
    // edits inside a sentence close up (or make room) like a word processor.
    bool reflow = false;
};

inline void parseHexColor(const std::string& hex, int& r, int& g, int& b, int& a) {
    if (hex.empty()) return;
    std::string clean = hex;
    if (clean[0] == '#') clean = clean.substr(1);
    const auto hexByte = [&](size_t pos, int& outValue) {
        char* end = nullptr;
        const std::string part = clean.substr(pos, 2);
        const long v = std::strtol(part.c_str(), &end, 16);
        if (end && *end == '\0') outValue = static_cast<int>(v);
    };
    if (clean.length() == 6 || clean.length() == 8) {
        hexByte(0, r);
        hexByte(2, g);
        hexByte(4, b);
        a = 255;
        if (clean.length() == 8) hexByte(6, a);
    }
}

inline EditCommand editCommandFromJson(const JsonValue& obj) {
    EditCommand cmd;
    cmd.type = jsonString(obj.get("type"));
    cmd.objectId = jsonString(obj.get("objectId"));
    cmd.pageIndex = jsonInt(obj.get("pageIndex"), 0);
    cmd.objectIndex = jsonInt(obj.get("objectIndex"), 0);
    if (const JsonValue* path = obj.get("objectPath"); path && path->isArray()) {
        for (const auto& item : path->arrayValue) {
            if (item.isNumber()) cmd.objectPath.push_back(jsonInt(&item, 0));
        }
    }
    cmd.originalText = jsonString(obj.get("originalText"));
    cmd.newText = jsonString(obj.get("newText"));
    cmd.text = jsonString(obj.get("text"));
    cmd.x = jsonNumber(obj.get("x"), 0.0);
    cmd.y = jsonNumber(obj.get("y"), 0.0);
    cmd.fontSize = jsonNumber(obj.get("fontSize"), 14.0);
    cmd.fontName = jsonString(obj.get("fontName"));
    cmd.colorHex = jsonString(obj.get("color"));
    cmd.colorR = jsonInt(obj.get("colorR"), 0);
    cmd.colorG = jsonInt(obj.get("colorG"), 0);
    cmd.colorB = jsonInt(obj.get("colorB"), 0);
    cmd.colorA = jsonInt(obj.get("colorA"), 255);
    if (const JsonValue* reflow = obj.get("reflow"); reflow && reflow->isBool()) cmd.reflow = reflow->boolValue;

    if (cmd.colorR == 0 && cmd.colorG == 0 && cmd.colorB == 0 && !cmd.colorHex.empty()) {
        parseHexColor(cmd.colorHex, cmd.colorR, cmd.colorG, cmd.colorB, cmd.colorA);
        cmd.hasColor = true;
    }

    if (const JsonValue* format = obj.get("format"); format && format->isObject()) {
        const double fSize = jsonNumber(format->get("fontSize"), 0.0);
        if (fSize > 0) {
            cmd.hasFontSize = true;
            cmd.fontSize = fSize;
        }
        const std::string fColor = jsonString(format->get("color"));
        if (!fColor.empty()) {
            cmd.hasColor = true;
            cmd.colorHex = fColor;
            parseHexColor(fColor, cmd.colorR, cmd.colorG, cmd.colorB, cmd.colorA);
        }
        if (const JsonValue* bold = format->get("isBold"); bold && bold->isBool()) {
            cmd.hasBold = true;
            cmd.isBold = bold->boolValue;
        }
        if (const JsonValue* italic = format->get("isItalic"); italic && italic->isBool()) {
            cmd.hasItalic = true;
            cmd.isItalic = italic->boolValue;
        }
        const std::string fFamily = jsonString(format->get("fontFamily"));
        if (!fFamily.empty()) cmd.fontFamily = fFamily;
    }
    return cmd;
}

/**
 * Parses the edit batch (a JSON array of command objects; a single object is accepted as a
 * one-command batch). Returns false with `error` set when the JSON is malformed, so a broken
 * batch can never degrade into a silent zero-command copy. Objects without a "type" are
 * skipped (unchanged from the previous parser).
 */
inline bool parseEditCommands(const std::string& json, std::vector<EditCommand>& commands, std::string& error) {
    commands.clear();
    JsonValue root;
    if (!parseJson(json, root, error)) return false;
    if (root.isObject()) {
        EditCommand cmd = editCommandFromJson(root);
        if (!cmd.type.empty()) commands.push_back(std::move(cmd));
        return true;
    }
    if (!root.isArray()) {
        error = "Edit batch must be a JSON array of commands";
        return false;
    }
    for (const auto& item : root.arrayValue) {
        if (!item.isObject()) {
            error = "Edit batch entries must be JSON objects";
            commands.clear();
            return false;
        }
        EditCommand cmd = editCommandFromJson(item);
        if (!cmd.type.empty()) commands.push_back(std::move(cmd));
    }
    return true;
}

// ---------------------------------------------------------------------------
// Glyph coverage (Phase 15)
// ---------------------------------------------------------------------------

/** Unicode code points of a UTF-8 string (invalid sequences -> U+FFFD). */
inline std::vector<uint32_t> decodeCodePoints(const std::string& utf8) {
    std::vector<uint32_t> out;
    size_t i = 0;
    while (i < utf8.size()) out.push_back(decodeUtf8At(utf8, i));
    return out;
}

/**
 * True when `cp` is representable by PDFium's standard 14 fonts as loaded by
 * FPDFText_LoadStandardFont (WinAnsiEncoding): printable ASCII, Latin-1 and the
 * Windows-1252 0x80-0x9F extras. Control characters (incl. newline) are not drawable.
 */
inline bool isWinAnsiEncodable(uint32_t cp) {
    if (cp >= 0x20 && cp <= 0x7E) return true;
    if (cp >= 0xA0 && cp <= 0xFF) return true;
    switch (cp) {
        case 0x20AC: case 0x201A: case 0x0192: case 0x201E: case 0x2026: case 0x2020:
        case 0x2021: case 0x02C6: case 0x2030: case 0x0160: case 0x2039: case 0x0152:
        case 0x017D: case 0x2018: case 0x2019: case 0x201C: case 0x201D: case 0x2022:
        case 0x2013: case 0x2014: case 0x02DC: case 0x2122: case 0x0161: case 0x203A:
        case 0x0153: case 0x017E: case 0x0178:
            return true;
        default:
            return false;
    }
}

/** Distinct code points of `utf8` that standard 14 fonts cannot draw (order of first use). */
inline std::vector<uint32_t> findNonWinAnsiCodePoints(const std::string& utf8) {
    std::vector<uint32_t> missing;
    for (uint32_t cp : decodeCodePoints(utf8)) {
        if (isWinAnsiEncodable(cp)) continue;
        bool seen = false;
        for (uint32_t m : missing) {
            if (m == cp) { seen = true; break; }
        }
        if (!seen) missing.push_back(cp);
    }
    return missing;
}

/** "'é' (U+00E9), '😀' (U+1F600)" — at most `limit` entries, for user-facing errors. */
inline std::string describeCodePoints(const std::vector<uint32_t>& cps, size_t limit = 6) {
    std::string out;
    for (size_t k = 0; k < cps.size() && k < limit; ++k) {
        if (k > 0) out += ", ";
        const uint32_t cp = cps[k];
        char hex[16];
        snprintf(hex, sizeof(hex), cp > 0xFFFF ? "U+%05X" : "U+%04X", static_cast<unsigned>(cp));
        if (cp >= 0x20 && cp != 0x7F) {
            out += "'";
            appendUtf8(out, cp);
            out += "' ";
        }
        out += "(";
        out += hex;
        out += ")";
    }
    if (cps.size() > limit) out += ", …";
    return out;
}

/** Error prefix the TypeScript layer maps to PdfUnsupportedGlyphsError. */
constexpr const char* kUnsupportedGlyphsPrefix = "UNSUPPORTED_GLYPHS: ";

// ---------------------------------------------------------------------------
// Reopen verification
// ---------------------------------------------------------------------------

/** Trims leading/trailing ASCII whitespace and NULs (PDFium may pad extracted text). */
inline std::string normalizeVerifyText(const std::string& text) {
    size_t start = 0;
    size_t end = text.size();
    const auto isPad = [](unsigned char c) { return c <= 0x20; };
    while (start < end && isPad(static_cast<unsigned char>(text[start]))) ++start;
    while (end > start && isPad(static_cast<unsigned char>(text[end - 1]))) --end;
    return text.substr(start, end - start);
}

inline std::map<std::string, int> countNormalizedTexts(const std::vector<std::string>& texts) {
    std::map<std::string, int> counts;
    for (const auto& t : texts) counts[normalizeVerifyText(t)]++;
    return counts;
}

inline int countOf(const std::map<std::string, int>& counts, const std::string& key) {
    const auto it = counts.find(key);
    return it == counts.end() ? 0 : it->second;
}

/** One applied command on a page, as seen by the verifier. */
struct PageVerifyInput {
    std::string type;          // replace | delete | insert
    std::string preText;       // text of the targeted object BEFORE the edit (replace/delete)
    std::string newText;       // requested text (replace/insert)
    bool objectFound = false;  // replace/insert: a text object exists at the edited object's location
    std::string objectText;    // replace/insert: text of that object in the reopened document
    bool verified = false;     // output
    std::string error;         // output: reason when not verified
};

/**
 * Verifies applied edits of ONE page against the reopened document.
 *
 *   before: texts of every text object on the page before editing (whole object tree)
 *   after:  texts of every text object on the page in the reopened output
 *
 * The expected text multiset is derived from `before` and the applied edits; every check
 * compares exact (trimmed) strings and occurrence COUNTS, so duplicate text elsewhere on the
 * page can neither hide a failed edit nor fail a correct one:
 *   - replace: the edited object itself holds exactly newText, newText occurs exactly as often
 *              as expected, and the replaced text occurs exactly as often as expected.
 *   - insert:  the inserted object holds exactly newText and newText's count is as expected.
 *   - delete:  the deleted text occurs exactly as often as expected (one fewer than before for
 *              each deletion of it); text-less objects are checked via the object count.
 */
inline void verifyPageEdits(const std::vector<std::string>& before,
                            const std::vector<std::string>& after,
                            std::vector<PageVerifyInput>& edits) {
    std::map<std::string, int> expected = countNormalizedTexts(before);
    long expectedTotal = static_cast<long>(before.size());
    for (const auto& e : edits) {
        if (e.type == "replace") {
            expected[normalizeVerifyText(e.preText)]--;
            expected[normalizeVerifyText(e.newText)]++;
        } else if (e.type == "delete") {
            expected[normalizeVerifyText(e.preText)]--;
            expectedTotal--;
        } else if (e.type == "insert") {
            expected[normalizeVerifyText(e.newText)]++;
            expectedTotal++;
        }
    }
    const std::map<std::string, int> actual = countNormalizedTexts(after);
    const long actualTotal = static_cast<long>(after.size());

    for (auto& e : edits) {
        e.verified = false;
        e.error.clear();
        const std::string pre = normalizeVerifyText(e.preText);
        const std::string requested = normalizeVerifyText(e.newText);

        if (e.type == "replace" || e.type == "insert") {
            if (!e.objectFound) {
                e.error = "Edited text object was not found at its expected location in the reopened document";
                continue;
            }
            if (normalizeVerifyText(e.objectText) != requested) {
                e.error = "Reopened object text does not match the requested text";
                continue;
            }
            if (countOf(actual, requested) != countOf(expected, requested)) {
                e.error = "Requested text occurs " + std::to_string(countOf(actual, requested)) +
                          " time(s) in the reopened page; expected " + std::to_string(countOf(expected, requested));
                continue;
            }
            if (e.type == "replace" && !pre.empty() && pre != requested &&
                countOf(actual, pre) != countOf(expected, pre)) {
                e.error = "Replaced text still occurs " + std::to_string(countOf(actual, pre)) +
                          " time(s) in the reopened page; expected " + std::to_string(countOf(expected, pre));
                continue;
            }
            e.verified = true;
        } else if (e.type == "delete") {
            if (!pre.empty()) {
                if (countOf(actual, pre) != countOf(expected, pre)) {
                    e.error = "Deleted text occurs " + std::to_string(countOf(actual, pre)) +
                              " time(s) in the reopened page; expected " + std::to_string(countOf(expected, pre));
                    continue;
                }
            } else if (actualTotal != expectedTotal) {
                e.error = "Reopened page has " + std::to_string(actualTotal) +
                          " text object(s); expected " + std::to_string(expectedTotal);
                continue;
            }
            e.verified = true;
        } else {
            e.error = "Unknown command type";
        }
    }
}

}  // namespace pie
