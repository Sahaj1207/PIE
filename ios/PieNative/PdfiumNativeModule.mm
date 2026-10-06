// PIE — PDFium native module for iOS (same JS contract as NativePdfiumModule.kt).
// All PDF logic comes from the shared C++ engine (pie_pdf_engine.h, implemented in
// android/app/src/main/cpp/pdfium/pdfium_bridge.cpp); this file only handles iOS files,
// pickers, rendering into CoreGraphics bitmaps and sharing.
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "PieNativeUtils.h"

#include <cmath>
#include <string>
#include "pie_pdf_engine.h"

static const long long kMaxRegionPixels = 16LL * 1024 * 1024;
static const long long kMaxPagePixels = 32LL * 1024 * 1024;
static const NSUInteger kMaxEmbedImageSide = 3000;

static std::string S(NSString *s) {
  return s ? std::string(s.UTF8String ?: "") : std::string();
}

static NSString *N(const std::string &s) {
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
}

@interface PdfiumNativeModule : NSObject <RCTBridgeModule>
@property (nonatomic, strong) PieDocumentPickerDelegate *pickerDelegate;
@end

@implementation PdfiumNativeModule {
  dispatch_queue_t _queue;
}

RCT_EXPORT_MODULE(PdfiumNativeModule)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("pie.pdfium", DISPATCH_QUEUE_SERIAL);
    pie_engine::initLibrary();
  }
  return self;
}

- (dispatch_queue_t)methodQueue {
  return _queue;
}

// -------------------------------------------------------------------------------------------
// Rendering helpers
// -------------------------------------------------------------------------------------------

/** Renders into a BGRA CoreGraphics bitmap and writes a PNG. Returns NO on failure. */
- (BOOL)renderPNG:(NSString *)outPath
            width:(int)w
           height:(int)h
           render:(bool (^)(void *pixels, int stride))render {
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, cs,
                                           kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGColorSpaceRelease(cs);
  if (!ctx) return NO;
  BOOL ok = render(CGBitmapContextGetData(ctx), (int)CGBitmapContextGetBytesPerRow(ctx));
  if (ok) {
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    ok = image && PieWriteImage(image, outPath, YES, 1.0);
    if (image) CGImageRelease(image);
  }
  CGContextRelease(ctx);
  return ok;
}

- (NSString *)resolvePath:(NSString *)path {
  return PiePlainPath(path ?: @"");
}

// -------------------------------------------------------------------------------------------
// Pickers
// -------------------------------------------------------------------------------------------

- (NSDictionary *)copyPickedPdf:(NSURL *)url {
  BOOL scoped = [url startAccessingSecurityScopedResource];
  NSString *name = url.lastPathComponent ?: @"Document.pdf";
  NSString *dir = PieCacheDir(@"picked_pdfs");
  NSString *safe = PieSanitizeFileName(name, @"Document", nil);
  NSString *dest = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@_%@", PieUniqueStamp(), safe]];
  NSError *error = nil;
  BOOL ok = [[NSFileManager defaultManager] copyItemAtURL:url toURL:[NSURL fileURLWithPath:dest] error:&error];
  if (scoped) [url stopAccessingSecurityScopedResource];
  if (!ok) return nil;
  unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:dest error:nil] fileSize];
  return @{@"filePath": dest, @"fileName": name, @"fileSize": @(size)};
}

- (void)presentPdfPickerMultiple:(BOOL)multiple completion:(void (^)(NSArray<NSURL *> *urls))completion {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *top = PieTopViewController();
    if (!top) {
      completion(@[]);
      return;
    }
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypePDF] asCopy:YES];
    picker.allowsMultipleSelection = multiple;
    PieDocumentPickerDelegate *delegate = [PieDocumentPickerDelegate new];
    __weak PdfiumNativeModule *weakSelf = self;
    delegate.onPick = ^(NSArray<NSURL *> *urls) {
      weakSelf.pickerDelegate = nil;
      completion(urls);
    };
    delegate.onCancel = ^{
      weakSelf.pickerDelegate = nil;
      completion(@[]);
    };
    self.pickerDelegate = delegate;
    picker.delegate = delegate;
    picker.presentationController.delegate = delegate;
    [top presentViewController:picker animated:YES completion:nil];
  });
}

