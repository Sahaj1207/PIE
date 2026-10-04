#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ImageProcessingModule, NSObject)

RCT_EXTERN_METHOD(reconstructBackground:(NSString *)imageUriString
                  x:(double)x
                  y:(double)y
                  width:(double)width
                  height:(double)height
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(exportImagePage:(NSDictionary *)params
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(shareFile:(NSString *)fileUriString
                  mimeType:(NSString *)mimeType
                  title:(NSString *)title
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
