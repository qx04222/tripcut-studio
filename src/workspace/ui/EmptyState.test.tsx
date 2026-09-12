// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("标题是 p 不是 heading,图标 32px,action 原样渲染", () => {
    render(<EmptyState icon="import" title="还没有素材" body="导入一批素材后会出现在这里。" action={<button>导入素材</button>} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("还没有素材").tagName).toBe("P");
    expect(document.querySelector("svg")!.getAttribute("width")).toBe("32");
    expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
  });
  it("size / tone 落 class,默认 pane/light", () => {
    const { container, rerender } = render(<EmptyState icon="search" title="没有匹配" />);
    expect(container.firstElementChild!.className).toContain("ui-empty--pane");
    expect(container.firstElementChild!.className).toContain("ui-empty--light");
    rerender(<EmptyState icon="search" title="没有匹配" size="inline" tone="dark" />);
    expect(container.firstElementChild!.className).toContain("ui-empty--inline");
    expect(container.firstElementChild!.className).toContain("ui-empty--dark");
  });
  it("没有 body / action 时不留空节点", () => {
    const { container } = render(<EmptyState icon="search" title="没有匹配" />);
    expect(container.querySelector(".ui-empty-body")).toBeNull();
    expect(container.querySelector(".ui-empty-action")).toBeNull();
  });
});
