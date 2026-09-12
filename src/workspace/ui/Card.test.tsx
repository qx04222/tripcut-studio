// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "./Card";

afterEach(cleanup);

describe("Card", () => {
  it("interactive + selected 落 class,as=button 时是真按钮", () => {
    render(<Card as="button" interactive selected aria-label="卡">x</Card>);
    const card = screen.getByRole("button", { name: "卡" });
    expect(card.className).toContain("ui-card--interactive");
    expect(card.className).toContain("ui-card--selected");
    expect(card.getAttribute("type")).toBe("button");
  });
  it("level=raised 用浮层阴影 class", () => {
    const { container } = render(<Card level="raised">x</Card>);
    expect(container.firstElementChild!.className).toContain("ui-card--raised");
  });
  it("默认 div / level=card / padding 3;padding=4 落 class;className 透传", () => {
    const { container, rerender } = render(<Card className="extra">x</Card>);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("ui-card--card");
    expect(el.className).toContain("ui-card--pad-3");
    expect(el.className).toContain("extra");
    rerender(<Card padding={4}>x</Card>);
    expect(container.firstElementChild!.className).toContain("ui-card--pad-4");
  });
});

it("as=button 时 disabled 透传,div 时不落到 DOM", () => {
  const { container, unmount } = render(<Card as="button" disabled>禁</Card>);
  expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  unmount();
  const { container: div } = render(<Card disabled>无</Card>);
  expect(div.firstElementChild?.hasAttribute("disabled")).toBe(false);
});
