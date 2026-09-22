// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BandEmptyGuide } from "./BandEmptyGuide";
it("gives the favorite-to-arrange instruction with a secondary action", () => {
  const arrange = vi.fn();
  render(<BandEmptyGuide disabled={false} busy={false} arrange={arrange} />);
  expect(screen.getByText("按 F 收藏几条,再点一键排入")).toBeTruthy();
  const button = screen.getByRole("button", { name: "一键排入" });
  expect(button.className).toContain("secondary");
  fireEvent.click(button); expect(arrange).toHaveBeenCalledOnce();
});
