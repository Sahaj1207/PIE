// PIE — image processing for iOS (same JS contract as ImageProcessingModule.kt): picking,
// durable upright import with preview, deterministic background reconstruction, full-resolution
// export (patches, text lines, markup), rotate/flip/crop and sharing. All on-device.
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <Photos/Photos.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "PieNativeUtils.h"
#import "PieTextInpainting.h"

@interface ImageProcessingModule : NSObject <RCTBridgeModule>
@property (nonatomic, strong) PieDocumentPickerDelegate *pickerDelegate;
@end

static double PieClamp255(double v) {
  return MAX(0.0, MIN(255.0, v));
}

static NSString *PieHex(double r, double g, double b) {
  return [NSString stringWithFormat:@"#%02X%02X%02X", (int)lround(PieClamp255(r)), (int)lround(PieClamp255(g)), (int)lround(PieClamp255(b))];
}

static UIColor *PieColor(NSString *hex, CGFloat alpha) {
  NSString *h = [hex hasPrefix:@"#"] ? [hex substringFromIndex:1] : hex;
  unsigned int v = 0;
  if (h.length != 6 || ![[NSScanner scannerWithString:h] scanHexInt:&v]) return [UIColor colorWithWhite:0 alpha:alpha];
  return [UIColor colorWithRed:((v >> 16) & 0xFF) / 255.0 green:((v >> 8) & 0xFF) / 255.0 blue:(v & 0xFF) / 255.0 alpha:alpha];
}

/** Same family mapping as platformFontFamily() for iOS (canvas parity). */
static UIFont *PieFont(NSString *family, CGFloat size, NSString *weight, NSString *style) {
  NSString *name = [family isEqualToString:@"serif"] ? @"Times New Roman" : [family isEqualToString:@"monospace"] ? @"Courier" : @"Helvetica";
  BOOL bold = [weight isEqualToString:@"bold"] || weight.integerValue >= 600;
  BOOL italic = [style isEqualToString:@"italic"];
  UIFontDescriptor *d = [UIFontDescriptor fontDescriptorWithName:name size:size];
  UIFontDescriptorSymbolicTraits traits = (bold ? UIFontDescriptorTraitBold : 0) | (italic ? UIFontDescriptorTraitItalic : 0);
  if (traits) d = [d fontDescriptorWithSymbolicTraits:traits] ?: d;
  return [UIFont fontWithDescriptor:d size:size] ?: [UIFont systemFontOfSize:size];
}

/** Path from shared markup commands: ["M",x,y] ["L",x,y] ["Q",cx,cy,x,y] ["C",...] ["Z"]. */
static UIBezierPath *PiePath(NSArray *commands) {
  UIBezierPath *p = [UIBezierPath bezierPath];
  for (NSArray *c in commands) {
    if (![c isKindOfClass:[NSArray class]] || c.count == 0) continue;
    NSString *op = c[0];
    double (^n)(NSUInteger) = ^double(NSUInteger k) { return k < c.count ? [c[k] doubleValue] : 0; };
    if ([op isEqualToString:@"M"]) [p moveToPoint:CGPointMake(n(1), n(2))];
    else if ([op isEqualToString:@"L"]) [p addLineToPoint:CGPointMake(n(1), n(2))];
    else if ([op isEqualToString:@"Q"]) [p addQuadCurveToPoint:CGPointMake(n(3), n(4)) controlPoint:CGPointMake(n(1), n(2))];
    else if ([op isEqualToString:@"C"]) [p addCurveToPoint:CGPointMake(n(5), n(6)) controlPoint1:CGPointMake(n(1), n(2)) controlPoint2:CGPointMake(n(3), n(4))];
    else if ([op isEqualToString:@"Z"]) [p closePath];
  }
  return p;
}

@implementation ImageProcessingModule {
  dispatch_queue_t _queue;
}

