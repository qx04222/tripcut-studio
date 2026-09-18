// @vitest-environment jsdom
// R16 车道 A:设置页各行 —— P2-5 整集重算、P2-8 导出文件夹「清除」、P2-11 重置新手引导、P2-12 恢复默认布局、P2-13 复制诊断信息。
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { SETTINGS_ACTIONS } from "./copy";
import { LAYOUT_RESET_EVENT, PANE_LAYOUT_KEYS } from "./layoutReset";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

async function openTab(name: string): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    const button = screen.getByRole("button", { name: "设置" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("设置已从本地项目载入"));
  await act(async () => {
    within(dialog).getByRole("tab", { name }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  __resetWorkspaceForTests();
  __resetToastsForTests();
  vi.clearAllMocks();
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
  apiMocks.setFirstRunDone.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("P2-8 / P2-12 播放与导出", () => {
  it("记过导出文件夹才出「清除」,点了写 ui.export.last_dir = \"\";没记过不出", async () => {
    apiMocks.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/x/Movies/导出" });
    const panel = await openTab("播放与导出");
    const clear = within(panel).getByRole("button", { name: "清除导出文件夹" });
    expect(clear.textContent).toBe(SETTINGS_ACTIONS.clearExportDir);
    await act(async () => {
      fireEvent.click(clear);
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.export.last_dir", "");
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "清除导出文件夹" })).toBeNull());
  });

  it("「恢复默认布局」写 ui.pane.* 五个默认值、store 回默认、折叠的栏展开、壳收到重挂事件", async () => {
    const panel = await openTab("播放与导出");
    act(() => {
      dispatchWorkspace({ type: "set-pane-size", pane: "pool", value: 400 });
      dispatchWorkspace({ type: "set-inspector-pinned", pinned: true });
    });
    expect(getWorkspaceSnapshot().poolWidth).toBe(400);
    expect(getWorkspaceSnapshot().inspectorPinned).toBe(true);
    apiMocks.setSetting.mockClear();
    const seen: string[] = [];
    window.addEventListener(LAYOUT_RESET_EVENT, () => seen.push("reset"), { once: true });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: SETTINGS_ACTIONS.resetLayout }));
    });
    await waitFor(() => expect(seen).toEqual(["reset"]));
    const written = apiMocks.setSetting.mock.calls.map(([key]) => key);
    for (const key of PANE_LAYOUT_KEYS) expect(written).toContain(key);
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.pane.pool_width", "320");
    expect(getWorkspaceSnapshot().poolWidth).toBe(320);
    expect(getWorkspaceSnapshot().inspectorPinned).toBe(false);
    await settle();
    expect(getToastSnapshot()?.text).toBe("已恢复默认布局");
  });
});

