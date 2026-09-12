// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Select } from "./Select";

afterEach(cleanup);

describe("Select", () => {
  it("是原生 select,外套 chevron-down", () => {
    render(<Select aria-label="平台"><option>通用</option></Select>);
    expect(screen.getByRole("combobox", { name: "平台" }).tagName).toBe("SELECT");
    expect(document.querySelector("svg")).not.toBeNull();
  });
  it("className 落在外套上,disabled 透传到 select", () => {
    const { container } = render(<Select aria-label="平台" className="extra" disabled><option>通用</option></Select>);
    expect(container.firstElementChild!.className).toContain("ui-select");
    expect(container.firstElementChild!.className).toContain("extra");
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  });
});