RCT_EXPORT_METHOD(pickPdfDocument:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self presentPdfPickerMultiple:NO completion:^(NSArray<NSURL *> *urls) {
    if (urls.count == 0) return resolve([NSNull null]);
    dispatch_async(self->_queue, ^{
      NSDictionary *picked = [self copyPickedPdf:urls.firstObject];
      if (!picked) return reject(@"PICK_PDF_ERROR", @"Failed to load the picked PDF", nil);
      resolve(picked);
    });
  }];
}

RCT_EXPORT_METHOD(pickPdfDocuments:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self presentPdfPickerMultiple:YES completion:^(NSArray<NSURL *> *urls) {
    dispatch_async(self->_queue, ^{
      NSMutableArray *out = [NSMutableArray array];
      for (NSURL *url in urls) {
        NSDictionary *picked = [self copyPickedPdf:url];
        if (!picked) return reject(@"PICK_PDF_ERROR", @"Failed to load a picked PDF", nil);
        [out addObject:picked];
      }
      resolve(out);
    });
  }];
}

// -------------------------------------------------------------------------------------------
// Documents
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(openDocument:(NSString *)filePath password:(NSString *)password resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *path = [self resolvePath:filePath];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    return reject(@"PDF_FILE_NOT_FOUND", [NSString stringWithFormat:@"PDF file not found at path: %@", path], nil);
  }
  std::string pw = S(password);
  int64_t handle = pie_engine::openDocument(S(path), password ? pw.c_str() : nullptr);
  if (handle <= 0) {
    int err = pie_engine::lastError();
    switch (err) {
      case 2: return reject(@"PDF_FILE_NOT_FOUND", @"Cannot open file or file does not exist", nil);
      case 3: return reject(@"PDF_FORMAT_CORRUPT", @"Corrupted or invalid PDF format", nil);
      case 4: return reject(@"PDF_PASSWORD_REQUIRED", @"Password required or incorrect password", nil);
      case 5: return reject(@"PDF_SECURITY_UNSUPPORTED", @"Unsupported security scheme", nil);
      case 6: return reject(@"PDF_PAGE_ERROR", @"Page error or invalid document content", nil);
      default: return reject(@"PDF_OPEN_FAILED", [NSString stringWithFormat:@"Failed to open PDF document (error code: %d)", err], nil);
    }
  }
  unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil] fileSize];
  resolve(@{
    @"docHandle": @((double)handle),
    @"pageCount": @(pie_engine::getPageCount(handle)),
    @"filePath": path,
    @"fileSizeBytes": @(size),
  });
}

RCT_EXPORT_METHOD(closeDocument:(double)docHandle resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  pie_engine::closeDocument((int64_t)docHandle);
  resolve(@YES);
}

RCT_EXPORT_METHOD(getPageCount:(double)docHandle resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  int count = pie_engine::getPageCount((int64_t)docHandle);
  if (count < 0) return reject(@"PDF_INVALID_HANDLE", @"Invalid or closed document handle", nil);
  resolve(@(count));
}

RCT_EXPORT_METHOD(getPageSize:(double)docHandle pageIndex:(NSInteger)pageIndex resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  double w = 0, h = 0;
  if (!pie_engine::getPageSize((int64_t)docHandle, (int)pageIndex, w, h)) {
    return reject(@"PDF_PAGE_SIZE_ERROR", [NSString stringWithFormat:@"Failed to get page size for page %ld", (long)pageIndex], nil);
  }
  NSMutableDictionary *result = [@{@"width": @(w), @"height": @(h), @"pageIndex": @(pageIndex)} mutableCopy];
  double g[9];
  if (pie_engine::getPageGeometry((int64_t)docHandle, (int)pageIndex, g)) {
    result[@"rotation"] = @(((int)g[2] * 90) % 360);
    result[@"displayMatrix"] = @{@"a": @(g[3]), @"b": @(g[4]), @"c": @(g[5]), @"d": @(g[6]), @"e": @(g[7]), @"f": @(g[8])};
  }
  resolve(result);
}

