// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SectionHeader } from "./SectionHeader";

afterEach(cleanup);

describe("SectionHeader", () => {
  it("size=section 是 h3,size=pane 不是 heading(栏 landmark 已有名字)", () => {
    const { rerender } = render(<SectionHeader title="本次交付" />);
    expect(screen.getByRole("heading", { level: 3, name: "本次交付" })).toBeTruthy();
    rerender(<SectionHeader size="pane" title="媒体池" meta="51 / 60 条" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("51 / 60 条")).toBeTruthy();
  });
  it("actions 渲染在右侧,description 在标题下", () => {
    const { container } = render(
      <SectionHeader title="内容清单" description="按平台默认勾选" actions={<button>全选</button>} />,
    );
    expect(screen.getByRole("button", { name: "全选" })).toBeTruthy();
    expect(container.querySelector(".ui-section-header-actions")).not.toBeNull();
    expect(screen.getByText("按平台默认勾选").className).toContain("ui-section-header-description");
  });
  it("size 落 class", () => {
    const { container } = render(<SectionHeader size="pane" title="x" />);
    expect(container.firstElementChild!.className).toContain("ui-section-header--pane");
  });
});
