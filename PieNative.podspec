# PIE native layer for iOS: PDFium engine (shared C++ with Android), durable file store,
# image import/export/reconstruction, Vision OCR and app services.
# PDFium itself is a vendored xcframework fetched by scripts/fetch-pdfium-ios.sh.
Pod::Spec.new do |s|
  s.name         = 'PieNative'
  s.version      = '1.0.0'
  s.summary      = 'PIE PDF & Image Editor native modules (offline, on-device).'
  s.homepage     = 'https://github.com/Sahaj1207/PIE'
  s.license      = { :type => 'Proprietary' }
  s.author       = { 'PIE' => 'pie@example.invalid' }
  s.platforms    = { :ios => '15.1' }
  s.source       = { :git => 'https://github.com/Sahaj1207/PIE.git' }

  s.source_files = [
    'ios/PieNative/*.{h,m,mm}',
    'android/app/src/main/cpp/pdfium/pdfium_bridge.cpp',
    'android/app/src/main/cpp/pdfium/pie_bridge_core.h',
    'android/app/src/main/cpp/pdfium/pie_pdf_ops.h',
    'android/app/src/main/cpp/pdfium/pie_pdf_engine.h',
  ]
  s.public_header_files = 'ios/PieNative/PieNativeUtils.h'
  s.preserve_paths = 'android/app/src/main/cpp/include/**/*.h'
  s.vendored_frameworks = 'ios/PieNative/Vendor/pdfium.xcframework'
  s.frameworks = 'UIKit', 'Vision', 'Photos', 'ImageIO', 'UniformTypeIdentifiers', 'CoreGraphics'
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/android/app/src/main/cpp/include" "${PODS_TARGET_SRCROOT}/android/app/src/main/cpp/pdfium"',
  }
  s.dependency 'React-Core'
end
