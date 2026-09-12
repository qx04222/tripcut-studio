// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./Button";

afterEach(cleanup);

describe("Button", () => {
  it("四个 variant 各自落 class,默认 secondary/md", () => {
    const { rerender } = render(<Button>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button.className).toContain("ui-button--secondary");
    expect(button.className).toContain("ui-button--md");
    expect(button.getAttribute("type")).toBe("button");
    for (const variant of ["primary", "ghost"] as const) {
      rerender(<Button variant={variant}>保存</Button>);
      expect(screen.getByRole("button").className).toContain(`ui-button--${variant}`);
    }
    rerender(<Button variant="icon" icon="settings" aria-label="设置" />);
    expect(screen.getByRole("button", { name: "设置" }).className).toContain("ui-button--icon");
  });
  it("size=sm 与 tone=danger 落 class,className 透传", () => {
    render(<Button size="sm" tone="danger" className="extra">删除</Button>);
    const button = screen.getByRole("button", { name: "删除" });
    expect(button.className).toContain("ui-button--sm");
    expect(button.className).toContain("ui-button--danger");
    expect(button.className).toContain("extra");
  });
  it("icon 变体没有 aria-label 就抛(不许出现没名字的图标按钮)", () => {
    expect(() => render(<Button variant="icon" icon="x" />)).toThrow(/aria-label/);
  });
  it("busy 时 aria-busy 且禁用,不再触发 onClick", () => {
    let clicks = 0;
    render(<Button busy onClick={() => { clicks += 1; }}>生成</Button>);
    const button = screen.getByRole("button", { name: "生成" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    button.click();
    expect(clicks).toBe(0);
  });
  it("带 icon 时图标在文字前且 aria-hidden", () => {
    render(<Button icon="import">导入素材</Button>);
    const button = screen.getByRole("button", { name: "导入素材" });
    expect(button.firstElementChild!.tagName).toBe("svg");
    expect(button.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});
