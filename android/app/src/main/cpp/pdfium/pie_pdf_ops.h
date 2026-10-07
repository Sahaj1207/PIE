// PIE — platform-neutral PDFium document operations (no JNI / Objective-C).
//
// Shared by the Android JNI bridge (pdfium_bridge.cpp) and the iOS Objective-C++ module.
// Every operation reads an input PDF and writes a NEW output file (the input is never
// modified; its checksum is compared before/after), then reopens the output to verify it.
//
//   applyDocumentOperationsJson  page tools (rotate / delete / move / insert blank / duplicate)
//                                and markup (ink, shapes, highlight / underline / strike-out,
//                                JPEG images) — all drawn as regular page content.
//   mergeDocumentsJson           concatenates PDFs.
//   createPdfFromImagesJson      builds a PDF from JPEG files (one image per page).
//   searchDocumentJson           full-text search with display-space match rectangles.
//
// Callers must hold the bridge mutex and have initialised the PDFium library.
#pragma once

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>
#include <sstream>
#include <algorithm>

#include "fpdfview.h"
#include "fpdf_edit.h"
#include "fpdf_save.h"
#include "fpdf_text.h"
#include "fpdf_ppo.h"

#include "pie_bridge_core.h"

namespace pie_pdf {

using pie::JsonValue;
using pie::escapeJsonString;
using pie::jsonInt;
using pie::jsonNumber;
using pie::jsonString;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

struct FileWriter : public FPDF_FILEWRITE {
    FILE* file = nullptr;
    bool failed = false;
    explicit FileWriter(FILE* f) {
        version = 1;
        file = f;
        WriteBlock = &writeBlock;
    }
    static int writeBlock(FPDF_FILEWRITE* self, const void* data, unsigned long size) {
        auto* w = static_cast<FileWriter*>(self);
        if (!w->file) return 0;
        const size_t n = fwrite(data, 1, size, w->file);
        if (n != size) {
            w->failed = true;
            return 0;
        }
        return 1;
    }
};

inline std::string fileChecksum(const std::string& path) {
    FILE* fp = fopen(path.c_str(), "rb");
    if (!fp) return "";
    uint64_t hash = 14695981039346656037ULL;
    unsigned char buffer[8192];
    size_t n;
    while ((n = fread(buffer, 1, sizeof(buffer), fp)) > 0) {
        for (size_t i = 0; i < n; ++i) {
            hash ^= buffer[i];
            hash *= 1099511628211ULL;
        }
    }
    fclose(fp);
    char out[17];
    snprintf(out, sizeof(out), "%016llx", static_cast<unsigned long long>(hash));
    return out;
}

inline bool readWholeFile(const std::string& path, std::vector<unsigned char>& out) {
    FILE* fp = fopen(path.c_str(), "rb");
    if (!fp) return false;
    fseek(fp, 0, SEEK_END);
    const long size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (size <= 0) {
        fclose(fp);
        return false;
    }
    out.resize(static_cast<size_t>(size));
    const size_t read = fread(out.data(), 1, out.size(), fp);
    fclose(fp);
    return read == out.size();
}

/** In-memory FPDF_FILEACCESS (used for inline JPEG images). */
struct MemoryFileAccess {
    std::vector<unsigned char> data;
    FPDF_FILEACCESS access{};
    bool load(const std::string& path) {
        if (!readWholeFile(path, data)) return false;
        access.m_FileLen = static_cast<unsigned long>(data.size());
        access.m_GetBlock = &getBlock;
        access.m_Param = this;
        return true;
    }
    static int getBlock(void* param, unsigned long position, unsigned char* buf, unsigned long size) {
        auto* self = static_cast<MemoryFileAccess*>(param);
        if (position + size > self->data.size()) return 0;
        std::copy(self->data.begin() + position, self->data.begin() + position + size, buf);
        return 1;
    }
};

inline bool saveDocumentTo(FPDF_DOCUMENT doc, const std::string& outputPath, std::string& error) {
    FILE* fp = fopen(outputPath.c_str(), "wb");
    if (!fp) {
        error = "Cannot create output file";
        return false;
    }
    FileWriter writer(fp);
    const FPDF_BOOL ok = FPDF_SaveAsCopy(doc, &writer, 0);
    const bool flushed = fflush(fp) == 0;
    fclose(fp);
    if (!ok || writer.failed || !flushed) {
        std::remove(outputPath.c_str());
        error = "Saving the PDF failed";
        return false;
    }
    return true;
}

/** Reopens `path` and checks the page count and that every page loads. */
inline bool verifyOutput(const std::string& path, int expectedPages, std::string& error) {
    FPDF_DOCUMENT doc = FPDF_LoadDocument(path.c_str(), nullptr);
    if (!doc) {
        error = "The saved PDF could not be reopened";
        return false;
    }
    const int count = FPDF_GetPageCount(doc);
    bool ok = count == expectedPages;
    if (!ok) error = "Unexpected page count in the saved PDF";
    for (int i = 0; ok && i < count; ++i) {
        FPDF_PAGE page = FPDF_LoadPage(doc, i);
        if (!page) {
            ok = false;
            error = "A page of the saved PDF could not be loaded";
        } else {
            FPDF_ClosePage(page);
        }
    }
    FPDF_CloseDocument(doc);
    return ok;
}

inline std::string errorJson(const std::string& code, const std::string& message) {
    return "{\"success\":false,\"errorCode\":\"" + escapeJsonString(code) + "\",\"errorMessage\":\"" +
           escapeJsonString(message) + "\"}";
}

// ---------------------------------------------------------------------------
// Page geometry: user space <-> display space (points, top-left origin, Y down) exactly as
// FPDF_RenderPageBitmap draws the page (page /Rotate and crop box applied).
// ---------------------------------------------------------------------------

inline FS_MATRIX displayMatrixFallback(double pageHeight) {
    return FS_MATRIX{1, 0, 0, -1, 0, static_cast<float>(pageHeight)};
}

inline bool computeDisplayMatrix(FPDF_PAGE page, double pageWidth, double pageHeight, FS_MATRIX& out) {
    if (!page || pageWidth <= 0 || pageHeight <= 0) return false;
    const double S = 100.0;  // device units per point (precision 0.01 pt)
    const int sizeX = static_cast<int>(std::lround(pageWidth * S));
    const int sizeY = static_cast<int>(std::lround(pageHeight * S));
    if (sizeX <= 0 || sizeY <= 0) return false;
    int u0 = 0, v0 = 0, u1 = 0, v1 = 0, u2 = 0, v2 = 0;
    const double step = 100.0;
    if (!FPDF_PageToDevice(page, 0, 0, sizeX, sizeY, 0, 0.0, 0.0, &u0, &v0) ||
        !FPDF_PageToDevice(page, 0, 0, sizeX, sizeY, 0, step, 0.0, &u1, &v1) ||
        !FPDF_PageToDevice(page, 0, 0, sizeX, sizeY, 0, 0.0, step, &u2, &v2)) {
        return false;
    }
    auto snap = [](double v) -> float {
        // Page display transforms are multiples of 90 degrees: snap to -1 / 0 / 1.
        if (std::abs(v - 1.0) < 0.02) return 1.0f;
        if (std::abs(v + 1.0) < 0.02) return -1.0f;
        if (std::abs(v) < 0.02) return 0.0f;
        return static_cast<float>(v);
    };
    out.a = snap((u1 - u0) / (step * S));
    out.b = snap((v1 - v0) / (step * S));
    out.c = snap((u2 - u0) / (step * S));
    out.d = snap((v2 - v0) / (step * S));
    out.e = static_cast<float>(u0 / S);
    out.f = static_cast<float>(v0 / S);
    const double det = static_cast<double>(out.a) * out.d - static_cast<double>(out.b) * out.c;
    return std::abs(det) > 1e-6;
}

inline FS_MATRIX pageDisplayMatrix(FPDF_DOCUMENT doc, FPDF_PAGE page, int pageIndex) {
    double w = 0.0, h = 0.0;
    FPDF_GetPageSizeByIndex(doc, pageIndex, &w, &h);
    FS_MATRIX m;
    if (computeDisplayMatrix(page, w, h, m)) return m;
    return displayMatrixFallback(h);
}

/** Inverse mapping display (u, v) -> user (x, y). */
struct DisplayToUser {
    double ia = 1, ib = 0, ic = 0, id = 1, e = 0, f = 0;
    explicit DisplayToUser(const FS_MATRIX& m) {
        const double det = static_cast<double>(m.a) * m.d - static_cast<double>(m.b) * m.c;
        if (std::abs(det) < 1e-9) return;
        ia = m.d / det;
        ib = -m.b / det;
        ic = -m.c / det;
        id = m.a / det;
        e = m.e;
        f = m.f;
    }
    void map(double u, double v, float& x, float& y) const {
        const double du = u - e, dv = v - f;
        x = static_cast<float>(ia * du + ic * dv);
        y = static_cast<float>(ib * du + id * dv);
    }
};

// ---------------------------------------------------------------------------
// Markup drawing
// ---------------------------------------------------------------------------

struct Rgba {
    unsigned int r = 0, g = 0, b = 0, a = 255;
};

inline Rgba parseColor(const JsonValue* v, double opacity, const Rgba& def) {
    Rgba c = def;
    const std::string hex = jsonString(v);
    if (!hex.empty()) {
        int r = c.r, g = c.g, b = c.b, a = 255;
        pie::parseHexColor(hex, r, g, b, a);
        c.r = static_cast<unsigned>(std::clamp(r, 0, 255));
        c.g = static_cast<unsigned>(std::clamp(g, 0, 255));
        c.b = static_cast<unsigned>(std::clamp(b, 0, 255));
        c.a = static_cast<unsigned>(std::clamp(a, 0, 255));
    }
    const double o = std::clamp(opacity, 0.0, 1.0);
    c.a = static_cast<unsigned>(std::lround(c.a * o));
    return c;
}

/**
 * Builds a path object from display-space commands:
 *   [["M",u,v],["L",u,v],["C",u1,v1,u2,v2,u,v],["Q",cu,cv,u,v],["Z"]]
 * Returns nullptr when the command list is empty or malformed.
 */
inline FPDF_PAGEOBJECT buildPath(const JsonValue* commands, const DisplayToUser& toUser) {
    if (!commands || !commands->isArray() || commands->arrayValue.empty()) return nullptr;
    FPDF_PAGEOBJECT path = nullptr;
    float curX = 0, curY = 0;  // current point (user space)
    double curU = 0, curV = 0;  // current point (display space), for quadratic conversion
    for (const JsonValue& cmd : commands->arrayValue) {
        if (!cmd.isArray() || cmd.arrayValue.empty() || !cmd.arrayValue[0].isString()) {
            if (path) FPDFPageObj_Destroy(path);
            return nullptr;
        }
        const std::string& op = cmd.arrayValue[0].stringValue;
        std::vector<double> n;
        for (size_t i = 1; i < cmd.arrayValue.size(); ++i) {
            if (!cmd.arrayValue[i].isNumber() || !std::isfinite(cmd.arrayValue[i].numberValue)) {
                if (path) FPDFPageObj_Destroy(path);
                return nullptr;
            }
            n.push_back(cmd.arrayValue[i].numberValue);
        }
        float x = 0, y = 0;
        if (op == "M" && n.size() >= 2) {
            toUser.map(n[0], n[1], x, y);
            if (!path) {
                path = FPDFPageObj_CreateNewPath(x, y);
                if (!path) return nullptr;
            } else {
                FPDFPath_MoveTo(path, x, y);
            }
            curX = x; curY = y; curU = n[0]; curV = n[1];
        } else if (!path) {
            return nullptr;  // must start with M
        } else if (op == "L" && n.size() >= 2) {
            toUser.map(n[0], n[1], x, y);
            FPDFPath_LineTo(path, x, y);
            curX = x; curY = y; curU = n[0]; curV = n[1];
        } else if (op == "C" && n.size() >= 6) {
            float x1, y1, x2, y2;
            toUser.map(n[0], n[1], x1, y1);
            toUser.map(n[2], n[3], x2, y2);
            toUser.map(n[4], n[5], x, y);
            FPDFPath_BezierTo(path, x1, y1, x2, y2, x, y);
            curX = x; curY = y; curU = n[4]; curV = n[5];
        } else if (op == "Q" && n.size() >= 4) {
            // Quadratic -> cubic: c1 = p0 + 2/3 (q - p0), c2 = p + 2/3 (q - p)
            const double c1u = curU + 2.0 / 3.0 * (n[0] - curU), c1v = curV + 2.0 / 3.0 * (n[1] - curV);
            const double c2u = n[2] + 2.0 / 3.0 * (n[0] - n[2]), c2v = n[3] + 2.0 / 3.0 * (n[1] - n[3]);
            float x1, y1, x2, y2;
            toUser.map(c1u, c1v, x1, y1);
            toUser.map(c2u, c2v, x2, y2);
            toUser.map(n[2], n[3], x, y);
            FPDFPath_BezierTo(path, x1, y1, x2, y2, x, y);
            curX = x; curY = y; curU = n[2]; curV = n[3];
        } else if (op == "Z") {
            FPDFPath_Close(path);
        } else {
            FPDFPageObj_Destroy(path);
            return nullptr;
        }
    }
    (void)curX;
    (void)curY;
    return path;
}

inline void styleStroke(FPDF_PAGEOBJECT obj, const Rgba& c, double width) {
    FPDFPageObj_SetStrokeColor(obj, c.r, c.g, c.b, c.a);
    FPDFPageObj_SetStrokeWidth(obj, static_cast<float>(std::clamp(width, 0.1, 200.0)));
    FPDFPageObj_SetLineCap(obj, FPDF_LINECAP_ROUND);
    FPDFPageObj_SetLineJoin(obj, FPDF_LINEJOIN_ROUND);
}

/** Display-space rectangle path (u, v, w, h). */
inline std::string rectCommandsJson(double u, double v, double w, double h) {
    std::ostringstream ss;
    ss << "[[\"M\"," << u << "," << v << "],[\"L\"," << u + w << "," << v << "],[\"L\"," << u + w << ","
       << v + h << "],[\"L\"," << u << "," << v + h << "],[\"Z\"]]";
    return ss.str();
}

inline std::string ellipseCommandsJson(double u, double v, double w, double h) {
    const double k = 0.5522847498;
    const double cx = u + w / 2, cy = v + h / 2, rx = w / 2, ry = h / 2;
    std::ostringstream ss;
    ss << "[[\"M\"," << cx + rx << "," << cy << "],"
       << "[\"C\"," << cx + rx << "," << cy + k * ry << "," << cx + k * rx << "," << cy + ry << "," << cx << "," << cy + ry << "],"
       << "[\"C\"," << cx - k * rx << "," << cy + ry << "," << cx - rx << "," << cy + k * ry << "," << cx - rx << "," << cy << "],"
       << "[\"C\"," << cx - rx << "," << cy - k * ry << "," << cx - k * rx << "," << cy - ry << "," << cx << "," << cy - ry << "],"
       << "[\"C\"," << cx + k * rx << "," << cy - ry << "," << cx + rx << "," << cy - k * ry << "," << cx + rx << "," << cy << "],"
       << "[\"Z\"]]";
    return ss.str();
}

inline bool insertCommandsPath(FPDF_PAGE page, const std::string& commandsJson, const DisplayToUser& toUser,
                               const Rgba* stroke, double strokeWidth, const Rgba* fill, const char* blend) {
    JsonValue cmds;
    std::string err;
    if (!pie::parseJson(commandsJson, cmds, err)) return false;
    FPDF_PAGEOBJECT path = buildPath(&cmds, toUser);
    if (!path) return false;
    if (stroke) styleStroke(path, *stroke, strokeWidth);
    if (fill) FPDFPageObj_SetFillColor(path, fill->r, fill->g, fill->b, fill->a);
    FPDFPath_SetDrawMode(path, fill ? FPDF_FILLMODE_WINDING : FPDF_FILLMODE_NONE, stroke ? 1 : 0);
    if (blend) FPDFPageObj_SetBlendMode(path, blend);
    FPDFPage_InsertObject(page, path);
    return true;
}

struct OpResult {
    std::string type;
    int pageIndex = -1;
    bool applied = false;
    std::string error;
};

/** Applies one markup operation to an already loaded page. */
inline bool applyMarkup(FPDF_DOCUMENT doc, FPDF_PAGE page, int pageIndex, const JsonValue& op, std::string& error) {
    const std::string type = jsonString(op.get("type"));
    const DisplayToUser toUser(pageDisplayMatrix(doc, page, pageIndex));
    const double opacity = jsonNumber(op.get("opacity"), 1.0);
    bool inserted = false;

    if (type == "addInk") {
        const Rgba color = parseColor(op.get("color"), opacity, Rgba{0, 0, 0, 255});
        const double width = jsonNumber(op.get("width"), 2.0);
        const JsonValue* strokes = op.get("strokes");
        const std::string blend = jsonString(op.get("blendMode"));
        if (!strokes || !strokes->isArray()) {
            error = "Ink operation without strokes";
            return false;
        }
        for (const JsonValue& stroke : strokes->arrayValue) {
            FPDF_PAGEOBJECT path = buildPath(&stroke, toUser);
            if (!path) continue;
            styleStroke(path, color, width);
            FPDFPath_SetDrawMode(path, FPDF_FILLMODE_NONE, 1);
            if (!blend.empty()) FPDFPageObj_SetBlendMode(path, blend.c_str());
            FPDFPage_InsertObject(page, path);
            inserted = true;
        }
        if (!inserted) error = "No drawable strokes";
    } else if (type == "addShape") {
        const std::string shape = jsonString(op.get("shape"));
        const Rgba stroke = parseColor(op.get("color"), opacity, Rgba{0, 0, 0, 255});
        const double width = jsonNumber(op.get("width"), 2.0);
        const JsonValue* fillColor = op.get("fillColor");
        const Rgba fill = parseColor(fillColor, jsonNumber(op.get("fillOpacity"), opacity), Rgba{255, 255, 255, 255});
        const JsonValue* r = op.get("rect");
        const double u = jsonNumber(r ? r->get("x") : nullptr, 0), v = jsonNumber(r ? r->get("y") : nullptr, 0);
        const double w = jsonNumber(r ? r->get("width") : nullptr, 0), h = jsonNumber(r ? r->get("height") : nullptr, 0);
        const Rgba* fillPtr = (fillColor && fillColor->isString()) ? &fill : nullptr;
        if (shape == "rect") {
            inserted = insertCommandsPath(page, rectCommandsJson(u, v, w, h), toUser, &stroke, width, fillPtr, nullptr);
        } else if (shape == "ellipse") {
            inserted = insertCommandsPath(page, ellipseCommandsJson(u, v, w, h), toUser, &stroke, width, fillPtr, nullptr);
        } else if (shape == "line" || shape == "arrow") {
            // rect encodes start (x, y) and end (x + width, y + height)
            const double x2 = u + w, y2 = v + h;
            std::ostringstream ss;
            ss << "[[\"M\"," << u << "," << v << "],[\"L\"," << x2 << "," << y2 << "]";
            if (shape == "arrow") {
                const double len = std::hypot(w, h);
                if (len > 0.001) {
                    const double head = std::max(6.0, width * 4.0);
                    const double ang = std::atan2(h, w);
                    const double a1 = ang + 2.6, a2 = ang - 2.6;
                    ss << ",[\"M\"," << x2 + head * std::cos(a1) << "," << y2 + head * std::sin(a1) << "],[\"L\"," << x2 << ","
                       << y2 << "],[\"L\"," << x2 + head * std::cos(a2) << "," << y2 + head * std::sin(a2) << "]";
                }
            }
            ss << "]";
            inserted = insertCommandsPath(page, ss.str(), toUser, &stroke, width, nullptr, nullptr);
        } else {
            error = "Unknown shape";
            return false;
        }
        if (!inserted) error = "Shape could not be drawn";
    } else if (type == "addHighlight") {
        // style: highlight (filled, multiply), underline / strikeout (line under / through)
        const std::string style = jsonString(op.get("style"), "highlight");
        const Rgba color = parseColor(op.get("color"), opacity,
                                      style == "highlight" ? Rgba{255, 214, 10, 255} : Rgba{255, 59, 48, 255});
        const JsonValue* rects = op.get("rects");
        if (!rects || !rects->isArray()) {
            error = "Highlight without rectangles";
            return false;
        }
        for (const JsonValue& rv : rects->arrayValue) {
            const double u = jsonNumber(rv.get("x"), 0), v = jsonNumber(rv.get("y"), 0);
            const double w = jsonNumber(rv.get("width"), 0), h = jsonNumber(rv.get("height"), 0);
            if (!(w > 0) || !(h > 0)) continue;
            if (style == "highlight") {
                inserted |= insertCommandsPath(page, rectCommandsJson(u, v, w, h), toUser, nullptr, 0, &color, "Multiply");
            } else {
                const double lineW = std::max(0.75, h * 0.07);
                const double y = style == "underline" ? v + h - lineW / 2 : v + h * 0.55;
                std::ostringstream ss;
                ss << "[[\"M\"," << u << "," << y << "],[\"L\"," << u + w << "," << y << "]]";
                inserted |= insertCommandsPath(page, ss.str(), toUser, &color, lineW, nullptr, nullptr);
            }
        }
        if (!inserted) error = "No valid rectangles";
    } else if (type == "addImage") {
        const std::string imagePath = jsonString(op.get("imagePath"));
        const JsonValue* r = op.get("rect");
        const double u = jsonNumber(r ? r->get("x") : nullptr, 0), v = jsonNumber(r ? r->get("y") : nullptr, 0);
        const double w = jsonNumber(r ? r->get("width") : nullptr, 0), h = jsonNumber(r ? r->get("height") : nullptr, 0);
        if (imagePath.empty() || !(w > 0) || !(h > 0)) {
            error = "Invalid image placement";
            return false;
        }
        MemoryFileAccess file;
        if (!file.load(imagePath)) {
            error = "Image file could not be read";
            return false;
        }
        FPDF_PAGEOBJECT image = FPDFPageObj_NewImageObj(doc);
        FPDF_PAGE pages[1] = {page};
        if (!image || !FPDFImageObj_LoadJpegFileInline(pages, 1, image, &file.access)) {
            if (image) FPDFPageObj_Destroy(image);
            error = "Image could not be embedded (JPEG required)";
            return false;
        }
        // Unit square -> display rect -> user space. The image is drawn upright on the displayed page.
        float x0, y0, x1, y1, x2, y2;
        toUser.map(u, v + h, x0, y0);      // image origin (bottom-left in display)
        toUser.map(u + w, v + h, x1, y1);  // + image x axis
        toUser.map(u, v, x2, y2);          // + image y axis (up)
        FPDFImageObj_SetMatrix(image, x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0);
        FPDFPage_InsertObject(page, image);
        inserted = true;
    } else if (type == "addText") {
        // One upright line of standard-14 text whose baseline starts at display point (x, y).
        // Used to write recognised (OCR) text back onto scanned pages.
        const std::string text = jsonString(op.get("text"));
        std::string font = jsonString(op.get("fontName"), "Helvetica");
        static const char* kStandard[] = {"Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
                                          "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
                                          "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"};
        bool known = false;
        for (const char* f : kStandard) known = known || font == f;
        if (!known) font = "Helvetica";
        const double size = std::clamp(jsonNumber(op.get("fontSize"), 12.0), 1.0, 400.0);
        const double x = jsonNumber(op.get("x"), 0), y = jsonNumber(op.get("y"), 0);
        if (text.empty()) {
            error = "Text is empty";
            return false;
        }
        for (uint32_t cp : pie::decodeCodePoints(text)) {
            if (!pie::isWinAnsiEncodable(cp)) {
                error = std::string(pie::kUnsupportedGlyphsPrefix) + "The standard font cannot display " +
                        pie::describeCodePoints({cp}) + ".";
                return false;
            }
        }
        FPDF_PAGEOBJECT obj = FPDFPageObj_NewTextObj(doc, font.c_str(), static_cast<float>(size));
        if (!obj) {
            error = "Text object could not be created";
            return false;
        }
        std::vector<FPDF_WCHAR> wide;
        for (uint16_t u : pie::utf8ToUtf16(text)) wide.push_back(static_cast<FPDF_WCHAR>(u));
        wide.push_back(0);
        if (!FPDFText_SetText(obj, wide.data())) {
            FPDFPageObj_Destroy(obj);
            error = "Text could not be set";
            return false;
        }
        const Rgba color = parseColor(op.get("color"), 1.0, Rgba{0, 0, 0, 255});
        FPDFPageObj_SetFillColor(obj, color.r, color.g, color.b, color.a);
        // Basis: x along the displayed page's +u, "up" along -v, origin at the baseline start.
        float ox, oy, ax, ay, bx, by;
        toUser.map(x, y, ox, oy);
        toUser.map(x + 1, y, ax, ay);
        toUser.map(x, y - 1, bx, by);
        FPDFPageObj_Transform(obj, ax - ox, ay - oy, bx - ox, by - oy, ox, oy);
        FPDFPage_InsertObject(page, obj);
        inserted = true;
    } else {
        error = "Unknown markup operation";
        return false;
    }
    return inserted;
}

// ---------------------------------------------------------------------------
// applyDocumentOperationsJson
// ---------------------------------------------------------------------------

inline std::string applyDocumentOperationsJson(const std::string& inputPath, const std::string& outputPath,
                                               const std::string& opsJson) {
    if (inputPath.empty() || outputPath.empty()) return errorJson("INVALID_ARGUMENTS", "Missing input or output path");
    if (inputPath == outputPath) {
        return errorJson("SAME_INPUT_OUTPUT", "Input and output must differ to preserve source immutability");
    }
    JsonValue root;
    std::string parseError;
    if (!pie::parseJson(opsJson, root, parseError)) return errorJson("INVALID_OPERATIONS_JSON", parseError);
    const JsonValue* ops = root.isObject() ? root.get("operations") : (root.isArray() ? &root : nullptr);
    if (!ops || !ops->isArray() || ops->arrayValue.empty()) {
        return errorJson("EMPTY_OPERATIONS", "No document operations were given");
    }

    const std::string hashBefore = fileChecksum(inputPath);
    if (hashBefore.empty()) return errorJson("PDF_FILE_NOT_FOUND", "Input PDF not found");

    FPDF_DOCUMENT doc = FPDF_LoadDocument(inputPath.c_str(), nullptr);
    if (!doc) return errorJson("PDF_OPEN_FAILED", "The PDF could not be opened");
    const int pageCountBefore = FPDF_GetPageCount(doc);
    std::vector<OpResult> results;
    bool allApplied = true;

    for (const JsonValue& op : ops->arrayValue) {
        OpResult r;
        r.type = jsonString(op.get("type"));
        r.pageIndex = jsonInt(op.get("pageIndex"), -1);
        const int count = FPDF_GetPageCount(doc);

        if (r.type == "rotatePage") {
            if (r.pageIndex < 0 || r.pageIndex >= count) {
                r.error = "Page index out of range";
            } else if (FPDF_PAGE page = FPDF_LoadPage(doc, r.pageIndex)) {
                const int delta = ((jsonInt(op.get("quarterTurns"), 1) % 4) + 4) % 4;
                int rot = FPDFPage_GetRotation(page);
                if (rot < 0 || rot > 3) rot = 0;
                FPDFPage_SetRotation(page, (rot + delta) % 4);
                FPDF_ClosePage(page);
                r.applied = true;
            } else {
                r.error = "Page could not be loaded";
            }
        } else if (r.type == "deletePage") {
            if (count <= 1) {
                r.error = "A PDF must keep at least one page";
            } else if (r.pageIndex < 0 || r.pageIndex >= count) {
                r.error = "Page index out of range";
            } else {
                FPDFPage_Delete(doc, r.pageIndex);
                r.applied = FPDF_GetPageCount(doc) == count - 1;
                if (!r.applied) r.error = "Page could not be deleted";
            }
        } else if (r.type == "movePage") {
            const int to = jsonInt(op.get("toIndex"), -1);
            if (r.pageIndex < 0 || r.pageIndex >= count || to < 0 || to >= count) {
                r.error = "Page index out of range";
            } else if (r.pageIndex == to) {
                r.applied = true;
            } else {
                const int indices[1] = {r.pageIndex};
                r.applied = FPDF_MovePages(doc, indices, 1, to) != 0;
                if (!r.applied) r.error = "Page could not be moved";
            }
        } else if (r.type == "insertBlankPage") {
            const int at = std::clamp(jsonInt(op.get("pageIndex"), count), 0, count);
            double w = jsonNumber(op.get("width"), 0), h = jsonNumber(op.get("height"), 0);
            if (!(w > 0) || !(h > 0)) {
                // Same size as the neighbouring page, else US Letter.
                const int ref = std::clamp(at > 0 ? at - 1 : 0, 0, std::max(0, count - 1));
                if (count == 0 || !FPDF_GetPageSizeByIndex(doc, ref, &w, &h)) {
                    w = 612;
                    h = 792;
                }
            }
            w = std::clamp(w, 36.0, 14400.0);
            h = std::clamp(h, 36.0, 14400.0);
            FPDF_PAGE page = FPDFPage_New(doc, at, w, h);
            if (page) {
                FPDFPage_GenerateContent(page);
                FPDF_ClosePage(page);
                r.pageIndex = at;
                r.applied = true;
            } else {
                r.error = "Blank page could not be created";
            }
        } else if (r.type == "duplicatePage") {
            if (r.pageIndex < 0 || r.pageIndex >= count) {
                r.error = "Page index out of range";
            } else {
                // Import from a separate instance of the (unchanged) input file.
                FPDF_DOCUMENT src = FPDF_LoadDocument(inputPath.c_str(), nullptr);
                if (src && r.pageIndex < FPDF_GetPageCount(src)) {
                    const int indices[1] = {r.pageIndex};
                    r.applied = FPDF_ImportPagesByIndex(doc, src, indices, 1, r.pageIndex + 1) != 0;
                }
                if (src) FPDF_CloseDocument(src);
                if (!r.applied) r.error = "Page could not be duplicated";
            }
        } else if (r.type == "addInk" || r.type == "addShape" || r.type == "addHighlight" || r.type == "addImage" ||
                   r.type == "addText") {
            if (r.pageIndex < 0 || r.pageIndex >= count) {
                r.error = "Page index out of range";
            } else if (FPDF_PAGE page = FPDF_LoadPage(doc, r.pageIndex)) {
                r.applied = applyMarkup(doc, page, r.pageIndex, op, r.error);
                if (r.applied && !FPDFPage_GenerateContent(page)) {
                    r.applied = false;
                    r.error = "Page content could not be generated";
                }
                FPDF_ClosePage(page);
            } else {
                r.error = "Page could not be loaded";
            }
        } else {
            r.error = "Unknown operation type";
        }
        if (!r.applied) allApplied = false;
        results.push_back(r);
    }

    if (!allApplied) {
        FPDF_CloseDocument(doc);
        std::string first;
        for (const auto& r : results) {
            if (!r.applied) {
                first = r.type + ": " + r.error;
                break;
            }
        }
        return errorJson("OPERATION_FAILED", first.empty() ? "An operation failed" : first);
    }

    const int pageCountAfter = FPDF_GetPageCount(doc);
    std::string saveError;
    const bool saved = saveDocumentTo(doc, outputPath, saveError);
    FPDF_CloseDocument(doc);
    if (!saved) return errorJson("PDF_SAVE_FAILED", saveError);

    std::string verifyError;
    const bool verified = verifyOutput(outputPath, pageCountAfter, verifyError);
    const std::string hashAfter = fileChecksum(inputPath);
    const bool sourceUnchanged = hashAfter == hashBefore;
    if (!verified || !sourceUnchanged) {
        std::remove(outputPath.c_str());
        return errorJson(verified ? "SOURCE_MODIFIED" : "PDF_VERIFY_FAILED",
                         verified ? "The source PDF changed during the operation" : verifyError);
    }

    std::ostringstream ss;
    ss << "{\"success\":true,\"outputPath\":\"" << escapeJsonString(outputPath) << "\",\"pageCountBefore\":"
       << pageCountBefore << ",\"pageCountAfter\":" << pageCountAfter
       << ",\"verified\":true,\"sourceUnchanged\":true,\"sourceShaBefore\":\"" << hashBefore
       << "\",\"sourceShaAfter\":\"" << hashAfter << "\",\"operations\":[";
    for (size_t i = 0; i < results.size(); ++i) {
        if (i > 0) ss << ",";
        ss << "{\"type\":\"" << escapeJsonString(results[i].type) << "\",\"pageIndex\":" << results[i].pageIndex
           << ",\"applied\":" << (results[i].applied ? "true" : "false") << "}";
    }
    ss << "]}";
    return ss.str();
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

inline std::string mergeDocumentsJson(const std::string& inputsJson, const std::string& outputPath) {
    JsonValue inputs;
    std::string parseError;
    if (!pie::parseJson(inputsJson, inputs, parseError) || !inputs.isArray() || inputs.arrayValue.size() < 2) {
        return errorJson("INVALID_ARGUMENTS", "At least two PDFs are required to merge");
    }
    FPDF_DOCUMENT dest = FPDF_CreateNewDocument();
    if (!dest) return errorJson("PDF_CREATE_FAILED", "Could not create the merged PDF");
    int total = 0;
    for (const JsonValue& v : inputs.arrayValue) {
        const std::string path = jsonString(&v);
        if (path.empty() || path == outputPath) {
            FPDF_CloseDocument(dest);
            return errorJson("INVALID_ARGUMENTS", "Invalid input path");
        }
        FPDF_DOCUMENT src = FPDF_LoadDocument(path.c_str(), nullptr);
        if (!src) {
            const unsigned long err = FPDF_GetLastError();
            FPDF_CloseDocument(dest);
            return errorJson(err == FPDF_ERR_PASSWORD ? "PDF_PASSWORD_REQUIRED" : "PDF_OPEN_FAILED",
                             err == FPDF_ERR_PASSWORD ? "One of the PDFs is password protected"
                                                       : "One of the PDFs could not be opened");
        }
        const int n = FPDF_GetPageCount(src);
        const bool ok = n > 0 && FPDF_ImportPages(dest, src, nullptr, total) != 0;
        FPDF_CloseDocument(src);
        if (!ok) {
            FPDF_CloseDocument(dest);
            return errorJson("PDF_MERGE_FAILED", "Pages could not be combined");
        }
        total += n;
    }
    std::string saveError;
    const bool saved = saveDocumentTo(dest, outputPath, saveError);
    FPDF_CloseDocument(dest);
    if (!saved) return errorJson("PDF_SAVE_FAILED", saveError);
    std::string verifyError;
    if (!verifyOutput(outputPath, total, verifyError)) {
        std::remove(outputPath.c_str());
        return errorJson("PDF_VERIFY_FAILED", verifyError);
    }
    std::ostringstream ss;
    ss << "{\"success\":true,\"outputPath\":\"" << escapeJsonString(outputPath) << "\",\"pageCount\":" << total << "}";
    return ss.str();
}

// ---------------------------------------------------------------------------
// Images -> PDF
// ---------------------------------------------------------------------------

/**
 * spec: {"images":[{"path":"/x.jpg","width":px,"height":px}], "pageSize":"fit"|"a4"|"letter",
 *        "margin": points}
 * "fit" makes each page the image's size at 72 dpi scaled so the long side is 842 pt.
 */
inline std::string createPdfFromImagesJson(const std::string& specJson, const std::string& outputPath) {
    JsonValue spec;
    std::string parseError;
    if (!pie::parseJson(specJson, spec, parseError) || !spec.isObject()) {
        return errorJson("INVALID_ARGUMENTS", parseError.empty() ? "Invalid specification" : parseError);
    }
    const JsonValue* images = spec.get("images");
    if (!images || !images->isArray() || images->arrayValue.empty()) {
        return errorJson("INVALID_ARGUMENTS", "No images were given");
    }
    const std::string pageSize = jsonString(spec.get("pageSize"), "fit");
    const double margin = std::clamp(jsonNumber(spec.get("margin"), 0.0), 0.0, 144.0);
    FPDF_DOCUMENT doc = FPDF_CreateNewDocument();
    if (!doc) return errorJson("PDF_CREATE_FAILED", "Could not create the PDF");
    int index = 0;
    for (const JsonValue& img : images->arrayValue) {
        const std::string path = jsonString(img.get("path"));
        const double iw = jsonNumber(img.get("width"), 0), ih = jsonNumber(img.get("height"), 0);
        if (path.empty() || !(iw > 0) || !(ih > 0)) {
            FPDF_CloseDocument(doc);
            return errorJson("INVALID_ARGUMENTS", "Invalid image entry");
        }
        double pw, ph;
        if (pageSize == "a4" || pageSize == "letter") {
            pw = pageSize == "a4" ? 595.28 : 612.0;
            ph = pageSize == "a4" ? 841.89 : 792.0;
            if (iw > ih) std::swap(pw, ph);  // landscape image -> landscape page
        } else {
            const double scale = 842.0 / std::max(iw, ih);
            pw = std::max(72.0, iw * scale + 2 * margin);
            ph = std::max(72.0, ih * scale + 2 * margin);
        }
        FPDF_PAGE page = FPDFPage_New(doc, index, pw, ph);
        if (!page) {
            FPDF_CloseDocument(doc);
            return errorJson("PDF_CREATE_FAILED", "Could not add a page");
        }
        MemoryFileAccess file;
        FPDF_PAGEOBJECT image = FPDFPageObj_NewImageObj(doc);
        FPDF_PAGE pages[1] = {page};
        if (!file.load(path) || !image || !FPDFImageObj_LoadJpegFileInline(pages, 1, image, &file.access)) {
            if (image) FPDFPageObj_Destroy(image);
            FPDF_ClosePage(page);
            FPDF_CloseDocument(doc);
            return errorJson("IMAGE_EMBED_FAILED", "An image could not be added to the PDF");
        }
        const double availW = pw - 2 * margin, availH = ph - 2 * margin;
        const double s = std::min(availW / iw, availH / ih);
        const double w = iw * s, h = ih * s;
        const double x = (pw - w) / 2, y = (ph - h) / 2;
        FPDFImageObj_SetMatrix(image, w, 0, 0, h, x, y);
        FPDFPage_InsertObject(page, image);
        FPDFPage_GenerateContent(page);
        FPDF_ClosePage(page);
        ++index;
    }
    std::string saveError;
    const bool saved = saveDocumentTo(doc, outputPath, saveError);
    FPDF_CloseDocument(doc);
    if (!saved) return errorJson("PDF_SAVE_FAILED", saveError);
    std::string verifyError;
    if (!verifyOutput(outputPath, index, verifyError)) {
        std::remove(outputPath.c_str());
        return errorJson("PDF_VERIFY_FAILED", verifyError);
    }
    std::ostringstream ss;
    ss << "{\"success\":true,\"outputPath\":\"" << escapeJsonString(outputPath) << "\",\"pageCount\":" << index << "}";
    return ss.str();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

inline std::string textRange(FPDF_TEXTPAGE textPage, int start, int count) {
    if (count <= 0) return "";
    std::vector<unsigned short> buf(static_cast<size_t>(count) + 1, 0);
    const int written = FPDFText_GetText(textPage, start, count, buf.data());
    if (written <= 0) return "";
    return pie::utf16ToUtf8(reinterpret_cast<const uint16_t*>(buf.data()), static_cast<size_t>(written), true);
}

/**
 * Case-insensitive search over all pages. Returns
 * {"results":[{"pageIndex":n,"charIndex":i,"snippet":"...","matchStart":k,"matchLength":m,
 *   "rects":[{"x","y","width","height"}]}],"truncated":bool}
 * Rectangles are display-space points (same space as extracted text bounds).
 */
inline std::string searchDocumentJson(FPDF_DOCUMENT doc, const std::string& query, int maxResults) {
    std::ostringstream ss;
    ss << "{\"results\":[";
    if (!doc || query.empty()) {
        ss << "],\"truncated\":false}";
        return ss.str();
    }
    std::vector<FPDF_WCHAR> needle;
    for (uint16_t u : pie::utf8ToUtf16(query)) needle.push_back(static_cast<FPDF_WCHAR>(u));
    needle.push_back(0);
    const int pageCount = FPDF_GetPageCount(doc);
    int total = 0;
    bool truncated = false;
    bool first = true;
    for (int p = 0; p < pageCount && !truncated; ++p) {
        FPDF_PAGE page = FPDF_LoadPage(doc, p);
        if (!page) continue;
        FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
        if (!textPage) {
            FPDF_ClosePage(page);
            continue;
        }
        const FS_MATRIX m = pageDisplayMatrix(doc, page, p);
        const int charCount = FPDFText_CountChars(textPage);
        FPDF_SCHHANDLE search = FPDFText_FindStart(textPage, needle.data(), 0, 0);
        while (search && FPDFText_FindNext(search)) {
            if (total >= maxResults) {
                truncated = true;
                break;
            }
            const int start = FPDFText_GetSchResultIndex(search);
            const int len = FPDFText_GetSchCount(search);
            const int ctxStart = std::max(0, start - 32);
            const int ctxEnd = std::min(charCount, start + len + 48);
            const std::string before = textRange(textPage, ctxStart, start - ctxStart);
            const std::string match = textRange(textPage, start, len);
            const std::string after = textRange(textPage, start + len, ctxEnd - (start + len));
            if (!first) ss << ",";
            first = false;
            ss << "{\"pageIndex\":" << p << ",\"charIndex\":" << start << ",\"snippet\":\""
               << escapeJsonString(before + match + after) << "\",\"matchStart\":"
               << pie::utf8ToUtf16(before).size() << ",\"matchLength\":" << pie::utf8ToUtf16(match).size()
               << ",\"rects\":[";
            const int rectCount = FPDFText_CountRects(textPage, start, len);
            for (int r = 0; r < rectCount; ++r) {
                double l = 0, t = 0, rr = 0, b = 0;
                if (!FPDFText_GetRect(textPage, r, &l, &t, &rr, &b)) continue;
                float xs[4], ys[4];
                const double px[4] = {l, rr, l, rr}, py[4] = {t, t, b, b};
                for (int k = 0; k < 4; ++k) {
                    xs[k] = static_cast<float>(m.a * px[k] + m.c * py[k] + m.e);
                    ys[k] = static_cast<float>(m.b * px[k] + m.d * py[k] + m.f);
                }
                const float minX = *std::min_element(xs, xs + 4), maxX = *std::max_element(xs, xs + 4);
                const float minY = *std::min_element(ys, ys + 4), maxY = *std::max_element(ys, ys + 4);
                if (r > 0) ss << ",";
                ss << "{\"x\":" << minX << ",\"y\":" << minY << ",\"width\":" << (maxX - minX)
                   << ",\"height\":" << (maxY - minY) << "}";
            }
            ss << "]}";
            ++total;
        }
        if (search) FPDFText_FindClose(search);
        FPDFText_ClosePage(textPage);
        FPDF_ClosePage(page);
    }
    ss << "],\"truncated\":" << (truncated ? "true" : "false") << "}";
    return ss.str();
}

/** Plain text of one page (for Copy / Share text). */
inline std::string pageTextJson(FPDF_DOCUMENT doc, int pageIndex) {
    std::string text;
    if (doc && pageIndex >= 0 && pageIndex < FPDF_GetPageCount(doc)) {
        if (FPDF_PAGE page = FPDF_LoadPage(doc, pageIndex)) {
            if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(page)) {
                text = textRange(tp, 0, FPDFText_CountChars(tp));
                FPDFText_ClosePage(tp);
            }
            FPDF_ClosePage(page);
        }
    }
    return "{\"pageIndex\":" + std::to_string(pageIndex) + ",\"text\":\"" + escapeJsonString(text) + "\"}";
}

}  // namespace pie_pdf
