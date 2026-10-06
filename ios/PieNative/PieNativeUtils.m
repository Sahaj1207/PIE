#import "PieNativeUtils.h"
#import <CommonCrypto/CommonDigest.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

NSString *PieDocumentsRoot(void) {
  NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  NSString *root = [support stringByAppendingPathComponent:@"pie"];
  [[NSFileManager defaultManager] createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil];
  return root;
}

NSString *PieCacheDir(NSString *name) {
  NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  NSString *dir = [caches stringByAppendingPathComponent:name];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  return dir;
}

NSString *PiePlainPath(NSString *uriOrPath) {
  if ([uriOrPath hasPrefix:@"file://"]) {
    NSURL *url = [NSURL URLWithString:uriOrPath];
    if (url.path.length > 0) return url.path;
    return [[uriOrPath substringFromIndex:7] stringByRemovingPercentEncoding] ?: [uriOrPath substringFromIndex:7];
  }
  return uriOrPath;
}

NSString *PieFileUri(NSString *path) {
  return [NSURL fileURLWithPath:path].absoluteString;
}

BOOL PieIsAppPrivatePath(NSString *path) {
  NSString *standard = [[PiePlainPath(path) stringByResolvingSymlinksInPath] stringByStandardizingPath];
  NSArray<NSString *> *roots = @[
    NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject ?: @"",
    NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject ?: @"",
    NSTemporaryDirectory() ?: @"",
  ];
  for (NSString *root in roots) {
    if (root.length == 0) continue;
    NSString *r = [[root stringByResolvingSymlinksInPath] stringByStandardizingPath];
    if ([standard isEqualToString:r] || [standard hasPrefix:[r stringByAppendingString:@"/"]]) return YES;
  }
  return NO;
}

UIViewController *PieTopViewController(void) {
  UIWindow *keyWindow = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) {
        keyWindow = window;
        break;
      }
    }
    if (keyWindow) break;
  }
  UIViewController *vc = keyWindow.rootViewController;
  while (vc.presentedViewController && !vc.presentedViewController.isBeingDismissed) {
    vc = vc.presentedViewController;
  }
  return vc;
}

NSString *PieSha256OfFile(NSString *path) {
  NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:path];
  if (!stream) return nil;
  [stream open];
  CC_SHA256_CTX ctx;
  CC_SHA256_Init(&ctx);
  uint8_t buffer[65536];
  NSInteger n;
  while ((n = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
    CC_SHA256_Update(&ctx, buffer, (CC_LONG)n);
  }
  [stream close];
  if (n < 0) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &ctx);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

NSString *PieSanitizeFileName(NSString *name, NSString *fallback, NSString *requiredExtension) {
  NSString *clean = name ?: @"";
  NSCharacterSet *bad = [NSCharacterSet characterSetWithCharactersInString:@"\\/:*?\"<>|"];
  clean = [[clean componentsSeparatedByCharactersInSet:bad] componentsJoinedByString:@"_"];
  clean = [[clean componentsSeparatedByCharactersInSet:NSCharacterSet.controlCharacterSet] componentsJoinedByString:@""];
  clean = [clean stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" ."]];
  if (requiredExtension.length > 0 && [clean.lowercaseString hasSuffix:[@"." stringByAppendingString:requiredExtension]]) {
    clean = [[clean substringToIndex:clean.length - requiredExtension.length - 1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  }
  if (clean.length == 0) clean = fallback;
  if (clean.length > 120) clean = [clean substringToIndex:120];
  if (requiredExtension.length > 0) clean = [clean stringByAppendingPathExtension:requiredExtension];
  return clean;
}

NSString *PieUniqueStamp(void) {
  long long ms = (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);
  return [NSString stringWithFormat:@"%lld_%@", ms, [[NSUUID UUID].UUIDString substringToIndex:6]];
}

static CGImageSourceRef PieCreateSource(NSString *uriOrPath) {
  NSString *path = PiePlainPath(uriOrPath);
  NSURL *url = [NSURL fileURLWithPath:path];
  return CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
}

BOOL PieUprightImageSize(NSString *uriOrPath, NSInteger *width, NSInteger *height, NSInteger *exifOrientation, NSString **uti) {
  CGImageSourceRef src = PieCreateSource(uriOrPath);
  if (!src) return NO;
  NSDictionary *props = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(src, 0, NULL));
  if (uti) *uti = (__bridge NSString *)CGImageSourceGetType(src);
  CFRelease(src);
  NSInteger w = [props[(NSString *)kCGImagePropertyPixelWidth] integerValue];
  NSInteger h = [props[(NSString *)kCGImagePropertyPixelHeight] integerValue];
  NSInteger o = [props[(NSString *)kCGImagePropertyOrientation] integerValue];
  if (o < 1 || o > 8) o = 1;
  if (w <= 0 || h <= 0) return NO;
  if (o >= 5) {
    NSInteger t = w;
    w = h;
    h = t;
  }
  if (width) *width = w;
  if (height) *height = h;
  if (exifOrientation) *exifOrientation = o;
  return YES;
}

CGImageRef PieCreateUprightImage(NSString *uriOrPath, NSUInteger maxLongSide) {
  CGImageSourceRef src = PieCreateSource(uriOrPath);
  if (!src) return NULL;
  NSInteger w = 0, h = 0;
  PieUprightImageSize(uriOrPath, &w, &h, NULL, NULL);
  NSUInteger longSide = (NSUInteger)MAX(w, h);
  NSUInteger target = (maxLongSide == 0 || maxLongSide > longSide) ? longSide : maxLongSide;
  NSDictionary *opts = @{
    (NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (NSString *)kCGImageSourceShouldCacheImmediately: @YES,
    (NSString *)kCGImageSourceThumbnailMaxPixelSize: @(MAX((NSUInteger)1, target)),
  };
  CGImageRef image = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
  CFRelease(src);
  return image;
}

BOOL PieWriteImage(CGImageRef image, NSString *path, BOOL png, CGFloat quality) {
  if (!image) return NO;
  NSURL *url = [NSURL fileURLWithPath:path];
  CFStringRef type = png ? (__bridge CFStringRef)UTTypePNG.identifier : (__bridge CFStringRef)UTTypeJPEG.identifier;
  CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, type, 1, NULL);
  if (!dest) return NO;
  NSDictionary *props = png ? @{} : @{(NSString *)kCGImageDestinationLossyCompressionQuality: @(quality)};
  CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)props);
  BOOL ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  return ok;
}

@implementation PieDocumentPickerDelegate

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  if (self.onPick) self.onPick(urls);
  self.onPick = nil;
  self.onCancel = nil;
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  if (self.onCancel) self.onCancel();
  self.onPick = nil;
  self.onCancel = nil;
}

- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController {
  if (self.onCancel) self.onCancel();
  self.onPick = nil;
  self.onCancel = nil;
}

@end