RCT_EXPORT_METHOD(renderPage:(double)docHandle pageIndex:(NSInteger)pageIndex scale:(double)scale resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  double s = scale <= 0 ? 1.5 : scale;
  double pw = 0, ph = 0;
  if (!pie_engine::getPageSize((int64_t)docHandle, (int)pageIndex, pw, ph)) {
    return reject(@"PDF_PAGE_NOT_FOUND", [NSString stringWithFormat:@"Page index %ld out of range or not found", (long)pageIndex], nil);
  }
  int w = MAX(1, (int)ceil(pw * s));
  int h = MAX(1, (int)ceil(ph * s));
  if ((long long)w * h > kMaxPagePixels) return reject(@"PDF_RENDER_TOO_LARGE", @"Page render exceeds the pixel budget", nil);
  NSString *out = [PieCacheDir(@"pdfium_renders") stringByAppendingPathComponent:[NSString stringWithFormat:@"page_%ld_%@.png", (long)pageIndex, PieUniqueStamp()]];
  int64_t handle = (int64_t)docHandle;
  int idx = (int)pageIndex;
  BOOL ok = [self renderPNG:out width:w height:h render:^bool(void *pixels, int stride) {
    return pie_engine::renderPageToBuffer(handle, idx, pixels, w, h, stride, false);
  }];
  if (!ok) return reject(@"PDF_RENDER_FAILED", @"Native PDFium rendering failed", nil);
  resolve(@{@"filePath": out, @"uri": PieFileUri(out), @"width": @(w), @"height": @(h), @"pageWidth": @(pw), @"pageHeight": @(ph), @"scale": @(s), @"pageIndex": @(pageIndex)});
}

RCT_EXPORT_METHOD(renderPageRegion:(double)docHandle pageIndex:(NSInteger)pageIndex scale:(double)scale left:(double)left top:(double)top width:(double)width height:(double)height resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!(scale > 0) || !(width > 0) || !(height > 0)) return reject(@"PDF_RENDER_REGION_INVALID", @"Invalid region render request", nil);
  int w = MAX(1, (int)ceil(width * scale));
  int h = MAX(1, (int)ceil(height * scale));
  if ((long long)w * h > kMaxRegionPixels) return reject(@"PDF_RENDER_REGION_TOO_LARGE", @"Region render exceeds the pixel budget", nil);
  NSString *out = [PieCacheDir(@"pdfium_renders") stringByAppendingPathComponent:[NSString stringWithFormat:@"region_%ld_%@.png", (long)pageIndex, PieUniqueStamp()]];
  int64_t handle = (int64_t)docHandle;
  int idx = (int)pageIndex;
  BOOL ok = [self renderPNG:out width:w height:h render:^bool(void *pixels, int stride) {
    return pie_engine::renderRegionToBuffer(handle, idx, pixels, w, h, stride, scale, left, top, false);
  }];
  if (!ok) return reject(@"PDF_RENDER_FAILED", @"Native PDFium region rendering failed", nil);
  resolve(@{@"filePath": out, @"uri": PieFileUri(out), @"width": @(w), @"height": @(h), @"scale": @(scale), @"pageIndex": @(pageIndex), @"left": @(left), @"top": @(top), @"regionWidth": @(width), @"regionHeight": @(height)});
}

RCT_EXPORT_METHOD(getTextObjects:(double)docHandle pageIndex:(NSInteger)pageIndex resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(N(pie_engine::getTextObjectsJson((int64_t)docHandle, (int)pageIndex)));
}

