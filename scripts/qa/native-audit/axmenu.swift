// R18 车道 native / M-01 的真机探针:把某个进程的整棵 AXMenuBar 抓成 JSON。
//
// 用法:swiftc -O -o axmenu axmenu.swift && ./axmenu <pid>
// 输出:{"ok":true,"menus":[{"title":"文件","items":[{"title":"导入素材…","cmd":"i","enabled":true}]}]}
//
// 注意(R18 头脑风暴 §1.1 实测):
//   - 需要「辅助功能」权限,给的是**跑这个二进制的终端**,不是应用本身;
//     没有权限时 AXUIElementCopyAttributeValue 返回 -25204,这里如实报 ok:false,
//     让上层判成探针故障(PROBE)而不是"菜单缺失"。
//   - 不 AXPress 展开任何菜单:AppKit 的菜单项在**没被打开过**时也报得出
//     AXTitle / AXMenuItemCmdChar,展开反而会把焦点从被测应用上抢走。

import Foundation
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return status == .success ? value : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    guard let raw = attribute(element, kAXChildrenAttribute as String) else { return [] }
    return (raw as? [AXUIElement]) ?? []
}

func title(_ element: AXUIElement) -> String {
    (attribute(element, kAXTitleAttribute as String) as? String) ?? ""
}

/// 一个菜单项:标题、快捷键字符(AXMenuItemCmdChar)、启用态。
func describeItem(_ element: AXUIElement) -> [String: Any] {
    var item: [String: Any] = [
        "title": title(element),
        "enabled": (attribute(element, kAXEnabledAttribute as String) as? Bool) ?? false,
    ]
    if let cmd = attribute(element, "AXMenuItemCmdChar") as? String, !cmd.isEmpty {
        item["cmd"] = cmd
    }
    if let modifiers = attribute(element, "AXMenuItemCmdModifiers") as? Int {
        item["modifiers"] = modifiers
    }
    // 子菜单(AXMenu)里才是真正的条目。
    let nested = children(element).flatMap { children($0) }
    if !nested.isEmpty {
        item["items"] = nested.map { describeItem($0) }
    }
    return item
}

func emit(_ payload: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(payload["ok"] as? Bool == true ? 0 : 3)
}

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
    emit(["ok": false, "error": "用法:axmenu <pid>"])
}

if !AXIsProcessTrusted() {
    emit(["ok": false, "error": "没有辅助功能权限——去 系统设置 › 隐私与安全性 › 辅助功能 给这个终端打勾"])
}

let application = AXUIElementCreateApplication(pid)
guard let menuBarValue = attribute(application, kAXMenuBarAttribute as String) else {
    emit(["ok": false, "error": "pid \(pid) 读不到 AXMenuBar(进程没在前台跑?)"])
}
let menuBar = menuBarValue as! AXUIElement

let menus: [[String: Any]] = children(menuBar).map { submenu in
    let items = children(submenu).flatMap { children($0) }.map { describeItem($0) }
    return ["title": title(submenu), "items": items]
}
emit(["ok": true, "pid": Int(pid), "menus": menus])
