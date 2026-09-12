// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toolbar } from "./Toolbar";

afterEach(cleanup);

describe("Toolbar", () => {
  it("给了 ariaLabel 才是 role=toolbar", () => {
    const { rerender } = render(<Toolbar ariaLabel="走带"><button>a</button></Toolbar>);
    expect(screen.getByRole("toolbar", { name: "走带" })).toBeTruthy();
    rerender(<Toolbar><button>a</button></Toolbar>);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
  it("Divider 是 aria-hidden 的分隔", () => {
    const { container } = render(<Toolbar><Toolbar.Divider /></Toolbar>);
    expect(container.querySelector(".ui-toolbar-divider")!.getAttribute("aria-hidden")).toBe("true");
  });
  it("Spacer 撑开,dense 与 className 落 class", () => {
    const { container } = render(<Toolbar dense className="extra"><Toolbar.Spacer /></Toolbar>);
    const bar = container.firstElementChild!;
    expect(bar.className).toContain("ui-toolbar--dense");
    expect(bar.className).toContain("extra");
    expect(container.querySelector(".ui-toolbar-spacer")).not.toBeNull();
  });
});
