// PIE — on-device text recognition with Apple Vision (iOS counterpart of OcrModule.kt).
// Returns the same structure as the Android ML Kit module: blocks -> lines -> words with
// pixel bounding boxes on the UPRIGHT original image grid. Never uses the network.
#import <React/RCTBridgeModule.h>
#import <Vision/Vision.h>
#import "PieNativeUtils.h"

static const double kMaxOcrPixels = 16000000.0;
static const double kMaxOcrUpscale = 3.0;

@interface OcrNativeModule : NSObject <RCTBridgeModule>
@end

@implementation OcrNativeModule {
  dispatch_queue_t _queue;
}

RCT_EXPORT_MODULE(OcrNativeModule)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  if ((self = [super init])) _queue = dispatch_queue_create("pie.ocr", DISPATCH_QUEUE_SERIAL);
  return self;
}

- (dispatch_queue_t)methodQueue {
  return _queue;
}

/** Upright image scaled by `scale` (bounded), alpha flattened onto a contrasting colour. */
- (CGImageRef)prepareImage:(NSString *)uri scale:(double)requested flatten:(BOOL)flatten
                     width:(NSInteger *)outW height:(NSInteger *)outH appliedScale:(double *)applied CF_RETURNS_RETAINED {
  NSInteger w = 0, h = 0;
  if (!PieUprightImageSize(uri, &w, &h, NULL, NULL)) return NULL;
  double budget = sqrt(kMaxOcrPixels / MAX(1.0, (double)w * h));
  double s = MIN(MAX(requested, 0.05), MIN(kMaxOcrUpscale, budget));
  CGImageRef upright = PieCreateUprightImage(uri, s < 1.0 ? (NSUInteger)lround(MAX(w, h) * s) : 0);
  if (!upright) return NULL;
  size_t tw = (size_t)MAX(1, lround(w * s)), th = (size_t)MAX(1, lround(h * s));
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(NULL, tw, th, 8, 0, cs, kCGImageAlphaNoneSkipLast);
  CGColorSpaceRelease(cs);
  if (!ctx) {
    CGImageRelease(upright);
    return NULL;
  }
  CGImageAlphaInfo alpha = CGImageGetAlphaInfo(upright);
  BOOL hasAlpha = !(alpha == kCGImageAlphaNone || alpha == kCGImageAlphaNoneSkipLast || alpha == kCGImageAlphaNoneSkipFirst);
  // Transparent pixels would otherwise become black: flatten onto white (dark ink) by default.
  CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
  if (flatten && hasAlpha) {
    // Light artwork on transparency reads better on black (same rule as Android).
    CGColorSpaceRef cs2 = CGColorSpaceCreateDeviceRGB();
    uint8_t probe[16 * 16 * 4] = {0};
    CGContextRef p = CGBitmapContextCreate(probe, 16, 16, 8, 64, cs2, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(cs2);
    CGContextDrawImage(p, CGRectMake(0, 0, 16, 16), upright);
    CGContextRelease(p);
    double lum = 0;
    int count = 0;
    for (int i = 0; i < 256; i++) {
      uint8_t a = probe[i * 4 + 3];
      if (a < 128) continue;
      lum += (0.299 * probe[i * 4] + 0.587 * probe[i * 4 + 1] + 0.114 * probe[i * 4 + 2]) * 255.0 / a / 255.0;
      count++;
    }
    if (count > 0 && lum / count > 0.6) CGContextSetRGBFillColor(ctx, 0, 0, 0, 1);
  }
  CGContextFillRect(ctx, CGRectMake(0, 0, tw, th));
  CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
  CGContextDrawImage(ctx, CGRectMake(0, 0, tw, th), upright);
  CGImageRelease(upright);
  CGImageRef out = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  if (outW) *outW = w;
  if (outH) *outH = h;
  if (applied) *applied = (double)tw / (double)w;
  return out;
}

- (void)recognize:(NSString *)uri scale:(double)scale flatten:(BOOL)flatten resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  @autoreleasepool {
    NSInteger w = 0, h = 0;
    double s = 1;
    CGImageRef image = [self prepareImage:uri scale:scale flatten:flatten width:&w height:&h appliedScale:&s];
    if (!image) return reject(@"OCR_IMAGE_READ_FAILED", @"The image could not be read for text recognition", nil);
    size_t iw = CGImageGetWidth(image), ih = CGImageGetHeight(image);

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;
    if (@available(iOS 16.0, *)) request.automaticallyDetectsLanguage = YES;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    BOOL ok = [handler performRequests:@[request] error:&error];
    CGImageRelease(image);
    if (!ok) return reject(@"OCR_FAILED", error.localizedDescription ?: @"Text recognition failed", error);

    // Vision boxes are normalised with a bottom-left origin: convert to top-left pixels on
    // the analysed image, then divide by the applied scale (original upright grid).
    NSDictionary *(^box)(CGRect) = ^NSDictionary *(CGRect n) {
      double x = n.origin.x * iw, y = (1.0 - n.origin.y - n.size.height) * ih;
      return @{@"x": @(x / s), @"y": @(y / s), @"width": @(n.size.width * iw / s), @"height": @(n.size.height * ih / s)};
    };
    NSMutableArray *blocks = [NSMutableArray array];
    NSMutableArray *fullLines = [NSMutableArray array];
    for (VNRecognizedTextObservation *obs in request.results ?: @[]) {
      VNRecognizedText *best = [obs topCandidates:1].firstObject;
      if (!best || best.string.length == 0) continue;
      NSString *text = best.string;
      [fullLines addObject:text];
      NSMutableArray *words = [NSMutableArray array];
      [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByWords usingBlock:^(NSString *word, NSRange range, NSRange enclosing, BOOL *stop) {
        VNRectangleObservation *wr = [best boundingBoxForRange:range error:nil];
        if (wr && word.length > 0) [words addObject:@{@"text": word, @"confidence": @(best.confidence), @"boundingBox": box(wr.boundingBox)}];
      }];
      NSDictionary *line = @{@"text": text, @"confidence": @(best.confidence), @"boundingBox": box(obs.boundingBox), @"words": words};
      [blocks addObject:@{@"text": text, @"boundingBox": box(obs.boundingBox), @"lines": @[line]}];
    }
    resolve(@{@"fullText": [fullLines componentsJoinedByString:@"\n"], @"imageWidth": @(w), @"imageHeight": @(h), @"blocks": blocks});
  }
}

RCT_EXPORT_METHOD(recognizeText:(NSString *)imageUriString resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self recognize:imageUriString scale:1.0 flatten:YES resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(recognizeTextWithOptions:(NSString *)imageUriString options:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  double scale = options[@"scale"] ? [options[@"scale"] doubleValue] : 1.0;
  BOOL flatten = options[@"flattenAlpha"] ? [options[@"flattenAlpha"] boolValue] : YES;
  [self recognize:imageUriString scale:scale flatten:flatten resolve:resolve reject:reject];
}

@end
