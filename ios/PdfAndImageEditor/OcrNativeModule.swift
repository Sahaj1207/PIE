import Foundation
import Vision
import ImageIO
import React

@objc(OcrNativeModule)
class OcrNativeModule: NSObject {

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(recognizeText:resolver:rejecter:)
  func recognizeText(_ imageUriString: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let url = URL(string: imageUriString) ?? URL(fileURLWithPath: imageUriString) as URL? else {
      reject("INVALID_URI", "Invalid image URI: \(imageUriString)", nil)
      return
    }

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let imageData = try Data(contentsOf: url)
        guard let imageSource = CGImageSourceCreateWithData(imageData as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
          reject("IMAGE_DECODE_FAILED", "Failed to decode image from: \(imageUriString)", nil)
          return
        }

        let width = Double(cgImage.width)
        let height = Double(cgImage.height)

        let request = VNRecognizeTextRequest { (request, error) in
          if let error = error {
            reject("OCR_PROCESSING_FAILED", "Vision OCR failed: \(error.localizedDescription)", error)
            return
          }

          guard let observations = request.results as? [VNRecognizedTextObservation] else {
            resolve([
              "fullText": "",
              "imageWidth": width,
              "imageHeight": height,
              "blocks": []
            ])
            return
          }

          var fullText = ""
          var blocks: [[String: Any]] = []

          for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string
            let confidence = candidate.confidence

            if !fullText.isEmpty {
              fullText += "\n"
            }
            fullText += text

            // Apple Vision coordinates: origin is bottom-left, normalized 0..1
            // Convert to top-left pixel coordinates
            let box = observation.boundingBox
            let x = box.origin.x * width
            let y = (1.0 - box.origin.y - box.size.height) * height
            let w = box.size.width * width
            let h = box.size.height * height

            let boundingBox: [String: Any] = [
              "x": x,
              "y": y,
              "width": w,
              "height": h
            ]

            let line: [String: Any] = [
              "text": text,
              "confidence": Double(confidence),
              "boundingBox": boundingBox,
              "words": []
            ]

            let block: [String: Any] = [
              "text": text,
              "boundingBox": boundingBox,
              "lines": [line]
            ]

            blocks.append(block)
          }

          resolve([
            "fullText": fullText,
            "imageWidth": width,
            "imageHeight": height,
            "blocks": blocks
          ])
        }

        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

      } catch {
        reject("OCR_FAILED", "Failed to process image: \(error.localizedDescription)", error)
      }
    }
  }
}
