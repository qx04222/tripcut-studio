// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

afterEach(cleanup);

describe("Toggle", () => {
  it("是 role=switch,aria-checked 跟 checked,点击翻转", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="联系表.pdf" />);
    const sw = screen.getByRole("switch", { name: "联系表.pdf" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.tagName).toBe("BUTTON");
    sw.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it("checked 时 class 落 on,点击传 false", () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="x" id="t1" />);
    const sw = screen.getByRole("switch");
    expect(sw.className).toContain("ui-toggle--on");
    expect(sw.id).toBe("t1");
    sw.click();
    expect(onChange).toHaveBeenCalledWith(false);
  });
  it("disabled 时不触发", () => {
    const onChange = vi.fn();
    render(<Toggle checked disabled onChange={onChange} label="剪映草稿" />);
    screen.getByRole("switch").click();
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
