// sidecar-ocr: 随包 Vision OCR 工具，离线识别画面中的中英文文字。
//
// 协议：stdin 一行一个图片绝对路径；对每一行在 stdout 打印一行 JSON：
//   成功：{"path":"...","texts":[{"text":"...","confidence":0.0-1.0,"bbox":[x,y,w,h]}]}
//   失败（坏图/读取失败）：{"path":"...","error":"..."}，继续处理下一行，不中止进程。
// 进程本身以 0 退出（除非 stdin/stdout 管道本身损坏）——单张图片的失败通过
// 该行的 "error" 字段表达，调用方（src-tauri/src/core/ocr.rs）据此逐条判定。
//
// License: Apache-2.0（TripCut 自有代码；见 scripts/package-dmg.sh 内的
// native-sbom 条目与 legal/sidecar-ocr/ 下的 provenance）。

import AppKit
import CoreImage
import Foundation
import Vision

struct TextHit: Encodable {
    let text: String
    let confidence: Float
    let bbox: [Double]
}

struct SuccessLine: Encodable {
    let path: String
    let texts: [TextHit]
}

struct ErrorLine: Encodable {
    let path: String
    let error: String
}

let encoder = JSONEncoder()

func emit<T: Encodable>(_ value: T) {
    guard let data = try? encoder.encode(value),
          let line = String(data: data, encoding: .utf8) else {
        // 连 JSON 都编不出来时，退化成最保守的一行，绝不让 stdout 断流。
        print("{\"path\":\"\",\"error\":\"encode failure\"}")
        fflush(stdout)
        return
    }
    print(line)
    fflush(stdout)
}

// Vision 的 boundingBox 原点在左下角、归一化坐标；协议要求左上角原点，
// 因此对每个观测结果翻转 y：newY = 1 - y - height。
func recognizeTextThrowing(atPath path: String) throws -> [TextHit] {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else {
        throw NSError(
            domain: "sidecar-ocr", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "file not found: \(path)"]
        )
    }
    let handler = VNImageRequestHandler(url: url, options: [:])
    var hits: [TextHit] = []
    var requestError: Error?
    let request = VNRecognizeTextRequest { request, error in
        if let error {
            requestError = error
            return
        }
        guard let observations = request.results as? [VNRecognizedTextObservation] else {
            return
        }
        for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let box = observation.boundingBox
            let flippedY = 1.0 - box.origin.y - box.height
            hits.append(
                TextHit(
                    text: candidate.string,
                    confidence: candidate.confidence,
                    bbox: [
                        Double(box.origin.x),
                        Double(flippedY),
                        Double(box.width),
                        Double(box.height),
                    ]
                )
            )
        }
    }
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true

    try handler.perform([request])
    if let requestError {
        throw requestError
    }
    return hits
}

while let line = readLine(strippingNewline: true) {
    let path = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if path.isEmpty {
        continue
    }
    do {
        let hits = try recognizeTextThrowing(atPath: path)
        emit(SuccessLine(path: path, texts: hits))
    } catch {
        emit(ErrorLine(path: path, error: "\(error.localizedDescription)"))
    }
}
exit(0)