RCT_EXPORT_MODULE(ImageProcessingModule)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  if ((self = [super init])) _queue = dispatch_queue_create("pie.image", DISPATCH_QUEUE_SERIAL);
  return self;
}

- (dispatch_queue_t)methodQueue {
  return _queue;
}

// -------------------------------------------------------------------------------------------
// Picking / URIs
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(pickImageDocument:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *top = PieTopViewController();
    if (!top) return reject(@"PICK_IMAGE_ERROR", @"Cannot present the file picker", nil);
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeImage] asCopy:YES];
    PieDocumentPickerDelegate *delegate = [PieDocumentPickerDelegate new];
    __weak ImageProcessingModule *weakSelf = self;
    delegate.onPick = ^(NSArray<NSURL *> *urls) {
      weakSelf.pickerDelegate = nil;
      NSURL *url = urls.firstObject;
      if (!url) return resolve([NSNull null]);
      dispatch_async(self->_queue, ^{
        NSString *name = url.lastPathComponent ?: @"image.png";
        NSString *dest = [PieCacheDir(@"imported_images") stringByAppendingPathComponent:[NSString stringWithFormat:@"%@_%@", PieUniqueStamp(), PieSanitizeFileName(name, @"image", nil)]];
        BOOL scoped = [url startAccessingSecurityScopedResource];
        NSError *error = nil;
        BOOL ok = [[NSFileManager defaultManager] copyItemAtURL:url toURL:[NSURL fileURLWithPath:dest] error:&error];
        if (scoped) [url stopAccessingSecurityScopedResource];
        if (!ok) return reject(@"PICK_IMAGE_ERROR", error.localizedDescription, error);
        NSInteger w = 0, h = 0;
        PieUprightImageSize(dest, &w, &h, NULL, NULL);
        unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:dest error:nil] fileSize];
        resolve(@{@"uri": PieFileUri(dest), @"fileName": name, @"width": @(w), @"height": @(h), @"fileSize": @(size)});
      });
    };
    delegate.onCancel = ^{
      weakSelf.pickerDelegate = nil;
      resolve([NSNull null]);
    };
    self.pickerDelegate = delegate;
    picker.delegate = delegate;
    picker.presentationController.delegate = delegate;
    [top presentViewController:picker animated:YES completion:nil];
  });
}

RCT_EXPORT_METHOD(resolveLocalImageUri:(NSString *)uriString resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *path = PiePlainPath(uriString);
  if ([[NSFileManager defaultManager] fileExistsAtPath:path]) return resolve(PieFileUri(path));
  reject(@"RESOLVE_URI_FAILED", [NSString stringWithFormat:@"Image not found: %@", uriString], nil);
}

