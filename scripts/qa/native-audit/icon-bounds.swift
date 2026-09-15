// 应用图标的不透明包围盒探针(R18 / M-11 / V-06)。
//
// 用法:  swift scripts/qa/native-audit/icon-bounds.swift src-tauri/icons/icon.png [alpha 阈值]
//
// 判据(Apple 的 macOS 应用图标网格):1024 画布里主体是 **824×824** 的连续曲率圆角方块,
// 四边各留 100。所以合格的图标满足:宽高都在 824 ± 8,且中心相对画布中心偏移 ≤ 4。
// 比这个大就会在程序坞里比访达 / Safari「大一号」—— 2026-09-14 实测旧图是 960×953,
// 大约大 16%,而且不是正方、上下留白也不对称(上 31 / 下 40)。
//
// 退出码:0 合格,1 不合格,2 读不到文件 —— 可以直接挂进门禁。
import Foundation
import CoreGraphics
import ImageIO

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: swift icon-bounds.swift <png> [alpha 阈值,默认 8]\n".data(using: .utf8)!)
    exit(2)
}
let path = args[1]
let alphaThreshold = args.count >= 3 ? UInt8(args[2]) ?? 8 : 8

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("读不到图片: \(path)\n".data(using: .utf8)!)
    exit(2)
}

let w = image.width
let h = image.height
var pixels = [UInt8](repeating: 0, count: w * h * 4)
guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write("建不了位图上下文\n".data(using: .utf8)!)
    exit(2)
}
ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

var minX = w, maxX = -1, minY = h, maxY = -1
for y in 0..<h {
    for x in 0..<w {
        if pixels[(y * w + x) * 4 + 3] >= alphaThreshold {
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            if y > maxY { maxY = y }
        }
    }
}
guard maxX >= 0 else {
    print("整张图全透明")
    exit(1)
}

// CoreGraphics 的 y 轴朝上,换算成「从上边缘数」的留白好读。
let boxW = maxX - minX + 1
let boxH = maxY - minY + 1
let topPad = h - 1 - maxY
let bottomPad = minY
let expected = Double(w) * 824.0 / 1024.0
let cx = Double(minX + maxX + 1) / 2.0
let cy = Double(minY + maxY + 1) / 2.0
let offX = cx - Double(w) / 2.0
let offY = cy - Double(h) / 2.0
let tolSize = Double(w) * 8.0 / 1024.0
let tolOff = Double(w) * 4.0 / 1024.0

print("文件      \(path)")
print("画布      \(w)×\(h)")
print("包围盒    x:\(minX)–\(maxX) / y:\(minY)–\(maxY) = \(boxW)×\(boxH)")
print("留白      左 \(minX) 右 \(w - 1 - maxX) 上 \(topPad) 下 \(bottomPad)")
print("Apple 网格 \(String(format: "%.0f", expected))(824/1024),容差 ±\(String(format: "%.0f", tolSize))")
print("中心偏移  x \(String(format: "%+.1f", offX)) / y \(String(format: "%+.1f", offY))(容差 ±\(String(format: "%.0f", tolOff)))")

var problems: [String] = []
if abs(Double(boxW) - expected) > tolSize { problems.append("宽 \(boxW) 超出 \(String(format: "%.0f", expected))±\(String(format: "%.0f", tolSize))") }
if abs(Double(boxH) - expected) > tolSize { problems.append("高 \(boxH) 超出 \(String(format: "%.0f", expected))±\(String(format: "%.0f", tolSize))") }
if abs(offX) > tolOff || abs(offY) > tolOff { problems.append("不居中") }
if problems.isEmpty {
    print("结论      合格")
    exit(0)
}
print("结论      不合格 —— " + problems.joined(separator: ";"))
exit(1)