- (NSString *)prepareOutput:(NSString *)outputPath error:(NSString **)error {
  NSString *out = [self resolvePath:outputPath];
  if (!PieIsAppPrivatePath(out)) {
    if (error) *error = @"Output must be inside app storage";
    return nil;
  }
  [[NSFileManager defaultManager] createDirectoryAtPath:[out stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:nil];
  return out;
}

RCT_EXPORT_METHOD(replaceTextObject:(NSString *)inputPath outputPath:(NSString *)outputPath pageIndex:(NSInteger)pageIndex objectIndex:(NSInteger)objectIndex replacementText:(NSString *)replacementText resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *in = [self resolvePath:inputPath];
  NSString *err = nil;
  NSString *out = [self prepareOutput:outputPath error:&err];
  if (!out) return reject(@"PDF_REPLACEMENT_ERROR", err, nil);
  if ([in isEqualToString:out]) return reject(@"SAME_INPUT_OUTPUT", @"Input path and output path must be different to preserve source immutability", nil);
  resolve(N(pie_engine::replaceTextObjectJson(S(in), S(out), (int)pageIndex, (int)objectIndex, S(replacementText))));
}

RCT_EXPORT_METHOD(applyBatchEdits:(NSString *)inputPath outputPath:(NSString *)outputPath editsJson:(NSString *)editsJson resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *in = [self resolvePath:inputPath];
  if (![[NSFileManager defaultManager] fileExistsAtPath:in]) return reject(@"PDF_FILE_NOT_FOUND", @"Input PDF file not found", nil);
  NSString *err = nil;
  NSString *out = [self prepareOutput:outputPath error:&err];
  if (!out) return reject(@"PDF_BATCH_EDIT_ERROR", err, nil);
  if ([in isEqualToString:out]) return reject(@"SAME_INPUT_OUTPUT", @"Input path and output path must be different to preserve source immutability", nil);
  if (editsJson.length == 0) return reject(@"EMPTY_EDITS", @"Edits JSON cannot be empty", nil);
  resolve(N(pie_engine::applyBatchEditsJson(S(in), S(out), S(editsJson))));
}

RCT_EXPORT_METHOD(extractAssetPdf:(NSString *)assetName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *src = [[NSBundle mainBundle] pathForResource:[assetName stringByDeletingPathExtension] ofType:assetName.pathExtension];
  if (!src) return reject(@"ASSET_EXTRACT_ERROR", @"Asset not found", nil);
  NSString *dest = [PieDocumentsRoot() stringByAppendingPathComponent:assetName];
  [[NSFileManager defaultManager] removeItemAtPath:dest error:nil];
  NSError *error = nil;
  if (![[NSFileManager defaultManager] copyItemAtPath:src toPath:dest error:&error]) return reject(@"ASSET_EXTRACT_ERROR", error.localizedDescription, error);
  resolve(dest);
}

RCT_EXPORT_METHOD(moveFile:(NSString *)fromPath toPath:(NSString *)toPath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *src = [self resolvePath:fromPath];
  NSString *dst = [self resolvePath:toPath];
  if (!PieIsAppPrivatePath(src) || !PieIsAppPrivatePath(dst)) return reject(@"PDF_MOVE_REJECTED", @"PDF move is restricted to app-private storage", nil);
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:src]) return reject(@"PDF_FILE_NOT_FOUND", @"Source PDF not found", nil);
  [fm createDirectoryAtPath:[dst stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:nil];
  NSError *error = nil;
  if ([fm fileExistsAtPath:dst]) {
    if (![fm replaceItemAtURL:[NSURL fileURLWithPath:dst] withItemAtURL:[NSURL fileURLWithPath:src] backupItemName:nil options:0 resultingItemURL:nil error:&error]) {
      return reject(@"PDF_MOVE_FAILED", error.localizedDescription, error);
    }
  } else if (![fm moveItemAtPath:src toPath:dst error:&error]) {
    return reject(@"PDF_MOVE_FAILED", error.localizedDescription, error);
  }
  resolve(dst);
}

- (NSInteger)purgeDir:(NSString *)dir keep:(NSSet<NSString *> *)keep {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSInteger removed = 0;
  for (NSString *name in [fm contentsOfDirectoryAtPath:dir error:nil]) {
    NSString *p = [dir stringByAppendingPathComponent:name];
    if ([keep containsObject:p]) continue;
    if ([fm removeItemAtPath:p error:nil]) removed++;
  }
  return removed;
}

