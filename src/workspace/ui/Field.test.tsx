// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "./Field";

afterEach(cleanup);

describe("Field", () => {
  it("label 通过 htmlFor 关联控件,help 在下", () => {
    render(<Field label="本次交付平台" htmlFor="platform" help="不改本集设置"><select id="platform" /></Field>);
    expect(screen.getByLabelText("本次交付平台")).toBeTruthy();
    expect(screen.getByText("不改本集设置").className).toContain("ui-field-help");
  });
  it("默认行式,inline=false 落 stacked class", () => {
    const { container, rerender } = render(<Field label="a" htmlFor="x"><input id="x" /></Field>);
    expect(container.firstElementChild!.className).toContain("ui-field--inline");
    rerender(<Field label="a" htmlFor="x" inline={false}><input id="x" /></Field>);
    expect(container.firstElementChild!.className).toContain("ui-field--stacked");
  });
  it("没有 htmlFor 时标签是 span 不是 label(不留悬空 label)", () => {
    const { container } = render(<Field label="一组开关"><button>x</button></Field>);
    expect(container.querySelector("label")).toBeNull();
    expect(container.querySelector(".ui-field-label")!.tagName).toBe("SPAN");
  });
});
