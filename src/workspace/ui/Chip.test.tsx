// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chip } from "./Chip";

afterEach(cleanup);

describe("Chip", () => {
  it("有 onClick 时是 button 且 aria-pressed 跟 selected", () => {
    render(<Chip selected count={60} onClick={() => {}}>全部</Chip>);
    const chip = screen.getByRole("button", { name: "全部 60" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.className).toContain("ui-chip--selected");
  });
  it("没有 onClick 时是静态 span,不进 tab 序", () => {
    render(<Chip>只读</Chip>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("只读").closest("span")!.className).toContain("ui-chip");
  });
  it("tone 与 icon 落 class / svg,点击触发", () => {
    const onClick = vi.fn();
    const { container } = render(<Chip tone="warn" icon="warning" onClick={onClick}>缺口</Chip>);
    expect(container.querySelector("svg")).not.toBeNull();
    const chip = screen.getByRole("button", { name: "缺口" });
    expect(chip.className).toContain("ui-chip--warn");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    chip.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