- (NSSet<NSString *> *)keepSet:(NSArray *)keepPaths {
  NSMutableSet *keep = [NSMutableSet set];
  for (id p in keepPaths) {
    if ([p isKindOfClass:[NSString class]]) [keep addObject:[self resolvePath:p]];
  }
  return keep;
}

RCT_EXPORT_METHOD(purgeRenderCache:(NSArray *)keepPaths resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@([self purgeDir:PieCacheDir(@"pdfium_renders") keep:[self keepSet:keepPaths]]));
}

RCT_EXPORT_METHOD(purgeImportCache:(NSArray *)keepPaths resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSSet *keep = [self keepSet:keepPaths];
  resolve(@([self purgeDir:PieCacheDir(@"picked_pdfs") keep:keep] + [self purgeDir:PieCacheDir(@"resolved_pdfs") keep:keep]));
}

// -------------------------------------------------------------------------------------------
// Output: Save a Copy / Share (only verified app-private PDFs)
// -------------------------------------------------------------------------------------------

- (NSString *)verifiablePdf:(NSString *)path error:(NSString **)error {
  NSString *p = [self resolvePath:path];
  if (!PieIsAppPrivatePath(p)) {
    if (error) *error = @"Only PDFs stored by the app can be exported";
    return nil;
  }
  NSFileHandle *fh = [NSFileHandle fileHandleForReadingAtPath:p];
  NSData *header = [fh readDataOfLength:5];
  [fh closeFile];
  if (header.length != 5 || ![[[NSString alloc] initWithData:header encoding:NSASCIIStringEncoding] isEqualToString:@"%PDF-"]) {
    if (error) *error = @"The file to export is not a PDF";
    return nil;
  }
  return p;
}

RCT_EXPORT_METHOD(saveCopyToUserLocation:(NSString *)sourcePath suggestedName:(NSString *)suggestedName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *err = nil;
  NSString *source = [self verifiablePdf:sourcePath error:&err];
  if (!source) return reject(@"PDF_SAVE_AS_SOURCE_INVALID", err, nil);
  // The exported copy carries the chosen file name.
  NSString *stageDir = [PieCacheDir(@"pdf_exports") stringByAppendingPathComponent:PieUniqueStamp()];
  [[NSFileManager defaultManager] createDirectoryAtPath:stageDir withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *staged = [stageDir stringByAppendingPathComponent:PieSanitizeFileName(suggestedName, @"Document", @"pdf")];
  NSError *copyError = nil;
  if (![[NSFileManager defaultManager] copyItemAtPath:source toPath:staged error:&copyError]) {
    return reject(@"PDF_SAVE_AS_WRITE_FAILED", copyError.localizedDescription, copyError);
  }
  NSString *expectedHash = PieSha256OfFile(source);
  unsigned long long expectedSize = [[[NSFileManager defaultManager] attributesOfItemAtPath:source error:nil] fileSize];
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *top = PieTopViewController();
    if (!top) return reject(@"ACTIVITY_NOT_FOUND", @"Cannot open the save location picker", nil);
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForExportingURLs:@[[NSURL fileURLWithPath:staged]] asCopy:YES];
    PieDocumentPickerDelegate *delegate = [PieDocumentPickerDelegate new];
    __weak PdfiumNativeModule *weakSelf = self;
    delegate.onPick = ^(NSArray<NSURL *> *urls) {
      weakSelf.pickerDelegate = nil;
      NSURL *dest = urls.firstObject;
      if (!dest) return resolve([NSNull null]);
      dispatch_async(self->_queue, ^{
        // Read the destination back: only a byte-identical copy counts as saved.
        BOOL scoped = [dest startAccessingSecurityScopedResource];
        NSString *destHash = dest.isFileURL ? PieSha256OfFile(dest.path) : nil;
        unsigned long long destSize = [[[NSFileManager defaultManager] attributesOfItemAtPath:dest.path error:nil] fileSize];
        if (scoped) [dest stopAccessingSecurityScopedResource];
        [[NSFileManager defaultManager] removeItemAtPath:stageDir error:nil];
        if (destHash && ![destHash isEqualToString:expectedHash ?: @""]) {
          return reject(@"PDF_SAVE_AS_VERIFY_FAILED", @"The saved copy does not match the verified PDF", nil);
        }
        resolve(@{@"uri": dest.absoluteString, @"displayName": dest.lastPathComponent ?: @"", @"sizeBytes": @(destSize > 0 ? destSize : expectedSize)});
      });
    };
    delegate.onCancel = ^{
      weakSelf.pickerDelegate = nil;
      [[NSFileManager defaultManager] removeItemAtPath:stageDir error:nil];
      resolve([NSNull null]);
    };
    self.pickerDelegate = delegate;
    picker.delegate = delegate;
    picker.presentationController.delegate = delegate;
    [top presentViewController:picker animated:YES completion:nil];
  });
}