// -------------------------------------------------------------------------------------------
// Durable import (upright working copy + display preview)
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(importImageDocument:(NSString *)sourceUri destDirPath:(NSString *)destDirPath maxPixels:(double)maxPixels previewMaxDimension:(double)previewMaxDimension resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @autoreleasepool {
    NSString *destDir = PiePlainPath(destDirPath);
    [[NSFileManager defaultManager] createDirectoryAtPath:destDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSInteger w = 0, h = 0, orientation = 1;
    NSString *uti = nil;
    if (!PieUprightImageSize(sourceUri, &w, &h, &orientation, &uti)) {
      return reject(@"IMAGE_DECODE_FAILED", @"The selected file could not be decoded as an image.", nil);
    }
    if ((double)w * (double)h > maxPixels) {
      return reject(@"IMAGE_TOO_LARGE", [NSString stringWithFormat:@"Image is too large to edit on this device (%ldx%ld).", (long)w, (long)h], nil);
    }
    BOOL isJpeg = [uti isEqualToString:UTTypeJPEG.identifier];
    BOOL isPng = [uti isEqualToString:UTTypePNG.identifier];
    NSString *working;
    NSString *mime;
    if (orientation == 1 && (isJpeg || isPng)) {
      // Upright JPEG/PNG: byte copy (no re-encode, no quality loss).
      working = [destDir stringByAppendingPathComponent:isPng ? @"working.png" : @"working.jpg"];
      [[NSFileManager defaultManager] removeItemAtPath:working error:nil];
      NSError *error = nil;
      if (![[NSFileManager defaultManager] copyItemAtPath:PiePlainPath(sourceUri) toPath:working error:&error]) {
        return reject(@"IMAGE_IMPORT_FAILED", error.localizedDescription, error);
      }
      mime = isPng ? @"image/png" : @"image/jpeg";
    } else {
      CGImageRef upright = PieCreateUprightImage(sourceUri, 0);
      if (!upright) return reject(@"IMAGE_DECODE_FAILED", @"The selected image could not be decoded.", nil);
      CGImageAlphaInfo alpha = CGImageGetAlphaInfo(upright);
      BOOL asPng = isPng || (alpha != kCGImageAlphaNone && alpha != kCGImageAlphaNoneSkipLast && alpha != kCGImageAlphaNoneSkipFirst);
      working = [destDir stringByAppendingPathComponent:asPng ? @"working.png" : @"working.jpg"];
      BOOL ok = PieWriteImage(upright, working, asPng, 1.0);
      w = (NSInteger)CGImageGetWidth(upright);
      h = (NSInteger)CGImageGetHeight(upright);
      CGImageRelease(upright);
      if (!ok) return reject(@"IMAGE_IMPORT_FAILED", @"The working copy could not be written.", nil);
      mime = asPng ? @"image/png" : @"image/jpeg";
    }
    NSString *previewUri = PieFileUri(working);
    if (previewMaxDimension > 0 && MAX(w, h) > previewMaxDimension) {
      CGImageRef preview = PieCreateUprightImage(working, (NSUInteger)previewMaxDimension);
      if (preview) {
        NSString *previewPath = [destDir stringByAppendingPathComponent:@"preview.jpg"];
        if (PieWriteImage(preview, previewPath, NO, 0.9)) previewUri = PieFileUri(previewPath);
        CGImageRelease(preview);
      }
    }
    unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:working error:nil] fileSize];
    resolve(@{@"workingUri": PieFileUri(working), @"previewUri": previewUri, @"width": @(w), @"height": @(h), @"mimeType": mime, @"exifOrientation": @(orientation), @"fileSizeBytes": @(size)});
  }
}

// -------------------------------------------------------------------------------------------
// Background reconstruction (deterministic, texture-preserving; identical to Android)
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(reconstructBackground:(NSString *)imageUri x:(double)x y:(double)y width:(double)width height:(double)height resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self reconstruct:imageUri x:x y:y width:width height:height outputDir:PieCacheDir(@"patches") resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(reconstructBackgroundToDirectory:(NSString *)imageUri x:(double)x y:(double)y width:(double)width height:(double)height outputDir:(NSString *)outputDir resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self reconstruct:imageUri x:x y:y width:width height:height outputDir:PiePlainPath(outputDir) resolve:resolve reject:reject];
}

