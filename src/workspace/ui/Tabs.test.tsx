// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs";

afterEach(cleanup);

const ITEMS = [{ id: "source", label: "来源" }, { id: "jobs", label: "任务", count: 3 }, { id: "missing", label: "缺失素材", count: 2 }];

describe("Tabs", () => {
  it("tablist/tab 角色齐全,tab 的 AX 名不含计数", () => {
    render(<Tabs ariaLabel="导入分页" value="jobs" onChange={() => {}} items={ITEMS} />);
    expect(screen.getByRole("tablist", { name: "导入分页" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "任务" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "缺失素材" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "来源" }).getAttribute("aria-selected")).toBe("false");
  });
  it("点击触发 onChange;选中的 tab 在 tab 序,其它 tabIndex=-1(roving)", () => {
    const onChange = vi.fn();
    render(<Tabs ariaLabel="x" value="source" onChange={onChange} items={ITEMS} />);
    screen.getByRole("tab", { name: "任务" }).click();
    expect(onChange).toHaveBeenCalledWith("jobs");
    expect(screen.getByRole("tab", { name: "来源" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "任务" }).tabIndex).toBe(-1);
  });
  it("← → 在 tab 间移动并触发 onChange(roving)", () => {
    const onChange = vi.fn();
    render(<Tabs ariaLabel="x" value="a" onChange={onChange} items={[{ id: "a", label: "甲" }, { id: "b", label: "乙" }]} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "甲" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("b");
    fireEvent.keyDown(screen.getByRole("tab", { name: "甲" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(screen.getByRole("tab", { name: "甲" }), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("b");
  });
});