RCT_EXPORT_METHOD(sharePdf:(NSString *)sourcePath displayName:(NSString *)displayName chooserTitle:(NSString *)chooserTitle resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *err = nil;
  NSString *source = [self verifiablePdf:sourcePath error:&err];
  if (!source) return reject(@"PDF_SHARE_FAILED", err, nil);
  NSString *dir = [PieCacheDir(@"pdf_exports") stringByAppendingPathComponent:PieUniqueStamp()];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *name = PieSanitizeFileName(displayName, @"Document", @"pdf");
  NSString *shared = [dir stringByAppendingPathComponent:name];
  NSError *copyError = nil;
  if (![[NSFileManager defaultManager] copyItemAtPath:source toPath:shared error:&copyError]) {
    return reject(@"PDF_SHARE_FAILED", copyError.localizedDescription, copyError);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *top = PieTopViewController();
    if (!top) return reject(@"PDF_SHARE_FAILED", @"No view controller to present from", nil);
    UIActivityViewController *vc = [[UIActivityViewController alloc] initWithActivityItems:@[[NSURL fileURLWithPath:shared]] applicationActivities:nil];
    vc.popoverPresentationController.sourceView = top.view;
    vc.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(top.view.bounds), CGRectGetMidY(top.view.bounds), 1, 1);
    [top presentViewController:vc animated:YES completion:nil];
    resolve(@{@"contentUri": PieFileUri(shared), @"displayName": name});
  });
}

RCT_EXPORT_METHOD(purgeExportCache:(double)maxAgeMs resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *root = PieCacheDir(@"pdf_exports");
  NSFileManager *fm = [NSFileManager defaultManager];
  NSDate *cutoff = [NSDate dateWithTimeIntervalSinceNow:-(maxAgeMs / 1000.0)];
  NSInteger removed = 0;
  for (NSString *entry in [fm contentsOfDirectoryAtPath:root error:nil]) {
    NSString *p = [root stringByAppendingPathComponent:entry];
    NSDate *modified = [[fm attributesOfItemAtPath:p error:nil] fileModificationDate];
    if (maxAgeMs <= 0 || [modified compare:cutoff] == NSOrderedAscending) {
      if ([fm removeItemAtPath:p error:nil]) removed++;
    }
  }
  resolve(@(removed));
}

// -------------------------------------------------------------------------------------------
// Document operations (page tools, markup, merge, images -> PDF), search, thumbnails
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(applyDocumentOperations:(NSString *)inputPath outputPath:(NSString *)outputPath opsJson:(NSString *)opsJson resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *in = [self resolvePath:inputPath];
  if (![[NSFileManager defaultManager] fileExistsAtPath:in]) return reject(@"PDF_FILE_NOT_FOUND", @"Input PDF file not found", nil);
  NSString *err = nil;
  NSString *out = [self prepareOutput:outputPath error:&err];
  if (!out) return reject(@"PDF_DOCUMENT_OPERATION_ERROR", err, nil);
  if ([in isEqualToString:out]) return reject(@"SAME_INPUT_OUTPUT", @"Input and output must differ", nil);
  resolve(N(pie_engine::applyDocumentOperationsJson(S(in), S(out), S(opsJson))));
}

