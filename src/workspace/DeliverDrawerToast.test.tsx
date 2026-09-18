// @vitest-environment jsdom
// R12 §3(车道 B):导出结束走全局 Toast ——「6 个导好了,3 个没导出来 · 只重试这 3 个」,重试用 quick_export 的 clip_ids 选择。
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { EpisodeSummary, ExportItemStatus, ExportStatus, QuickExportOutcome } from "../api";
import { __resetQuickExportForTests } from "./deliver/quickExportModel";
import { exportDoneToast, failedClipIds } from "./deliver/quickExportModel";
import { __resetToastsForTests } from "./ui/toastStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

const episode: EpisodeSummary = {
  id: 5, title: "EP05", theme: "", episode_number: 5, status: "active", created_at: "2026-09-01T00:00:00Z", archived_at: null,
  clip_count: 9, favorite_count: 9, export_count: 0, target_platform: "general", canvas_orientation: "landscape",
};

const item = (clip_id: number, status: ExportItemStatus["status"], note: string | null = null): ExportItemStatus => ({
  clip_id, file_name: `IMG_${clip_id}.MP4`, output_name: `00${clip_id}_IMG_${clip_id}.mp4`, status, note, warning: false,
});

const idleStatus: ExportStatus = {
  job_id: null, status: "idle", stage: "idle", selected_count: 9, selected_segment_count: 9, selected_whole_count: 0,
  total_duration_seconds: 65, completed_items: 0, failed_items: 0, items: [], output_path: null, error: null,
  contact_sheet_glyph_fallbacks: null, contact_sheet_cover_failures: null, rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null, rough_cut_actual_tb_num: null, rough_cut_actual_tb_den: null,
};

const partialStatus: ExportStatus = {
  ...idleStatus, job_id: 42, status: "done", stage: "complete", completed_items: 6, failed_items: 3, mode: "quick",
  output_path: "/Users/me/Desktop/EP05_导出", 
  items: [1, 2, 3, 4, 5, 6].map((id) => item(id, "done")).concat([item(7, "failed", "文件已损坏"), item(8, "failed"), item(9, "failed")]),
};

const plan: QuickExportOutcome = { job_id: null, dir: "/Users/me/Desktop/EP05_导出", files: ["001_IMG_1.mp4"], skipped: [] };

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
  __resetToastsForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "未检测到剪映" });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
  apiMock.planQuickExport.mockResolvedValue(plan);
  apiMock.quickExport.mockResolvedValue({ ...plan, job_id: 42 });
  apiMock.pickExportFolder.mockResolvedValue(null);
});
afterEach(cleanup);

describe("导出结束的 Toast", () => {
  it("文案:全成功 / 部分失败带第一条人话原因;失败素材 id 去重", () => {
    expect(exportDoneToast({ ...partialStatus, failed_items: 0, items: [] })).toBe("6 个导好了");
    expect(exportDoneToast(partialStatus)).toBe("6 个导好了,3 个没导出来(文件已损坏)");
    expect(failedClipIds({ ...partialStatus, items: [...partialStatus.items, item(7, "failed")] })).toEqual([7, 8, 9]);
  });

  it("部分失败 → 顶部 toast「6 个导好了,3 个没导出来」+「只重试这 3 个」→ quickExport(lastDir, { clip_ids })", async () => {
    apiMock.getExportStatus.mockImplementation(async (jobId: number | null) => (jobId === 42 ? partialStatus : idleStatus));
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    // R19 U-06/P-04:首屏三卡,点「导出视频文件」直接落在快速导出模式。
    await act(async () => {
      within(dialog).getByRole("button", { name: "导出视频文件" }).click();
      await Promise.resolve();
    });
    await within(dialog).findByText("001_IMG_1.mp4");
    await act(async () => {
      within(dialog).getByRole("button", { name: "导出到上次文件夹" }).click();
      await Promise.resolve();
    });
    const toast = await screen.findByText(/6 个导好了,3 个没导出来/);
    const host = toast.closest(".ui-toast") as HTMLElement;
    expect(host.getAttribute("role")).toBe("status");
    apiMock.quickExport.mockResolvedValue({ ...plan, job_id: 43 });
    await act(async () => {
      within(host).getByRole("button", { name: "只重试这 3 个" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenLastCalledWith("/Users/me/Desktop", { clip_ids: [7, 8, 9] }));
    expect(screen.queryByText(/6 个导好了,3 个没导出来/)).toBeNull();
  });

  it("整体失败 → 一句人话「导出没成功:原因。再试一次」", async () => {
    apiMock.getExportStatus.mockImplementation(async (jobId: number | null) =>
      jobId === 42 ? { ...idleStatus, job_id: 42, status: "failed", stage: "failed", error: "磁盘已满" } : idleStatus,
    );
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    // R19 U-06/P-04:首屏三卡,点「导出视频文件」直接落在快速导出模式。
    await act(async () => {
      within(dialog).getByRole("button", { name: "导出视频文件" }).click();
      await Promise.resolve();
    });
    await within(dialog).findByText("001_IMG_1.mp4");
    await act(async () => {
      within(dialog).getByRole("button", { name: "导出到上次文件夹" }).click();
      await Promise.resolve();
    });
    const toast = await screen.findByText("导出没成功:磁盘已满。再试一次");
    expect(toast.closest(".ui-toast")!.className).toContain("ui-toast--danger");
  });
});
