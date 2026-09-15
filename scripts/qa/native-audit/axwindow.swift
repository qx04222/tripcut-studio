// R18 车道 native2 / M-12 的真机探针:抓某个进程主窗口的几何 + 所有屏幕的可见区域。
//
// 用法:swiftc -O -o axwindow axwindow.swift && ./axwindow <pid>
// 输出:{"ok":true,"window":{"x":100,"y":60,"width":1512,"height":945},
//        "screens":[{"x":0,"y":0,"width":1512,"height":945}]}
//
// 只**读** AX 树,不 AXPress、不发按键、不移动窗口——不会把焦点从被测应用上抢走。
// 没有辅助功能权限时 AXUIElementCopyAttributeValue 返回 -25204,这里如实报 ok:false,
// 让上层判成探针故障(PROBE)而不是"窗口跑到屏外去了"。
//
// 坐标系:AX 用的是**左上原点、y 向下**的全局坐标;NSScreen.frame 是左下原点。
// 这里把屏幕换算成 AX 的那一套再输出,两边才能直接求交。

import Foundation
import ApplicationServices
import AppKit

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return status == .success ? value : nil
}

/// 读属性并带上 AXError —— 读不到时要说清是**哪一条**、**错在哪**,
/// 否则 PROBE 只是一句"抓不到",没人能据此判断是权限、是锁屏还是窗口没建好。
func attributeWithStatus(_ element: AXUIElement, _ name: String) -> (CFTypeRef?, AXError) {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (status == .success ? value : nil, status)
}

func fail(_ message: String) -> Never {
    let payload: [String: Any] = ["ok": false, "error": message]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    exit(0)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, let pid = Int32(arguments[1]) else {
    fail("用法:axwindow <pid>")
}

/// `value as? [AXUIElement]` 会**静默桥接错**:实测拿回来的数组里装的是应用元素本身,
/// 于是 AXPosition 报 -25205(属性不支持),看起来像"窗口跑掉了"。
/// 走 CFArray 原始接口才拿得到真正的窗口元素。
func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    guard let raw = attribute(element, name) else { return [] }
    guard CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
    let array = raw as! CFArray
    return (0..<CFArrayGetCount(array)).compactMap { index in
        guard let pointer = CFArrayGetValueAtIndex(array, index) else { return nil }
        return unsafeBitCast(pointer, to: AXUIElement.self)
    }
}

let application = AXUIElementCreateApplication(pid)
let windows = elements(application, kAXWindowsAttribute as String)
guard let first = windows.first else {
    fail("抓不到窗口(没有辅助功能权限,或这个 pid 还没建窗口)")
}
// 实测(2026-09-14,锁屏状态下对 0.8.3 的实例):AXWindows 里装的可能是**应用元素本身**
// (role=AXApplication),它的 AXPosition 一读就是 -25205。不挡这一下,PROBE 会被误读成
// "窗口跑到屏外去了"——探针自己必须先认得出"这不是一个窗口"。
let role = (attribute(first, kAXRoleAttribute as String) as? String) ?? "(读不到)"
guard role == (kAXWindowRole as String) else {
    fail("AXWindows 第一个元素的 role 是 \(role),不是 AXWindow —— 多半是锁屏 / 应用还没建窗口,先别当成缺陷")
}

var position = CGPoint.zero
var size = CGSize.zero
let (positionRaw, positionStatus) = attributeWithStatus(first, kAXPositionAttribute as String)
let (sizeRaw, sizeStatus) = attributeWithStatus(first, kAXSizeAttribute as String)
guard let positionRaw, let sizeRaw else {
    fail("窗口读得到,但拿不到位置 / 尺寸(AXPosition=\(positionStatus.rawValue) AXSize=\(sizeStatus.rawValue);-25204=没有辅助功能权限,锁屏时也可能读不到)")
}
guard CFGetTypeID(positionRaw) == AXValueGetTypeID(), CFGetTypeID(sizeRaw) == AXValueGetTypeID(),
      AXValueGetValue(positionRaw as! AXValue, .cgPoint, &position),
      AXValueGetValue(sizeRaw as! AXValue, .cgSize, &size) else {
    fail("位置 / 尺寸读到了,但不是 AXValue —— 探针自己坏了")
}

// NSScreen.frame 是左下原点;整个桌面的高度以主屏为准,换成 AX 的左上原点。
let mainHeight = NSScreen.screens.first?.frame.maxY ?? 0
let screens: [[String: Double]] = NSScreen.screens.map { screen in
    let frame = screen.visibleFrame
    return [
        "x": Double(frame.origin.x),
        "y": Double(mainHeight - frame.maxY),
        "width": Double(frame.width),
        "height": Double(frame.height),
    ]
}

let payload: [String: Any] = [
    "ok": true,
    "window": [
        "x": Double(position.x),
        "y": Double(position.y),
        "width": Double(size.width),
        "height": Double(size.height),
    ],
    "screens": screens,
]
let data = try! JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
