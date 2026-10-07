#!/usr/bin/env bash
# Downloads prebuilt PDFium for iOS (device + simulator) from bblanchon/pdfium-binaries and
# packages it as ios/PieNative/Vendor/pdfium.xcframework. Run on macOS before `pod install`:
#   ./scripts/fetch-pdfium-ios.sh            # pinned release (matches Android)
#   PDFIUM_TAG=chromium/7350 ./scripts/fetch-pdfium-ios.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/ios/PieNative/Vendor"
TAG="${PDFIUM_TAG:-chromium/8066}"  # same release as the Android libpdfium.so
if [ "$TAG" = "latest" ]; then BASE="https://github.com/bblanchon/pdfium-binaries/releases/latest/download"; else BASE="https://github.com/bblanchon/pdfium-binaries/releases/download/$TAG"; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() { # $1 = archive name, $2 = dir
  mkdir -p "$WORK/$2"
  curl -fsSL "$BASE/$1" -o "$WORK/$1"
  tar -xzf "$WORK/$1" -C "$WORK/$2"
}
fetch pdfium-ios-device-arm64.tgz device
fetch pdfium-ios-simulator-arm64.tgz sim-arm64
fetch pdfium-ios-simulator-x64.tgz sim-x64

# Wrap a dylib into a framework (iOS requires dynamic code inside .framework bundles).
make_framework() { # $1 = dylib, $2 = dest dir
  local fw="$2/pdfium.framework"
  mkdir -p "$fw/Headers"
  cp "$1" "$fw/pdfium"
  install_name_tool -id "@rpath/pdfium.framework/pdfium" "$fw/pdfium"
  cp -R "$WORK/device/include/." "$fw/Headers/"
  cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>pdfium</string>
<key>CFBundleIdentifier</key><string>org.pdfium.pdfium</string>
<key>CFBundleName</key><string>pdfium</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>15.1</string>
</dict></plist>
PLIST
}

rm -rf "$OUT/pdfium.xcframework"
if [ -f "$WORK/device/lib/libpdfium.a" ]; then
  lipo -create "$WORK/sim-arm64/lib/libpdfium.a" "$WORK/sim-x64/lib/libpdfium.a" -output "$WORK/libpdfium-sim.a"
  xcodebuild -create-xcframework \
    -library "$WORK/device/lib/libpdfium.a" -headers "$WORK/device/include" \
    -library "$WORK/libpdfium-sim.a" -headers "$WORK/device/include" \
    -output "$OUT/pdfium.xcframework"
else
  lipo -create "$WORK/sim-arm64/lib/libpdfium.dylib" "$WORK/sim-x64/lib/libpdfium.dylib" -output "$WORK/libpdfium-sim.dylib"
  make_framework "$WORK/device/lib/libpdfium.dylib" "$WORK/fw-device"
  make_framework "$WORK/libpdfium-sim.dylib" "$WORK/fw-sim"
  xcodebuild -create-xcframework \
    -framework "$WORK/fw-device/pdfium.framework" \
    -framework "$WORK/fw-sim/pdfium.framework" \
    -output "$OUT/pdfium.xcframework"
fi
echo "PDFium for iOS ready: $OUT/pdfium.xcframework"
