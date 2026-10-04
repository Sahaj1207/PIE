import Foundation
import UIKit

@objc(ImageProcessingModule)
class ImageProcessingModule: NSObject {

  @objc
  func reconstructBackground(_ imageUriString: String,
                             x: Double,
                             y: Double,
                             width: Double,
                             height: Double,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let url = URL(string: imageUriString),
            let data = try? Data(contentsOf: url),
            let uiImage = UIImage(data: data),
            let cgImage = uiImage.cgImage else {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Unable to load image from URI: \(imageUriString)", nil)
        return
      }

      let imgW = cgImage.width
      let imgH = cgImage.height

      let padding = 5
      let targetX = max(0, Int(x) - padding)
      let targetY = max(0, Int(y) - padding)
      let targetRight = min(imgW, Int(x + width) + padding)
      let targetBottom = min(imgH, Int(y + height) + padding)
      let targetW = max(1, targetRight - targetX)
      let targetH = max(1, targetBottom - targetY)

      let borderThickness = 4
      let minX = max(0, targetX - borderThickness)
      let maxX = min(imgW - 1, targetRight + borderThickness - 1)
      let minY = max(0, targetY - borderThickness)
      let maxY = min(imgH - 1, targetBottom + borderThickness - 1)

      guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(data: nil,
                                    width: imgW,
                                    height: imgH,
                                    bitsPerComponent: 8,
                                    bytesPerRow: imgW * 4,
                                    space: colorSpace,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Failed to create CoreGraphics image context", nil)
        return
      }

      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: imgW, height: imgH))
      guard let pixelData = context.data?.assumingMemoryBound(to: UInt8.self) else {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Failed to access pixel buffer", nil)
        return
      }

      // Sample border perimeter pixels
      var samplesX = [Double]()
      var samplesY = [Double]()
      var samplesR = [Double]()
      var samplesG = [Double]()
      var samplesB = [Double]()

      for py in minY...maxY {
        for px in minX...maxX {
          let isInside = px >= targetX && px < targetRight && py >= targetY && py < targetBottom
          if !isInside {
            let offset = (py * imgW + px) * 4
            samplesX.append(Double(px))
            samplesY.append(Double(py))
            samplesR.append(Double(pixelData[offset]))
            samplesG.append(Double(pixelData[offset + 1]))
            samplesB.append(Double(pixelData[offset + 2]))
          }
        }
      }

      let n = Double(samplesX.count)
      if n == 0 {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "No border samples found", nil)
        return
      }

      let meanR = samplesR.reduce(0, +) / n
      let meanG = samplesG.reduce(0, +) / n
      let meanB = samplesB.reduce(0, +) / n

      let fitR = self.fitPlane(xs: samplesX, ys: samplesY, cs: samplesR)
      let fitG = self.fitPlane(xs: samplesX, ys: samplesY, cs: samplesG)
      let fitB = self.fitPlane(xs: samplesX, ys: samplesY, cs: samplesB)

      // Estimate text color inside original box
      var textCount = 0
      var textSumR = 0.0
      var textSumG = 0.0
      var textSumB = 0.0

      let origX = max(0, Int(x))
      let origY = max(0, Int(y))
      let origRight = min(imgW, Int(x + width))
      let origBottom = min(imgH, Int(y + height))

      for py in origY..<origBottom {
        for px in origX..<origRight {
          let offset = (py * imgW + px) * 4
          let pr = Double(pixelData[offset])
          let pg = Double(pixelData[offset + 1])
          let pb = Double(pixelData[offset + 2])

          let bgR = min(255.0, max(0.0, fitR.0 + fitR.1 * Double(px) + fitR.2 * Double(py)))
          let bgG = min(255.0, max(0.0, fitG.0 + fitG.1 * Double(px) + fitG.2 * Double(py)))
          let bgB = min(255.0, max(0.0, fitB.0 + fitB.1 * Double(px) + fitB.2 * Double(py)))

          let dist = sqrt(pow(pr - bgR, 2) + pow(pg - bgG, 2) + pow(pb - bgB, 2))
          if dist > 35.0 {
            textSumR += pr
            textSumG += pg
            textSumB += pb
            textCount += 1
          }
        }
      }

      let estimatedTextColor: String
      if textCount > 0 {
        estimatedTextColor = self.toHex(r: textSumR / Double(textCount),
                                        g: textSumG / Double(textCount),
                                        b: textSumB / Double(textCount))
      } else {
        let lum = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB
        estimatedTextColor = lum > 128 ? "#111827" : "#F9FAFB"
      }

      // Reconstruct patch
      guard let patchContext = CGContext(data: nil,
                                         width: targetW,
                                         height: targetH,
                                         bitsPerComponent: 8,
                                         bytesPerRow: targetW * 4,
                                         space: colorSpace,
                                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
            let patchData = patchContext.data?.assumingMemoryBound(to: UInt8.self) else {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Failed to allocate patch buffer", nil)
        return
      }

      for py in targetY..<targetBottom {
        let localY = py - targetY
        for px in targetX..<targetRight {
          let localX = px - targetX

          let recR = min(255.0, max(0.0, fitR.0 + fitR.1 * Double(px) + fitR.2 * Double(py)))
          let recG = min(255.0, max(0.0, fitG.0 + fitG.1 * Double(px) + fitG.2 * Double(py)))
          let recB = min(255.0, max(0.0, fitB.0 + fitB.1 * Double(px) + fitB.2 * Double(py)))

          let distToEdge = min(min(localX, targetW - 1 - localX), min(localY, targetH - 1 - localY))
          let alpha = distToEdge < 2 ? Double(distToEdge + 1) / 3.0 : 1.0

          let origOffset = (py * imgW + px) * 4
          let finalR = UInt8(min(255.0, max(0.0, recR * alpha + Double(pixelData[origOffset]) * (1.0 - alpha))))
          let finalG = UInt8(min(255.0, max(0.0, recG * alpha + Double(pixelData[origOffset + 1]) * (1.0 - alpha))))
          let finalB = UInt8(min(255.0, max(0.0, recB * alpha + Double(pixelData[origOffset + 2]) * (1.0 - alpha))))

          let patchOffset = (localY * targetW + localX) * 4
          patchData[patchOffset] = finalR
          patchData[patchOffset + 1] = finalG
          patchData[patchOffset + 2] = finalB
          patchData[patchOffset + 3] = 255
        }
      }

      guard let patchCG = patchContext.makeImage() else {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Failed to render patch image", nil)
        return
      }

      let patchImage = UIImage(cgImage: patchCG)
      guard let pngData = patchImage.pngData() else {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Failed to encode patch PNG", nil)
        return
      }

      let tempDir = FileManager.default.temporaryDirectory
      let patchFilename = "patch_\(Int(Date().timeIntervalSince1970))_\(UUID().uuidString.prefix(8)).png"
      let patchUrl = tempDir.appendingPathComponent(patchFilename)

      do {
        try pngData.write(to: patchUrl)
        var result = [String: Any]()
        result["patchUri"] = patchUrl.absoluteString
        result["bounds"] = [
          "x": Double(targetX),
          "y": Double(targetY),
          "width": Double(targetW),
          "height": Double(targetH)
        ]
        result["estimatedBackgroundColor"] = self.toHex(r: meanR, g: meanG, b: meanB)
        result["estimatedTextColor"] = estimatedTextColor
        result["confidence"] = 0.92

        resolve(result)
      } catch {
        reject("BACKGROUND_RECONSTRUCTION_FAILED", "Failed to write patch file: \(error.localizedDescription)", error)
      }
    }
  }

  @objc
  func exportImagePage(_ params: [String: Any],
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let sourceUriString = params["sourceImageUri"] as? String,
            let url = URL(string: sourceUriString),
            let data = try? Data(contentsOf: url),
            let baseImage = UIImage(data: data) else {
        reject("EXPORT_FAILED", "Unable to load source image for export", nil)
        return
      }

      let format = (params["format"] as? String)?.lowercased() ?? "png"
      let quality = (params["quality"] as? Double) ?? 95.0
      let size = baseImage.size

      let rendererFormat = UIGraphicsImageRendererFormat.default()
      rendererFormat.scale = 1.0 // 1:1 original pixel scale
      let renderer = UIGraphicsImageRenderer(size: size, format: rendererFormat)

      let compositedImage = renderer.image { ctx in
        // Layer 1: Base Image
        baseImage.draw(in: CGRect(origin: .zero, size: size))

        // Layer 2: Reconstructed background patches
        if let patches = params["patches"] as? [[String: Any]] {
          for patch in patches {
            if let patchUri = patch["patchUri"] as? String,
               let pUrl = URL(string: patchUri),
               let pData = try? Data(contentsOf: pUrl),
               let patchImg = UIImage(data: pData),
               let bounds = patch["bounds"] as? [String: Double],
               let px = bounds["x"], let py = bounds["y"],
               let pw = bounds["width"], let ph = bounds["height"] {
              patchImg.draw(in: CGRect(x: px, y: py, width: pw, height: ph))
            }
          }
        }

        // Layer 3: Replacement text layer
        if let textElements = params["textElements"] as? [[String: Any]] {
          for el in textElements {
            if let text = el["text"] as? String,
               let bounds = el["bounds"] as? [String: Double],
               let px = bounds["x"],
               let baselineY = el["baselineY"] as? Double,
               let fontSize = el["fittedFontSize"] as? Double {
              let isBold = (el["fontWeight"] as? String) == "bold"
              let font = isBold ? UIFont.boldSystemFont(ofSize: CGFloat(fontSize)) : UIFont.systemFont(ofSize: CGFloat(fontSize))
              let colorHex = (el["color"] as? String) ?? "#111827"
              let textColor = self.colorFromHex(colorHex)

              let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: textColor
              ]

              // Baseline draw
              let textPoint = CGPoint(x: px + 1.0, y: baselineY - Double(font.ascender))
              (text as NSString).draw(at: textPoint, withAttributes: attrs)
            }
          }
        }
      }

      let isPng = format == "png"
      let fileData: Data?
      let ext: String
      if isPng {
        fileData = compositedImage.pngData()
        ext = "png"
      } else {
        fileData = compositedImage.jpegData(compressionQuality: CGFloat(min(1.0, max(0.1, quality / 100.0))))
        ext = "jpg"
      }

      guard let exportData = fileData else {
        reject("EXPORT_FAILED", "Failed to compress exported image data", nil)
        return
      }

      let tempDir = FileManager.default.temporaryDirectory
      let exportFilename = "export_\(Int(Date().timeIntervalSince1970))_\(UUID().uuidString.prefix(8)).\(ext)"
      let exportUrl = tempDir.appendingPathComponent(exportFilename)

      do {
        try exportData.write(to: exportUrl)
        var result = [String: Any]()
        result["destinationUri"] = exportUrl.absoluteString
        result["format"] = isPng ? "png" : "jpeg"
        result["fileSizeBytes"] = Double(exportData.count)
        result["width"] = Double(size.width)
        result["height"] = Double(size.height)

        resolve(result)
      } catch {
        reject("EXPORT_FAILED", "Failed to write exported file: \(error.localizedDescription)", error)
      }
    }
  }

  @objc
  func shareFile(_ fileUriString: String,
                 mimeType: String,
                 title: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let url = URL(string: fileUriString) else {
        reject("EXPORT_FAILED", "Invalid file URI: \(fileUriString)", nil)
        return
      }

      let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      if let rootVC = UIApplication.shared.windows.first?.rootViewController {
        // iPad support
        if let popover = activityVC.popoverPresentationController {
          popover.sourceView = rootVC.view
          popover.sourceRect = CGRect(x: rootVC.view.bounds.midX, y: rootVC.view.bounds.midY, width: 0, height: 0)
          popover.permittedArrowDirections = []
        }
        rootVC.present(activityVC, animated: true) {
          resolve(true)
        }
      } else {
        reject("EXPORT_FAILED", "Unable to find root view controller", nil)
      }
    }
  }

  private func fitPlane(xs: [Double], ys: [Double], cs: [Double]) -> (Double, Double, Double) {
    let n = Double(xs.count)
    var sumX = 0.0, sumY = 0.0, sumXX = 0.0, sumYY = 0.0, sumXY = 0.0
    var sumC = 0.0, sumXC = 0.0, sumYC = 0.0

    for i in 0..<xs.count {
      let x = xs[i]
      let y = ys[i]
      let c = cs[i]
      sumX += x
      sumY += y
      sumXX += x * x
      sumYY += y * y
      sumXY += x * y
      sumC += c
      sumXC += x * c
      sumYC += y * c
    }

    let det = n * (sumXX * sumYY - sumXY * sumXY) -
              sumX * (sumX * sumYY - sumXY * sumY) +
              sumY * (sumX * sumXY - sumXX * sumY)

    if abs(det) < 1e-6 {
      return (sumC / n, 0.0, 0.0)
    }

    let detC0 = sumC * (sumXX * sumYY - sumXY * sumXY) -
                sumX * (sumXC * sumYY - sumXY * sumYC) +
                sumY * (sumXC * sumXY - sumXX * sumYC)

    let detA = n * (sumXC * sumYY - sumXY * sumYC) -
               sumC * (sumX * sumYY - sumXY * sumY) +
               sumY * (sumX * sumYC - sumXC * sumY)

    let detB = n * (sumXX * sumYC - sumXC * sumXY) -
               sumX * (sumX * sumYC - sumXC * sumY) +
               sumC * (sumX * sumXY - sumXX * sumY)

    return (detC0 / det, detA / det, detB / det)
  }

  private func toHex(r: Double, g: Double, b: Double) -> String {
    let ir = min(255, max(0, Int(r.rounded())))
    let ig = min(255, max(0, Int(g.rounded())))
    let ib = min(255, max(0, Int(b.rounded())))
    return String(format: "#%02X%02X%02X", ir, ig, ib)
  }

  private func colorFromHex(_ hex: String) -> UIColor {
    var cString = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if cString.hasPrefix("#") {
      cString.remove(at: cString.startIndex)
    }
    if cString.count != 6 {
      return UIColor.black
    }
    var rgbValue: UInt64 = 0
    Scanner(string: cString).scanHexInt64(&rgbValue)
    return UIColor(
      red: CGFloat((rgbValue & 0xFF0000) >> 16) / 255.0,
      green: CGFloat((rgbValue & 0x00FF00) >> 8) / 255.0,
      blue: CGFloat(rgbValue & 0x0000FF) / 255.0,
      alpha: 1.0
    )
  }
}
