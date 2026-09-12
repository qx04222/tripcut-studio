// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetModalStackForTests } from "../modalStack";
import { Drawer } from "./Drawer";
import { Sheet } from "./Sheet";

afterEach(() => {
  cleanup();
  __resetModalStackForTests();
});

describe("Drawer / Sheet 模态壳(迁自 workspace/Drawer.tsx,四条行为一条不丢)", () => {
  it("role=dialog aria-modal,AX 名 = title,标题栏有 20px 标题与可见「关闭」", () => {
    render(<Drawer open title="导入素材" side="left" width="600px" onClose={() => {}}>x</Drawer>);
    const dialog = screen.getByRole("dialog", { name: "导入素材" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(dialog.querySelector(".ui-modal-title")!.textContent).toBe("导入素材");
    expect(dialog.className).toContain("ui-modal--left");
    expect(dialog.style.width).toBe("600px");
  });
  it("open=false 什么都不渲染", () => {
    render(<Drawer open={false} title="A" side="left" width="600px" onClose={() => {}}>x</Drawer>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Esc 关闭;栈顶之下的模态不响应", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(<><Drawer open title="A" side="left" width="600px" onClose={closeA}>a</Drawer><Sheet open title="B" onClose={closeB}>b</Sheet></>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });
  it("在遮罩上按下才关;在抽屉内按下、拖到遮罩松手不关", () => {
    const onClose = vi.fn();
    render(<Drawer open title="A" side="right" width="600px" onClose={onClose}><p>内容</p></Drawer>);
    fireEvent.mouseDown(screen.getByText("内容"));
    fireEvent.click(document.querySelector(".ui-modal-overlay")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".ui-modal-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("打开后焦点进入对话框(真机 Esc 关不掉的第一嫌疑是焦点根本没进来)", () => {
    render(<Drawer open title="A" side="left" width="600px" onClose={() => {}}><button>第一个</button></Drawer>);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });
  it("Sheet 居中且带 height", () => {
    render(<Sheet open title="设置" onClose={() => {}}>x</Sheet>);
    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(dialog.className).toContain("ui-modal--center");
    expect(dialog.style.height).toBe("80vh");
    expect(dialog.style.width).toBe("960px");
  });
  it("actions 渲染在标题栏右侧、关闭键之前", () => {
    render(<Drawer open title="A" side="left" width="600px" onClose={() => {}} actions={<button>立即扫描</button>}>x</Drawer>);
    const bar = document.querySelector(".ui-modal-titlebar")!;
    const buttons = [...bar.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["立即扫描", "×关闭"]);
  });
  it("点「关闭」触发 onClose", () => {
    const onClose = vi.fn();
    render(<Drawer open title="A" side="left" width="600px" onClose={onClose}>x</Drawer>);
    screen.getByRole("button", { name: "关闭" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
