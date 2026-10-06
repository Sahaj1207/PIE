// PIE — shared helpers for the iOS native modules (paths, presentation, hashing, images).
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/** App-private durable root (Application Support/pie) — mirrors Android filesDir/pie. */
NSString *PieDocumentsRoot(void);
/** Cache sub-directory (created on demand) — mirrors Android cacheDir/<name>. */
NSString *PieCacheDir(NSString *name);
/** Strips file:// and percent-decodes. */
NSString *PiePlainPath(NSString *uriOrPath);
/** file:// URI for an absolute path. */
NSString *PieFileUri(NSString *path);
/** True when `path` lies inside Application Support, Caches or tmp of this app. */
BOOL PieIsAppPrivatePath(NSString *path);
/** Topmost presented view controller for modal presentation (main thread only). */
UIViewController *_Nullable PieTopViewController(void);
/** SHA-256 hex digest of a file (nil if unreadable). */
NSString *_Nullable PieSha256OfFile(NSString *path);
/** Safe file name: no path separators/control characters, max 120 chars. */
NSString *PieSanitizeFileName(NSString *_Nullable name, NSString *fallback, NSString *_Nullable requiredExtension);
/** Unique suffix (timestamp + random). */
NSString *PieUniqueStamp(void);

/**
 * Decodes an image upright (EXIF orientation applied) with its long side limited to
 * `maxLongSide` (0 = full size) via ImageIO. Caller releases the result.
 */
CGImageRef _Nullable PieCreateUprightImage(NSString *uriOrPath, NSUInteger maxLongSide) CF_RETURNS_RETAINED;
/** Pixel size after EXIF orientation, without decoding pixels. */
BOOL PieUprightImageSize(NSString *uriOrPath, NSInteger *width, NSInteger *height, NSInteger *_Nullable exifOrientation, NSString *_Nullable *_Nullable uti);
/** Writes PNG (or JPEG when quality < 1 and opaque) data for a CGImage. */
BOOL PieWriteImage(CGImageRef image, NSString *path, BOOL png, CGFloat quality);

/** Retains a UIDocumentPicker delegate while the picker is shown. */
@interface PieDocumentPickerDelegate : NSObject <UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate>
@property (nonatomic, copy) void (^onPick)(NSArray<NSURL *> *urls);
@property (nonatomic, copy) void (^onCancel)(void);
@end

NS_ASSUME_NONNULL_END