- (void)reconstruct:(NSString *)imageUri x:(double)x y:(double)y width:(double)width height:(double)height outputDir:(NSString *)outputDir resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  @autoreleasepool {
    CGImageRef image = PieCreateUprightImage(imageUri, 0);
    if (!image) return reject(@"BACKGROUND_RECONSTRUCTION_FAILED", @"Could not load the image", nil);
    NSInteger imgW = (NSInteger)CGImageGetWidth(image), imgH = (NSInteger)CGImageGetHeight(image);
    const NSInteger padding = 5, border = 4;
    NSInteger targetX = MAX(0, (NSInteger)(x - padding)), targetY = MAX(0, (NSInteger)(y - padding));
    NSInteger targetRight = MIN(imgW, (NSInteger)(x + width + padding)), targetBottom = MIN(imgH, (NSInteger)(y + height + padding));
    NSInteger targetW = MAX(1, targetRight - targetX), targetH = MAX(1, targetBottom - targetY);
    NSInteger minX = MAX(0, targetX - border), maxX = MIN(imgW - 1, targetRight + border - 1);
    NSInteger minY = MAX(0, targetY - border), maxY = MIN(imgH - 1, targetBottom + border - 1);
    NSInteger regW = maxX - minX + 1, regH = maxY - minY + 1;
    if (regW <= 0 || regH <= 0) {
      CGImageRelease(image);
      return reject(@"BACKGROUND_RECONSTRUCTION_FAILED", @"Invalid region", nil);
    }
    // RGBA pixels of the sampling region (top-left origin).
    NSMutableData *buf = [NSMutableData dataWithLength:(NSUInteger)(regW * regH * 4)];
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(buf.mutableBytes, regW, regH, 8, regW * 4, cs, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(cs);
    CGContextDrawImage(ctx, CGRectMake(-minX, -(imgH - (minY + regH)), imgW, imgH), image);
    CGContextRelease(ctx);
    CGImageRelease(image);
    // Texture-preserving reconstruction (PieTextInpainting.h; reference: textInpainting.ts).
    // Only text pixels are rebuilt; the background around and between letters is kept.
    const uint8_t *px = buf.bytes;
    NSInteger origX = MAX(0, (NSInteger)x), origY = MAX(0, (NSInteger)y);
    NSInteger origRight = MIN(imgW, (NSInteger)(x + width)), origBottom = MIN(imgH, (NSInteger)(y + height));
    NSMutableData *scratch = [NSMutableData dataWithLength:PieInpaintScratchSizeForTarget((int)regW, (int)regH, (int)targetW, (int)targetH)];
    NSMutableData *patch = [NSMutableData dataWithLength:(NSUInteger)(targetW * targetH * 4)];
    if (!scratch || !patch) return reject(@"BACKGROUND_RECONSTRUCTION_FAILED", @"Not enough memory to reconstruct this region.", nil);
    PieInpaintResult recon;
    memset(&recon, 0, sizeof(recon));
    int rc = PieReconstructTextPatch(px, (int)regW, (int)regH,
                                     (int)(targetX - minX), (int)(targetY - minY), (int)targetW, (int)targetH,
                                     (int)(origX - minX), (int)(origY - minY),
                                     (int)MAX(1, origRight - origX), (int)MAX(1, origBottom - origY),
                                     patch.mutableBytes, scratch.mutableBytes, &recon);
    if (rc != 0) {
      return reject(@"BACKGROUND_RECONSTRUCTION_FAILED", @"No surrounding pixels found to reconstruct background", nil);
    }
    double lum = 0.299 * recon.meanR + 0.587 * recon.meanG + 0.114 * recon.meanB;
    NSString *textColor = recon.hasTextColor ? PieHex(recon.textR, recon.textG, recon.textB)
                                             : (lum > 128 ? @"#111827" : @"#F9FAFB");
    uint8_t *out = patch.mutableBytes;
    CGColorSpaceRef cs2 = CGColorSpaceCreateDeviceRGB();
    CGContextRef pctx = CGBitmapContextCreate(out, targetW, targetH, 8, targetW * 4, cs2, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(cs2);
    CGImageRef patchImage = CGBitmapContextCreateImage(pctx);
    CGContextRelease(pctx);
    [[NSFileManager defaultManager] createDirectoryAtPath:outputDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *patchPath = [outputDir stringByAppendingPathComponent:[NSString stringWithFormat:@"patch_%@.png", PieUniqueStamp()]];
    BOOL ok = PieWriteImage(patchImage, patchPath, YES, 1.0);
    CGImageRelease(patchImage);
    if (!ok) return reject(@"BACKGROUND_RECONSTRUCTION_FAILED", @"The patch could not be written", nil);
    resolve(@{
      @"patchUri": PieFileUri(patchPath),
      @"bounds": @{@"x": @(targetX), @"y": @(targetY), @"width": @(targetW), @"height": @(targetH)},
      @"estimatedBackgroundColor": PieHex(recon.meanR, recon.meanG, recon.meanB),
      @"estimatedTextColor": textColor,
      @"confidence": @(recon.confidence),
      @"method": recon.method ? @"inpaint" : @"plane",
      @"filledPixels": @(recon.filledPixels),
    });
  }
}

// -------------------------------------------------------------------------------------------
// Export (full resolution; same render plan as the canvas)
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(exportImagePage:(NSDictionary *)params resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @autoreleasepool {
    NSString *source = params[@"sourceImageUri"];
    if (!source) return reject(@"EXPORT_FAILED", @"Missing sourceImageUri parameter", nil);
    NSString *format = params[@"format"] ?: @"png";
    double quality = [params[@"quality"] ?: @95 doubleValue];
    NSString *destination = params[@"destination"] ?: @"file";
    double maxPixels = params[@"maxPixels"] ? [params[@"maxPixels"] doubleValue] : DBL_MAX;
    NSInteger w = 0, h = 0;
    if (!PieUprightImageSize(source, &w, &h, NULL, NULL)) return reject(@"EXPORT_FAILED", @"Could not read the source image", nil);
    if ((double)w * h > maxPixels) return reject(@"EXPORT_TOO_LARGE", [NSString stringWithFormat:@"Image is too large to export on this device (%ldx%ld).", (long)w, (long)h], nil);
    CGImageRef base = PieCreateUprightImage(source, 0);
    if (!base) return reject(@"EXPORT_FAILED", @"Could not load the source image", nil);

    UIGraphicsImageRendererFormat *fmt = [UIGraphicsImageRendererFormat preferredFormat];
    fmt.scale = 1;
    fmt.opaque = NO;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(w, h) format:fmt];
    UIImage *result = [renderer imageWithActions:^(UIGraphicsImageRendererContext *rc) {
      [[UIImage imageWithCGImage:base] drawInRect:CGRectMake(0, 0, w, h)];
      for (NSDictionary *patch in params[@"patches"] ?: @[]) {
        NSDictionary *b = patch[@"bounds"];
        UIImage *img = [UIImage imageWithContentsOfFile:PiePlainPath(patch[@"patchUri"] ?: @"")];
        if (img && b) [img drawInRect:CGRectMake([b[@"x"] doubleValue], [b[@"y"] doubleValue], [b[@"width"] doubleValue], [b[@"height"] doubleValue])];
      }
      for (NSDictionary *el in params[@"textElements"] ?: @[]) {
        UIFont *font = PieFont(el[@"fontFamily"] ?: @"sans-serif", [el[@"fittedFontSize"] doubleValue], el[@"fontWeight"] ?: @"normal", el[@"fontStyle"] ?: @"normal");
        NSDictionary *attrs = @{NSFontAttributeName: font, NSForegroundColorAttributeName: PieColor(el[@"color"] ?: @"#111827", 1)};
        NSArray *lines = el[@"lines"];
        if (lines.count > 0) {
          for (NSDictionary *line in lines) {
            NSString *t = line[@"text"];
            if (t.length == 0) continue;
            // drawAtPoint takes the top-left of the line box: baseline - ascender.
            [t drawAtPoint:CGPointMake([line[@"x"] doubleValue], [line[@"baselineY"] doubleValue] - font.ascender) withAttributes:attrs];
          }
        } else {
          double tx = el[@"drawX"] ? [el[@"drawX"] doubleValue] : [el[@"bounds"][@"x"] doubleValue] + 1;
          [(NSString *)el[@"text"] drawAtPoint:CGPointMake(tx, [el[@"baselineY"] doubleValue] - font.ascender) withAttributes:attrs];
        }
      }
      CGContextRef cg = rc.CGContext;
      for (NSDictionary *d in params[@"drawings"] ?: @[]) {
        UIBezierPath *path = PiePath(d[@"commands"]);
        CGContextSaveGState(cg);
        if ([d[@"multiply"] boolValue]) CGContextSetBlendMode(cg, kCGBlendModeMultiply);
        UIColor *color = PieColor(d[@"color"] ?: @"#000000", [d[@"opacity"] ?: @1 doubleValue]);
        if ([d[@"fill"] boolValue]) {
          [color setFill];
          [path fill];
        } else {
          path.lineWidth = [d[@"width"] ?: @2 doubleValue];
          path.lineCapStyle = kCGLineCapRound;
          path.lineJoinStyle = kCGLineJoinRound;
          [color setStroke];
          [path stroke];
        }
        CGContextRestoreGState(cg);
      }
    }];
    CGImageRelease(base);

    BOOL png = [format.lowercaseString isEqualToString:@"png"];
    NSString *ext = png ? @"png" : @"jpg";
    NSString *exportPath = [PieCacheDir(@"exports") stringByAppendingPathComponent:[NSString stringWithFormat:@"export_%@.%@", PieUniqueStamp(), ext]];
    if (!PieWriteImage(result.CGImage, exportPath, png, MAX(0.01, MIN(1.0, quality / 100.0)))) {
      return reject(@"EXPORT_FAILED", @"The exported image could not be written", nil);
    }
    unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:exportPath error:nil] fileSize];
    NSMutableDictionary *out = [@{@"destinationUri": PieFileUri(exportPath), @"format": png ? @"png" : @"jpeg", @"fileSizeBytes": @(size), @"width": @(w), @"height": @(h), @"savedToGallery": @NO} mutableCopy];
    if (![destination isEqualToString:@"gallery"]) return resolve(out);

    // Add-only photo library access (no read access is requested).
    [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly handler:^(PHAuthorizationStatus status) {
      if (status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited) {
        out[@"galleryError"] = @"Photo library access was not allowed";
        return resolve(out);
      }
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [PHAssetChangeRequest creationRequestForAssetFromImageAtFileURL:[NSURL fileURLWithPath:exportPath]];
      } completionHandler:^(BOOL success, NSError *error) {
        out[@"savedToGallery"] = @(success);
        if (!success) out[@"galleryError"] = error.localizedDescription ?: @"Could not save to Photos";
        resolve(out);
      }];
    }];
  }
}

