// @vitest-environment jsdom
// R19 U-05:库空时导入抽屉只一颗按钮;关注文件夹 / 自动同步 / 立即扫描要有关注文件夹才出;任务 / 缺失素材分页计数 >0 才显示。
import { act } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({
    getCurrentEpisode: vi.fn(async () => ({ id: 1, title: "EP01", theme: "通用" })),
    getClipsRevision: vi.fn(async () => "rev-0"),
    pickImportFolder: vi.fn(async () => null),
  });
});
vi.mock("../api", () => apiMocks);
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

const PROGRESS_EMPTY = { total: 0, done: 0, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false };

beforeEach(() => {
  __resetWorkspaceForTests();
  apiMocks.listWatchedFolders.mockResolvedValue([]);
  apiMocks.listImportBatches.mockResolvedValue([]);
  apiMocks.listMissingClips.mockResolvedValue([]);
  apiMocks.getImportProgress.mockResolvedValue(PROGRESS_EMPTY as never);
});
afterEach(cleanup);

async function openImportDrawer(): Promise<HTMLElement> {
  await act(async () => {
    dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "导入素材" });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return dialog;
}

describe("R19 U-05:首次导入只一颗按钮", () => {
  it("库空首开:抽屉里 button ≤ 3,唯一的动作按钮是「选择文件夹」;没有 添加素材文件夹 / 立即扫描 / 自动同步 / 已关注的文件夹;只有「来源」一个分页", async () => {
    render(<WorkspaceShell />);
    const dialog = await openImportDrawer();
    const buttons = within(dialog).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(buttons.length).toBeLessThanOrEqual(3);
    expect(within(dialog).getByRole("button", { name: "选择文件夹" })).toBeTruthy();
    for (const name of ["添加素材文件夹", "立即扫描", "移除"]) expect(within(dialog).queryByRole("button", { name })).toBeNull();
    expect(within(dialog).queryByRole("switch", { name: "自动同步" })).toBeNull();
    expect(within(dialog).queryByText("已关注的文件夹")).toBeNull();
    expect(within(dialog).queryByText("还没有关注的文件夹")).toBeNull();
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["来源"]);
  });

  it("有关注文件夹后:「添加素材文件夹」「立即扫描」「自动同步」回来", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([{ id: 1, path: "/Volumes/TRIP", auto_sync: false, added_at: "", last_scan_at: null } as never]);
    render(<WorkspaceShell />);
    const dialog = await openImportDrawer();
    await within(dialog).findByLabelText("/Volumes/TRIP");
    expect(within(dialog).getByRole("button", { name: "添加素材文件夹" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "立即扫描" })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "自动同步" })).toBeTruthy();
  });

  it("任务 / 缺失素材分页:各自计数 >0 才显示;程序直落某个分页时那个分页照样在", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ ...PROGRESS_EMPTY, total: 12, done: 12 } as never);
    apiMocks.listMissingClips.mockResolvedValue([{ clip_id: 1, file_name: "a.mp4", volume_uuid: "v", volume_label: null, rel_path: "a.mp4", missing_since: "" }]);
    render(<WorkspaceShell />);
    const dialog = await openImportDrawer();
    expect((await within(dialog).findAllByRole("tab")).map((tab) => tab.textContent)).toEqual(["来源", "任务", "缺失素材"]);
    cleanup();

    apiMocks.getImportProgress.mockResolvedValue(PROGRESS_EMPTY as never);
    apiMocks.listMissingClips.mockResolvedValue([]);
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "missing" });
      await Promise.resolve();
    });
    const direct = await screen.findByRole("dialog", { name: "导入素材" });
    expect(within(direct).getByRole("tab", { name: "缺失素材", selected: true })).toBeTruthy();
    expect(within(direct).queryByRole("tab", { name: "任务" })).toBeNull();
  });
});
