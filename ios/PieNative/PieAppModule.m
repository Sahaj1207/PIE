// PIE — app services (iOS counterpart of PieAppModule.kt): haptics, clipboard, plain-text
// sharing, app version, storage usage and cache cleanup. Everything is local.
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import "PieNativeUtils.h"

@interface PieAppModule : NSObject <RCTBridgeModule>
@end

static NSArray<NSString *> *PieCacheDirNames(void) {
  return @[@"pdfium_renders", @"pdfium_thumbs", @"pdf_compose", @"pdf_exports", @"picked_pdfs", @"resolved_pdfs", @"exports"];
}

static unsigned long long PieSizeOfPath(NSString *path) {
  NSFileManager *fm = [NSFileManager defaultManager];
  BOOL isDir = NO;
  if (![fm fileExistsAtPath:path isDirectory:&isDir]) return 0;
  if (!isDir) return [[fm attributesOfItemAtPath:path error:nil] fileSize];
  unsigned long long total = 0;
  NSDirectoryEnumerator *e = [fm enumeratorAtPath:path];
  for (NSString *rel in e) {
    NSDictionary *attrs = [e fileAttributes];
    if ([attrs[NSFileType] isEqualToString:NSFileTypeRegular]) total += [attrs fileSize];
    (void)rel;
  }
  return total;
}

@implementation PieAppModule

RCT_EXPORT_MODULE(PieAppModule)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_EXPORT_METHOD(haptic:(NSString *)kind) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if ([kind isEqualToString:@"selection"]) {
      UISelectionFeedbackGenerator *g = [UISelectionFeedbackGenerator new];
      [g selectionChanged];
    } else if ([kind isEqualToString:@"success"] || [kind isEqualToString:@"warning"] || [kind isEqualToString:@"error"]) {
      UINotificationFeedbackGenerator *g = [UINotificationFeedbackGenerator new];
      UINotificationFeedbackType type = [kind isEqualToString:@"success"] ? UINotificationFeedbackTypeSuccess
                                        : [kind isEqualToString:@"warning"] ? UINotificationFeedbackTypeWarning
                                                                            : UINotificationFeedbackTypeError;
      [g notificationOccurred:type];
    } else {
      UIImpactFeedbackStyle style = [kind isEqualToString:@"medium"] ? UIImpactFeedbackStyleMedium : UIImpactFeedbackStyleLight;
      UIImpactFeedbackGenerator *g = [[UIImpactFeedbackGenerator alloc] initWithStyle:style];
      [g impactOccurred];
    }
  });
}

RCT_EXPORT_METHOD(setClipboardString:(NSString *)text resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIPasteboard.generalPasteboard.string = text ?: @"";
    resolve(@YES);
  });
}

RCT_EXPORT_METHOD(shareText:(NSString *)text title:(NSString *)title resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *top = PieTopViewController();
    if (!top) return reject(@"SHARE_FAILED", @"No view controller to present from", nil);
    UIActivityViewController *vc = [[UIActivityViewController alloc] initWithActivityItems:@[text ?: @""] applicationActivities:nil];
    vc.popoverPresentationController.sourceView = top.view;
    vc.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(top.view.bounds), CGRectGetMidY(top.view.bounds), 1, 1);
    [top presentViewController:vc animated:YES completion:nil];
    resolve(@YES);
  });
}

RCT_EXPORT_METHOD(getAppInfo:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  resolve(@{
    @"version": info[@"CFBundleShortVersionString"] ?: @"1.0",
    @"build": info[@"CFBundleVersion"] ?: @"1",
    @"platform": @"ios",
    @"osVersion": UIDevice.currentDevice.systemVersion ?: @"",
    @"device": UIDevice.currentDevice.model ?: @"",
  });
}

RCT_EXPORT_METHOD(getStorageUsage:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    unsigned long long cache = 0;
    for (NSString *name in PieCacheDirNames()) cache += PieSizeOfPath(PieCacheDir(name));
    resolve(@{@"documentsBytes": @(PieSizeOfPath(PieDocumentsRoot())), @"cacheBytes": @(cache)});
  });
}

RCT_EXPORT_METHOD(clearCaches:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    unsigned long long freed = 0;
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *name in PieCacheDirNames()) {
      NSString *dir = PieCacheDir(name);
      freed += PieSizeOfPath(dir);
      for (NSString *entry in [fm contentsOfDirectoryAtPath:dir error:nil]) {
        [fm removeItemAtPath:[dir stringByAppendingPathComponent:entry] error:nil];
      }
    }
    resolve(@(freed));
  });
}

@end