RCT_EXPORT_METHOD(mergeDocuments:(NSArray *)inputPaths outputPath:(NSString *)outputPath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSMutableArray *paths = [NSMutableArray array];
  for (id p in inputPaths) {
    if ([p isKindOfClass:[NSString class]]) [paths addObject:[self resolvePath:p]];
  }
  NSString *err = nil;
  NSString *out = [self prepareOutput:outputPath error:&err];
  if (!out) return reject(@"PDF_MERGE_ERROR", err, nil);
  NSData *json = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
  NSString *jsonStr = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  resolve(N(pie_engine::mergeDocumentsJson(S(jsonStr), S(out))));
}

/** Upright JPEG (white background, long side <= 3000 px) for embedding into a PDF. */
- (NSDictionary *)prepareJpeg:(NSString *)uri quality:(CGFloat)quality {
  CGImageRef image = PieCreateUprightImage(uri, kMaxEmbedImageSide);
  if (!image) return nil;
  size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, cs, kCGImageAlphaNoneSkipLast);
  CGColorSpaceRelease(cs);
  if (!ctx) {
    CGImageRelease(image);
    return nil;
  }
  CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
  CGContextFillRect(ctx, CGRectMake(0, 0, w, h));
  CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
  CGImageRelease(image);
  CGImageRef flat = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  NSString *out = [PieCacheDir(@"pdf_compose") stringByAppendingPathComponent:[NSString stringWithFormat:@"img_%@.jpg", PieUniqueStamp()]];
  BOOL ok = PieWriteImage(flat, out, NO, quality);
  CGImageRelease(flat);
  if (!ok) return nil;
  return @{@"path": out, @"width": @(w), @"height": @(h)};
}

RCT_EXPORT_METHOD(prepareImageForPdf:(NSString *)imageUri resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSDictionary *prepared = [self prepareJpeg:imageUri quality:0.9];
  if (!prepared) return reject(@"IMAGE_PREPARE_FAILED", @"The image could not be prepared", nil);
  resolve(prepared);
}

RCT_EXPORT_METHOD(createPdfFromImages:(NSArray *)imageUris outputPath:(NSString *)outputPath pageSize:(NSString *)pageSize margin:(double)margin resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSMutableArray *images = [NSMutableArray array];
  NSMutableArray *temps = [NSMutableArray array];
  for (id uri in imageUris) {
    if (![uri isKindOfClass:[NSString class]]) continue;
    NSDictionary *prepared = [self prepareJpeg:uri quality:0.88];
    if (!prepared) {
      for (NSString *t in temps) [[NSFileManager defaultManager] removeItemAtPath:t error:nil];
      return reject(@"PDF_CREATE_ERROR", @"An image could not be read", nil);
    }
    [temps addObject:prepared[@"path"]];
    [images addObject:prepared];
  }
  if (images.count == 0) return reject(@"INVALID_ARGUMENTS", @"No images were given", nil);
  NSString *err = nil;
  NSString *out = [self prepareOutput:outputPath error:&err];
  if (!out) return reject(@"PDF_CREATE_ERROR", err, nil);
  NSDictionary *spec = @{@"images": images, @"pageSize": pageSize ?: @"fit", @"margin": @(margin)};
  NSString *json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:spec options:0 error:nil] encoding:NSUTF8StringEncoding];
  std::string result = pie_engine::createPdfFromImagesJson(S(json), S(out));
  for (NSString *t in temps) [[NSFileManager defaultManager] removeItemAtPath:t error:nil];
  resolve(N(result));
}

RCT_EXPORT_METHOD(searchText:(double)docHandle query:(NSString *)query maxResults:(NSInteger)maxResults resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(N(pie_engine::searchDocumentJson((int64_t)docHandle, S(query), (int)MAX(1, MIN(2000, maxResults)))));
}

