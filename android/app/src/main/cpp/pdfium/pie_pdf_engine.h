// PIE — platform-neutral PDFium engine API (implemented in pdfium_bridge.cpp).
//
// Android calls it through thin JNI wrappers; iOS through the PieNative Objective-C++ module.
// Every function is thread-safe (one global lock) and returns plain C++ types / JSON strings
// with exactly the contract the JavaScript PdfiumEngine already parses.
#pragma once

#include <cstdint>
#include <string>

namespace pie_engine {

void initLibrary();
void destroyLibrary();

/** Returns a positive handle, or 0 on failure (see lastError()). */
int64_t openDocument(const std::string& filePath, const char* password);
void closeDocument(int64_t docHandle);
/** -1 for an invalid handle. */
int getPageCount(int64_t docHandle);
bool getPageSize(int64_t docHandle, int pageIndex, double& width, double& height);
/** [displayWidth, displayHeight, rotationQuarterTurns, a, b, c, d, e, f]. */
bool getPageGeometry(int64_t docHandle, int pageIndex, double out[9]);

/** rgbaOrder: true = R,G,B,A bytes in memory (Android); false = B,G,R,A (iOS BGRA). */
bool renderPageToBuffer(int64_t docHandle, int pageIndex, void* pixels, int width, int height, int stride, bool rgbaOrder);
bool renderRegionToBuffer(int64_t docHandle, int pageIndex, void* pixels, int width, int height, int stride,
                          double scale, double left, double top, bool rgbaOrder);

std::string getTextObjectsJson(int64_t docHandle, int pageIndex);
/** PDFium error code of the calling thread's last failed openDocument() (0 after a success). */
int lastError();

std::string replaceTextObjectJson(const std::string& inputPath, const std::string& outputPath, int pageIndex,
                                  int objectIndex, const std::string& replacementText);
std::string applyBatchEditsJson(const std::string& inputPath, const std::string& outputPath, const std::string& editsJson);

std::string applyDocumentOperationsJson(const std::string& inputPath, const std::string& outputPath, const std::string& opsJson);
std::string mergeDocumentsJson(const std::string& inputsJson, const std::string& outputPath);
std::string createPdfFromImagesJson(const std::string& specJson, const std::string& outputPath);
std::string searchDocumentJson(int64_t docHandle, const std::string& query, int maxResults);
std::string pageTextJson(int64_t docHandle, int pageIndex);
/** Characters of a page for character-level selection (see pdfium_bridge.cpp). */
std::string pageCharsJson(int64_t docHandle, int pageIndex);

}  // namespace pie_engine
