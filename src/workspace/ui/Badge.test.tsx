// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./Badge";

afterEach(cleanup);

describe("Badge", () => {
  it("tone 落 class,icon 可选", () => {
    const { container } = render(<Badge tone="warn" icon="warning">缺口 1</Badge>);
    expect(container.firstElementChild!.className).toContain("ui-badge--warn");
    expect(container.querySelector("svg")).not.toBeNull();
  });
  it("默认 neutral,无 icon 时没有 svg,文字可读", () => {
    const { container } = render(<Badge>2 条候选</Badge>);
    expect(container.firstElementChild!.className).toContain("ui-badge--neutral");
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("2 条候选")).toBeTruthy();
  });
  it("五种 tone 都能渲染", () => {
    for (const tone of ["neutral", "accent", "warn", "danger", "ink"] as const) {
      const { container, unmount } = render(<Badge tone={tone}>x</Badge>);
      expect(container.firstElementChild!.className).toContain(`ui-badge--${tone}`);
      unmount();
    }
  });
});
