// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { EpisodeSummary, ExportStatus, QuickExportOutcome } from "../api";
import { __resetQuickExportForTests, requestQuickExport } from "./deliver/quickExportModel";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

const episode: EpisodeSummary = {
  id: 5,
  title: "EP05",
  theme: "",
  episode_number: 5,
  status: "active",
  created_at: "2026-09-01T00:00:00Z",
  archived_at: null,
  clip_count: 4,
  favorite_count: 2,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};

const idleStatus: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 3,
  selected_segment_count: 2,
  selected_whole_count: 1,
  total_duration_seconds: 65,
  completed_items: 0,
  failed_items: 0,
  items: [],
  output_path: null,
  error: null,
  contact_sheet_glyph_fallbacks: null,
  contact_sheet_cover_failures: null,
  rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null,
  rough_cut_actual_tb_num: null,
  rough_cut_actual_tb_den: null,
};

const doneStatus: ExportStatus = {
  ...idleStatus,
  job_id: 42,
  status: "done",
  stage: "complete",
  completed_items: 3,
  output_path: "/Users/me/Desktop/EP05_导出_2026-09-13",
  mode: "quick",
  items: [],
};

const plan: QuickExportOutcome = {
  job_id: null,
  dir: "/Users/me/Desktop/EP05_导出_2026-09-13",
  files: ["001_IMG_0001.mp4", "002_IMG_0001.mp4", "003_IMG_0002.mp4"],
  skipped: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "未检测到剪映" });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getSettings.mockResolvedValue({});
  apiMock.planQuickExport.mockResolvedValue(plan);
  apiMock.quickExport.mockResolvedValue({ ...plan, job_id: 42 });
  apiMock.pickExportFolder.mockResolvedValue(null);
});
afterEach(cleanup);

async function openDrawer(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    await Promise.resolve();
  });
  return screen.findByRole("dialog", { name: "生成交付包" });
}

async function click(name: string, root: HTMLElement): Promise<void> {
  await act(async () => {
    within(root).getByRole("button", { name }).click();
    await Promise.resolve();
  });
}

describe("交付抽屉 · 快速导出(R11 车道 E)", () => {
  it("默认是「快速导出」:没有平台 / 粗剪 / 联系表,只有清单和「导出」;切「完整交付包」才出现旧表单", async () => {
    const dialog = await openDrawer();
    const quickChip = within(dialog).getByRole("button", { name: "快速导出" });
    expect(quickChip.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).queryByText("本次交付平台")).toBeNull();
    expect(within(dialog).queryByRole("switch", { name: "联系表.pdf" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "开始生成" })).toBeNull();
    expect(await within(dialog).findByText("001_IMG_0001.mp4")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "导出到上次文件夹" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "更改文件夹" })).toBeTruthy();
    // 文案不带内部术语。
    expect(dialog.textContent).not.toMatch(/remux|H\.264|tick|VFR/i);

    await click("完整交付包", dialog);
    expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "开始生成" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "导出到上次文件夹" })).toBeNull();
  });

  it("第一次导出:没记过文件夹 → 弹一次文件夹面板 → quickExport(该目录) → 记进 ui.export.last_dir", async () => {
    apiMock.pickExportFolder.mockResolvedValue("/Users/me/Movies");
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    await click("导出到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Movies", null));
    expect(apiMock.pickExportFolder).toHaveBeenCalledTimes(1);
    expect(apiMock.setSetting).toHaveBeenCalledWith("ui.export.last_dir", "/Users/me/Movies");
    expect(apiMock.startExport).not.toHaveBeenCalled();
  });

  it("记过文件夹:直接导到上次文件夹,不弹面板;引导句写着文件夹名", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
    const dialog = await openDrawer();
    expect(await within(dialog).findByText(/会导出到「Desktop」/)).toBeTruthy();
    await click("导出到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Desktop", null));
    expect(apiMock.pickExportFolder).not.toHaveBeenCalled();
  });

  it("上次文件夹用不了(dest_unavailable)→ 回落到保存面板,用新目录重试并记住", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Volumes/Gone" });
    apiMock.quickExport
      .mockRejectedValueOnce(new Error("export failed: dest_unavailable: 上次的文件夹现在用不了（/Volumes/Gone）：文件夹不存在"))
      .mockResolvedValueOnce({ ...plan, job_id: 43 });
    apiMock.pickExportFolder.mockResolvedValue("/Users/me/Movies");
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    await click("导出到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledTimes(2));
    expect(apiMock.quickExport).toHaveBeenLastCalledWith("/Users/me/Movies", null);
    expect(apiMock.setSetting).toHaveBeenCalledWith("ui.export.last_dir", "/Users/me/Movies");
  });

  it("目录不可用且用户取消面板 → 一句话告诉他怎么办,不静默", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Volumes/Gone" });
    apiMock.quickExport.mockRejectedValueOnce(new Error("export failed: dest_unavailable: 文件夹不存在"));
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    await click("导出到上次文件夹", dialog);
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("更改文件夹"));
    expect(apiMock.setSetting).not.toHaveBeenCalledWith("ui.export.last_dir", expect.anything());
  });

  it("完成后 toast「已导出 3 个文件」+「在 Finder 中显示」→ revealExport(job)", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
    apiMock.getExportStatus.mockImplementation(async (jobId: number | null) => (jobId === 42 ? doneStatus : idleStatus));
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    await click("导出到上次文件夹", dialog);
    const toast = await within(dialog).findByText("已导出 3 个文件");
    expect(toast).toBeTruthy();
    await click("在 Finder 中显示", dialog);
    expect(apiMock.revealExport).toHaveBeenCalledWith(42);
  });

  it("「更改文件夹…」只换记住的文件夹,不导出", async () => {
    apiMock.pickExportFolder.mockResolvedValue("/Users/me/Movies");
    const dialog = await openDrawer();
    await click("更改文件夹", dialog);
    await waitFor(() => expect(apiMock.setSetting).toHaveBeenCalledWith("ui.export.last_dir", "/Users/me/Movies"));
    expect(apiMock.quickExport).not.toHaveBeenCalled();
    expect(await within(dialog).findByText(/会导出到「Movies」/)).toBeTruthy();
  });

  it("「导出所选…」入口:requestQuickExport 打开抽屉,清单与导出都只带这些段", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
    apiMock.planQuickExport.mockResolvedValue({ ...plan, files: ["001_IMG_0001.mp4"] });
    render(<WorkspaceShell />);
    await act(async () => {
      requestQuickExport({ segment_ids: [7] });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    await waitFor(() => expect(apiMock.planQuickExport).toHaveBeenCalledWith("/Users/me/Desktop", { segment_ids: [7] }));
    expect(await within(dialog).findByText(/只导出你选的 1 项/)).toBeTruthy();
    await click("导出到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Desktop", { segment_ids: [7] }));
  });

  it("还没有片段:空态一句话说清现在怎么办,主按钮禁用", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 0, selected_segment_count: 0, selected_whole_count: 0 });
    apiMock.planQuickExport.mockRejectedValue(new Error("当前没有精选段或收藏素材"));
    const dialog = await openDrawer();
    expect(await within(dialog).findByText("还没有可导出的片段")).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "导出到上次文件夹" }) as HTMLButtonElement).disabled).toBe(true));
  });
});
