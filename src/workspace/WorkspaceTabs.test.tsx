// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../api", () => ({ setSetting: vi.fn(async () => undefined) }));
import { WorkspaceTabs } from "./WorkspaceTabs";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
beforeEach(() => __resetWorkspaceForTests());
afterEach(cleanup);
it("同一集显示视频/照片两个 tab，切换会清掉旧工作台选择", () => {
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 9 }, multiSelection: [9], anchorClipId: 9 });
  render(<WorkspaceTabs />);
  expect(screen.getByRole("tablist", { name: "工作台" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "视频工作台" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "照片工作台" }));
  expect(getWorkspaceSnapshot().workspaceMode).toBe("photo");
  expect(getWorkspaceSnapshot().selection).toBeNull();
});
it("⌘⇧1 / ⌘⇧2 直接切工作台", () => {
  render(<WorkspaceTabs />);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", key: "2", metaKey: true, shiftKey: true, bubbles: true })));
  expect(getWorkspaceSnapshot().workspaceMode).toBe("photo");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "1", metaKey: true, shiftKey: true, bubbles: true })));
  expect(getWorkspaceSnapshot().workspaceMode).toBe("video");
});