RCT_EXPORT_METHOD(shareFile:(NSString *)fileUriString mimeType:(NSString *)mimeType title:(NSString *)title resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *path = PiePlainPath(fileUriString);
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return reject(@"EXPORT_FAILED", @"File does not exist", nil);
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *top = PieTopViewController();
    if (!top) return reject(@"EXPORT_FAILED", @"No view controller to present from", nil);
    UIActivityViewController *vc = [[UIActivityViewController alloc] initWithActivityItems:@[[NSURL fileURLWithPath:path]] applicationActivities:nil];
    vc.popoverPresentationController.sourceView = top.view;
    vc.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(top.view.bounds), CGRectGetMidY(top.view.bounds), 1, 1);
    [top presentViewController:vc animated:YES completion:nil];
    resolve(@YES);
  });
}

// -------------------------------------------------------------------------------------------
// Rotate / flip / crop -> new working image
// -------------------------------------------------------------------------------------------

RCT_EXPORT_METHOD(transformImage:(NSDictionary *)params resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @autoreleasepool {
    NSString *source = params[@"sourceUri"];
    NSString *outputDir = PiePlainPath(params[@"outputDir"] ?: @"");
    if (!source || outputDir.length == 0) return reject(@"IMAGE_TRANSFORM_FAILED", @"Missing parameters", nil);
    NSInteger turns = (([params[@"quarterTurns"] integerValue] % 4) + 4) % 4;
    BOOL flipH = [params[@"flipHorizontal"] boolValue], flipV = [params[@"flipVertical"] boolValue];
    double maxPixels = params[@"maxPixels"] ? [params[@"maxPixels"] doubleValue] : 50e6;
    NSInteger previewMax = params[@"previewMaxDimension"] ? [params[@"previewMaxDimension"] integerValue] : 4096;
    NSInteger sw = 0, sh = 0;
    if (!PieUprightImageSize(source, &sw, &sh, NULL, NULL)) return reject(@"IMAGE_TRANSFORM_FAILED", @"The image could not be read", nil);
    if ((double)sw * sh > maxPixels) return reject(@"IMAGE_TOO_LARGE", @"Image is too large to transform on this device.", nil);
    CGImageRef full = PieCreateUprightImage(source, 0);
    if (!full) return reject(@"IMAGE_TRANSFORM_FAILED", @"The image could not be decoded", nil);
    CGImageRef img = full;
    NSDictionary *crop = [params[@"crop"] isKindOfClass:[NSDictionary class]] ? params[@"crop"] : nil;
    if (crop) {
      CGRect r = CGRectIntegral(CGRectMake([crop[@"x"] doubleValue], [crop[@"y"] doubleValue], [crop[@"width"] doubleValue], [crop[@"height"] doubleValue]));
      r = CGRectIntersection(r, CGRectMake(0, 0, sw, sh));
      if (r.size.width < 2 || r.size.height < 2) {
        CGImageRelease(full);
        return reject(@"IMAGE_TRANSFORM_FAILED", @"The crop area is too small", nil);
      }
      img = CGImageCreateWithImageInRect(full, r);
      CGImageRelease(full);
    }
    size_t iw = CGImageGetWidth(img), ih = CGImageGetHeight(img);
    size_t ow = (turns % 2) ? ih : iw, oh = (turns % 2) ? iw : ih;
    UIGraphicsImageRendererFormat *fmt = [UIGraphicsImageRendererFormat preferredFormat];
    fmt.scale = 1;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(ow, oh) format:fmt];
    UIImage *result = [renderer imageWithActions:^(UIGraphicsImageRendererContext *rc) {
      CGContextRef c = rc.CGContext;
      CGContextTranslateCTM(c, ow / 2.0, oh / 2.0);
      CGContextRotateCTM(c, turns * M_PI_2);  // clockwise in UIKit's flipped coordinates
      CGContextScaleCTM(c, flipH ? -1 : 1, flipV ? -1 : 1);
      [[UIImage imageWithCGImage:img] drawInRect:CGRectMake(-(double)iw / 2.0, -(double)ih / 2.0, iw, ih)];
    }];
    CGImageRelease(img);
    [[NSFileManager defaultManager] createDirectoryAtPath:outputDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *stamp = PieUniqueStamp();
    NSString *asset = [outputDir stringByAppendingPathComponent:[NSString stringWithFormat:@"asset_%@.png", stamp]];
    if (!PieWriteImage(result.CGImage, asset, YES, 1.0)) return reject(@"IMAGE_TRANSFORM_FAILED", @"The image could not be written", nil);
    NSMutableDictionary *out = [@{@"assetUri": PieFileUri(asset), @"width": @(ow), @"height": @(oh)} mutableCopy];
    if (previewMax > 0 && MAX(ow, oh) > (size_t)previewMax) {
      CGImageRef preview = PieCreateUprightImage(asset, (NSUInteger)previewMax);
      NSString *previewPath = [outputDir stringByAppendingPathComponent:[NSString stringWithFormat:@"preview_%@.jpg", stamp]];
      if (preview && PieWriteImage(preview, previewPath, NO, 0.9)) out[@"previewUri"] = PieFileUri(previewPath);
      if (preview) CGImageRelease(preview);
    }
    resolve(out);
  }
}

@end