RCT_EXPORT_METHOD(getPageText:(double)docHandle pageIndex:(NSInteger)pageIndex resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(N(pie_engine::pageTextJson((int64_t)docHandle, (int)pageIndex)));
}

RCT_EXPORT_METHOD(getPageChars:(double)docHandle pageIndex:(NSInteger)pageIndex resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(N(pie_engine::pageCharsJson((int64_t)docHandle, (int)pageIndex)));
}

- (NSDictionary *)renderThumb:(int64_t)handle page:(int)pageIndex maxPixels:(NSInteger)maxPixels outPath:(NSString *)out {
  double pw = 0, ph = 0;
  if (!pie_engine::getPageSize(handle, pageIndex, pw, ph)) return nil;
  double longSide = MAX(pw, ph);
  if (longSide <= 0) return nil;
  double scale = (double)MAX(32, MIN(2048, maxPixels)) / longSide;
  int w = MAX(1, (int)ceil(pw * scale));
  int h = MAX(1, (int)ceil(ph * scale));
  BOOL ok = [self renderPNG:out width:w height:h render:^bool(void *pixels, int stride) {
    return pie_engine::renderPageToBuffer(handle, pageIndex, pixels, w, h, stride, false);
  }];
  return ok ? @{@"width": @(w), @"height": @(h)} : nil;
}

RCT_EXPORT_METHOD(renderThumbnail:(double)docHandle pageIndex:(NSInteger)pageIndex maxPixels:(NSInteger)maxPixels resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *out = [PieCacheDir(@"pdfium_thumbs") stringByAppendingPathComponent:[NSString stringWithFormat:@"thumb_%lld_%ld_%@.png", (long long)docHandle, (long)pageIndex, PieUniqueStamp()]];
  NSDictionary *size = [self renderThumb:(int64_t)docHandle page:(int)pageIndex maxPixels:maxPixels outPath:out];
  if (!size) return reject(@"PDF_RENDER_FAILED", @"Thumbnail could not be rendered", nil);
  resolve(@{@"filePath": out, @"uri": PieFileUri(out), @"width": size[@"width"], @"height": size[@"height"], @"pageIndex": @(pageIndex)});
}

RCT_EXPORT_METHOD(purgeThumbnailCache:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@([self purgeDir:PieCacheDir(@"pdfium_thumbs") keep:[NSSet set]] + [self purgeDir:PieCacheDir(@"pdf_compose") keep:[NSSet set]]));
}

RCT_EXPORT_METHOD(renderFileThumbnail:(NSString *)pdfPath outputPath:(NSString *)outputPath maxPixels:(NSInteger)maxPixels resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *in = [self resolvePath:pdfPath];
  if (![[NSFileManager defaultManager] fileExistsAtPath:in]) return reject(@"PDF_FILE_NOT_FOUND", @"PDF not found", nil);
  NSString *err = nil;
  NSString *out = [self prepareOutput:outputPath error:&err];
  if (!out) return reject(@"PDF_RENDER_ERROR", err, nil);
  int64_t handle = pie_engine::openDocument(S(in), nullptr);
  if (handle <= 0) return reject(@"PDF_OPEN_FAILED", @"PDF could not be opened", nil);
  int pageCount = pie_engine::getPageCount(handle);
  NSString *tmp = [out stringByAppendingString:@".tmp"];
  NSDictionary *size = [self renderThumb:handle page:0 maxPixels:maxPixels outPath:tmp];
  pie_engine::closeDocument(handle);
  if (!size) return reject(@"PDF_RENDER_FAILED", @"Thumbnail could not be rendered", nil);
  [[NSFileManager defaultManager] removeItemAtPath:out error:nil];
  if (![[NSFileManager defaultManager] moveItemAtPath:tmp toPath:out error:nil]) {
    return reject(@"PDF_RENDER_FAILED", @"Thumbnail could not be stored", nil);
  }
  resolve(@{@"uri": PieFileUri(out), @"width": size[@"width"], @"height": size[@"height"], @"pageCount": @(pageCount)});
}

@end
