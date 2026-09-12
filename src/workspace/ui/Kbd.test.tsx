// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Kbd } from "./Kbd";

afterEach(cleanup);

describe("Kbd", () => {
  it("渲染 <kbd>", () => {
    render(<Kbd>⌘K</Kbd>);
    expect(document.querySelector("kbd")!.textContent).toBe("⌘K");
  });
  it("带 ui-kbd class", () => {
    render(<Kbd>/</Kbd>);
    expect(document.querySelector("kbd")!.className).toContain("ui-kbd");
  });
});
