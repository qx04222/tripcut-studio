import { describe, expect, it } from "vitest";

import { auditMenuBar, hasChinese } from "./menuAudit.mjs";

/** R18 之前线上那条(Tauri 默认)菜单栏的实抓形态——探针必须对它报红。 */
const DEFAULT_MENU_BAR = {
  ok: true,
  menus: [
    { title: "旅剪工作台", items: [{ title: "About 旅剪工作台" }, { title: "Services" }, { title: "Quit 旅剪工作台", cmd: "q" }] },
    { title: "File", items: [{ title: "Close Window", cmd: "w" }] },
    { title: "Edit", items: [{ title: "Undo", cmd: "z" }, { title: "Redo" }, { title: "Cut" }, { title: "Copy" }] },
    { title: "View", items: [{ title: "Toggle Full Screen" }] },
    { title: "Window", items: [{ title: "Minimize", cmd: "m" }] },
    { title: "Help", items: [{ title: "Send 旅剪工作台 Feedback to Apple" }] },
  ],
};

const NEW_MENU_BAR = {
  ok: true,
  menus: [
    {
      title: "旅剪工作台",
      items: [{ title: "关于旅剪工作台" }, { title: "检查更新…" }, { title: "偏好设置…", cmd: "," }, { title: "服务" }, { title: "退出旅剪工作台", cmd: "q" }],
    },
    { title: "文件", items: [{ title: "导入素材…", cmd: "i" }, { title: "导出…", cmd: "e" }, { title: "关闭窗口", cmd: "w" }] },
    { title: "编辑", items: [{ title: "撤销", cmd: "z" }, { title: "重做", cmd: "Z" }, { title: "剪切" }, { title: "拷贝" }, { title: "粘贴" }, { title: "全选" }] },
    { title: "显示", items: [{ title: "命令面板", cmd: "k" }, { title: "进入全屏" }] },
    { title: "窗口", items: [{ title: "最小化", cmd: "m" }, { title: "缩放" }] },
    { title: "帮助", items: [{ title: "旅剪使用手册" }, { title: "快捷键表" }] },
  ],
};

describe("菜单栏审计", () => {
  it("抓不到 / 没权限 / 菜单少于六条一律报探针故障,不报缺陷", () => {
    expect(auditMenuBar({ ok: false, error: "没有辅助功能权限" }).status).toBe("PROBE");
    expect(auditMenuBar({ ok: true, menus: [{ title: "旅剪工作台", items: [] }] }).status).toBe("PROBE");
  });

  it("对 R18 之前那条默认英文菜单栏报红(探针会红的证据)", () => {
    const verdict = auditMenuBar(DEFAULT_MENU_BAR);
    expect(verdict.status).toBe("FAIL");
    expect(verdict.findings.join("\n")).toContain("Undo");
    expect(verdict.findings.some((line) => line.includes("设置…"))).toBe(true);
    expect(verdict.findings.some((line) => line.includes("File") || line.includes("Edit"))).toBe(true);
  });

  it("对 M-01 的中文菜单栏放行", () => {
    expect(auditMenuBar(NEW_MENU_BAR)).toEqual({ status: "PASS", findings: [] });
  });

  it("中文判定按码点,不按空格分词", () => {
    expect(hasChinese("导入素材…")).toBe(true);
    expect(hasChinese("Toggle Full Screen")).toBe(false);
  });
});
