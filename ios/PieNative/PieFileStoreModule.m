// PIE — durable app-private file store (iOS counterpart of PieFileStoreModule.kt).
// Root: Application Support/pie. Every destination path must resolve inside the root.
#import <React/RCTBridgeModule.h>
#import "PieNativeUtils.h"

@interface PieFileStoreModule : NSObject <RCTBridgeModule>
@end

@implementation PieFileStoreModule {
  dispatch_queue_t _queue;
}

RCT_EXPORT_MODULE(PieFileStoreModule)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("pie.filestore", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (dispatch_queue_t)methodQueue {
  return _queue;
}

- (NSString *)insideRoot:(NSString *)path error:(NSError **)error {
  NSString *root = [[PieDocumentsRoot() stringByResolvingSymlinksInPath] stringByStandardizingPath];
  NSString *p = [[PiePlainPath(path) stringByStandardizingPath] copy];
  // Resolve the existing parent (the file itself may not exist yet).
  NSString *parent = [[[p stringByDeletingLastPathComponent] stringByResolvingSymlinksInPath] stringByStandardizingPath];
  NSString *resolved = [parent stringByAppendingPathComponent:p.lastPathComponent];
  if (![resolved isEqualToString:root] && ![resolved hasPrefix:[root stringByAppendingString:@"/"]] &&
      ![p isEqualToString:root] && ![p hasPrefix:[root stringByAppendingString:@"/"]]) {
    if (error) *error = [NSError errorWithDomain:@"PieFileStore" code:1 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Path is outside of the PIE storage root: %@", path]}];
    return nil;
  }
  return p;
}

RCT_EXPORT_METHOD(getRootPath:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(PieDocumentsRoot());
}

RCT_EXPORT_METHOD(writeFileAtomic:(NSString *)path contents:(NSString *)contents resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *target = [self insideRoot:path error:&error];
  if (!target) return reject(@"FILE_STORE_WRITE_FAILED", error.localizedDescription, error);
  [[NSFileManager defaultManager] createDirectoryAtPath:[target stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:nil];
  if (![contents writeToFile:target atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    return reject(@"FILE_STORE_WRITE_FAILED", error.localizedDescription, error);
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(readFile:(NSString *)path resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *contents = [NSString stringWithContentsOfFile:PiePlainPath(path) encoding:NSUTF8StringEncoding error:&error];
  if (!contents) return reject(@"FILE_STORE_READ_FAILED", error.localizedDescription ?: @"File not found", error);
  resolve(contents);
}

RCT_EXPORT_METHOD(exists:(NSString *)path resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@([[NSFileManager defaultManager] fileExistsAtPath:PiePlainPath(path)]));
}

RCT_EXPORT_METHOD(copyFile:(NSString *)fromPath toPath:(NSString *)toPath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *target = [self insideRoot:toPath error:&error];
  if (!target) return reject(@"FILE_STORE_COPY_FAILED", error.localizedDescription, error);
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *source = PiePlainPath(fromPath);
  if (![fm fileExistsAtPath:source]) return reject(@"FILE_STORE_COPY_FAILED", @"Source file not found", nil);
  [fm createDirectoryAtPath:[target stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *tmp = [target stringByAppendingFormat:@".tmp_%@", PieUniqueStamp()];
  if (![fm copyItemAtPath:source toPath:tmp error:&error]) {
    return reject(@"FILE_STORE_COPY_FAILED", error.localizedDescription, error);
  }
  [fm removeItemAtPath:target error:nil];
  if (![fm moveItemAtPath:tmp toPath:target error:&error]) {
    [fm removeItemAtPath:tmp error:nil];
    return reject(@"FILE_STORE_COPY_FAILED", error.localizedDescription, error);
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(deletePath:(NSString *)path resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *target = [self insideRoot:path error:&error];
  if (!target) return reject(@"FILE_STORE_DELETE_FAILED", error.localizedDescription, error);
  if ([target isEqualToString:[PieDocumentsRoot() stringByStandardizingPath]]) {
    return reject(@"FILE_STORE_DELETE_FAILED", @"Refusing to delete the storage root", nil);
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  if ([fm fileExistsAtPath:target] && ![fm removeItemAtPath:target error:&error]) {
    return reject(@"FILE_STORE_DELETE_FAILED", error.localizedDescription, error);
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(listDirectory:(NSString *)path resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSArray *entries = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:PiePlainPath(path) error:nil];
  resolve(entries ?: @[]);
}

RCT_EXPORT_METHOD(makeDirectory:(NSString *)path resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *target = [self insideRoot:path error:&error];
  if (!target) return reject(@"FILE_STORE_MKDIR_FAILED", error.localizedDescription, error);
  if (![[NSFileManager defaultManager] createDirectoryAtPath:target withIntermediateDirectories:YES attributes:nil error:&error]) {
    return reject(@"FILE_STORE_MKDIR_FAILED", error.localizedDescription, error);
  }
  resolve(nil);
}

@end
