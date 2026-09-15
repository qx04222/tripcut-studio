// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMenuAction, runMenuAction } from "./menuBridge";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
import { __resetUndoForTests, pushUndo } from "./undoStack";
import { getToastSnapshot } from "./ui/toastStore";

vi.mock("./update/updateStore", () => ({ runUpdateCheck: vi.fn(async () => undefined) }));

describe("menuBridge", () => {
  beforeEach(() => {
    __resetWorkspaceForTests();
    __resetUndoForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("「偏好设置…」开设置抽屉,「关于旅剪工作台」直落关于那一段", () => {
    runMenuAction("settings");
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
    __resetWorkspaceForTests();
    runMenuAction("about");
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
    expect(getWorkspaceSnapshot().settingsSection).toBe("about");
  });

  it("「导入素材…」开导入抽屉的素材来源页,「导出…」开交付抽屉", () => {
    runMenuAction("import");
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
    runMenuAction("export");
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });

  it("「命令面板」「帮助」只广播已有的窗口事件", () => {
    const palette = vi.fn();
    const help = vi.fn();
    window.addEventListener("tripcut:open-command-palette", palette);
    window.addEventListener("tripcut:open-help", help);
    runMenuAction("command-palette");
    runMenuAction("help-manual");
    runMenuAction("help-shortcuts");
    window.removeEventListener("tripcut:open-command-palette", palette);
    window.removeEventListener("tripcut:open-help", help);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(help).toHaveBeenCalledTimes(2);
  });

  it("「撤销」走应用撤销栈——这正是 ⌘Z 被原生菜单吃掉之前够不着的那一条", async () => {
    const undone = vi.fn(async () => undefined);
    pushUndo({ label: "批量评级", undo: undone });
    runMenuAction("undo");
    await vi.waitFor(() => expect(undone).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getToastSnapshot()?.text).toContain("已撤销"));
  });

  it("空栈时「撤销」说一句「没有可撤销的操作」,不静默", async () => {
    runMenuAction("undo");
    await vi.waitFor(() => expect(getToastSnapshot()?.text).toBe("没有可撤销的操作"));
  });

  it("焦点在输入框里时「撤销」让文本框自己撤销,不动应用撤销栈", () => {
    const undone = vi.fn(async () => undefined);
    pushUndo({ label: "批量评级", undo: undone });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
    runMenuAction("undo");
    input.remove();
    expect(execCommand).toHaveBeenCalledWith("undo");
    expect(undone).not.toHaveBeenCalled();
  });

  it("不认识的菜单 id 什么都不做", () => {
    expect(isMenuAction("nope")).toBe(false);
    runMenuAction("nope");
    expect(getWorkspaceSnapshot().openDrawer).toBeNull();
  });
});
