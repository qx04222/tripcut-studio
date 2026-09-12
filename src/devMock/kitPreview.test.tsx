// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KIT_SECTIONS, KitPreview } from "./KitPreview";
import { ICON_NAMES } from "../workspace/ui/icons";

afterEach(cleanup);

describe("KitPreview(套件 kitchen-sink)", () => {
  it("每个套件组件都有一节,节名是中文", () => {
    render(<KitPreview />);
    for (const name of KIT_SECTIONS) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(KIT_SECTIONS.every((s) => !/[A-Za-z]{4,}/.test(s.replace(/Chip|Badge|Toggle|Select|Tabs|Kbd|Sheet/g, "")))).toBe(true);
  });
  it("图标一节把 33 个图标全部画出来并标名", () => {
    render(<KitPreview />);
    const section = screen.getByRole("region", { name: "图标" });
    expect(section.querySelectorAll("svg").length).toBe(ICON_NAMES.length);
    for (const name of ICON_NAMES) expect(section.textContent).toContain(name);
  });
  it("按钮一节覆盖 4 variant × 2 size × (默认/禁用/busy)", () => {
    render(<KitPreview />);
    const section = screen.getByRole("region", { name: "按钮" });
    expect(section.querySelectorAll("button").length).toBeGreaterThanOrEqual(24);
  });
  it("有深色一栏(data-theme=dark)", () => {
    render(<KitPreview />);
    expect(document.querySelector('[data-theme="dark"]')).not.toBeNull();
  });
  it("抽屉与 Sheet 一节用按钮打开真实模态,默认不开(否则整页截图被遮罩盖住)", () => {
    render(<KitPreview />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开左侧抽屉" }));
    expect(screen.getByRole("dialog", { name: "导入素材" })).toBeTruthy();
  });
});
