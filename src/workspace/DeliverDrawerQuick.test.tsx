import { DELIVER_DRAWER_TITLE } from "./copy";
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
import { __resetExportModeForTests, openDeliverAs } from "./deliver/exportModeRequest";
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
  __resetExportModeForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "未检测到剪映" });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getSettings.mockResolvedValue({});
  apiMock.planQuickExport.mockResolvedValue(plan);
  apiMock.quickExport.mockResolvedValue({ ...plan, job_id: 42 });
  apiMock.pickExportFolder.mockResolvedValue(null);
  apiMock.pickQuickExportFolder.mockResolvedValue(null);
});
afterEach(cleanup);

/**
 * 开抽屉并切到「导出片段」。R14 §9 B 起剪映不可用时抽屉默认落在「剪映素材包」(那套用例在
 * DeliverDrawerKit.test.tsx),本文件测的是快速导出,所以先点 chip 过去。
 */
async function openDrawer(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "导出" });
  // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它。
  await act(async () => {
    within(dialog).getByRole("button", { name: "更多方式" }).click();
    await Promise.resolve();
  });
  await act(async () => {
    within(dialog).getByRole("button", { name: "导出片段" }).click();
    await Promise.resolve();
  });
  return dialog;
}

async function click(name: string, root: HTMLElement): Promise<void> {
  await act(async () => {
    within(root).getByRole("button", { name }).click();
    await Promise.resolve();
  });
}

describe("交付抽屉 · 快速导出(R11 车道 E)", () => {
  it("「导出片段」模式:没有平台 / 粗剪 / 联系表,只有清单和「导出」;切「完整交付包」才出现旧表单", async () => {
    const dialog = await openDrawer();
    const quickChip = within(dialog).getByRole("button", { name: "导出片段" });
    expect(quickChip.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).queryByText("本次交付平台")).toBeNull();
    expect(within(dialog).queryByRole("switch", { name: "联系表.pdf" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "开始生成" })).toBeNull();
    expect(await within(dialog).findByText("001_IMG_0001.mp4")).toBeTruthy();
    // Y-08:还没记过文件夹时按钮(可见文字与 AX 名)都是「导出…」,记过之后才叫「导出到上次文件夹」。
    expect(within(dialog).getByRole("button", { name: "导出…" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "导出到上次文件夹" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "更改文件夹" })).toBeTruthy();
    // 文案不带内部术语。
    expect(dialog.textContent).not.toMatch(/remux|H\.264|tick|VFR/i);

    await click("完整交付包", dialog);
    expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "开始生成" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "导出…" })).toBeNull();
  });

  it("第一次导出:没记过文件夹 → 弹一次文件夹面板(标题「选择导出文件夹」,不是交付包那句)→ quickExport(该目录) → 记进 ui.export.last_dir", async () => {
    apiMock.pickQuickExportFolder.mockResolvedValue("/Users/me/Movies");
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    await click("导出…", dialog);
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Movies", null));
    // Y-08:快速导出走自己的文件夹面板(「选择导出文件夹」),交付包的「选择交付包保存位置」不动。
    expect(apiMock.pickQuickExportFolder).toHaveBeenCalledTimes(1);
    expect(apiMock.pickExportFolder).not.toHaveBeenCalled();
    // 记住之后按钮改叫「导出到上次文件夹」。
    expect(await within(dialog).findByRole("button", { name: "导出到上次文件夹" })).toBeTruthy();
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
    expect(apiMock.pickQuickExportFolder).not.toHaveBeenCalled();
  });

  it("上次文件夹用不了(dest_unavailable)→ 回落到保存面板,用新目录重试并记住", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Volumes/Gone" });
    apiMock.quickExport
      .mockRejectedValueOnce(new Error("export failed: dest_unavailable: 上次的文件夹现在用不了（/Volumes/Gone）：文件夹不存在"))
      .mockResolvedValueOnce({ ...plan, job_id: 43 });
    apiMock.pickQuickExportFolder.mockResolvedValue("/Users/me/Movies");
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
    apiMock.pickQuickExportFolder.mockResolvedValue("/Users/me/Movies");
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
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    await waitFor(() => expect(apiMock.planQuickExport).toHaveBeenCalledWith("/Users/me/Desktop", { segment_ids: [7] }));
    expect(await within(dialog).findByText(/只导出你选的 1 项/)).toBeTruthy();
    await click("导出到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Desktop", { segment_ids: [7] }));
  });

  it("还没有片段:空态一句话说清现在怎么办,主按钮禁用", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 0, selected_segment_count: 0, selected_whole_count: 0 });
    apiMock.planQuickExport.mockRejectedValue(new Error("当前没有精选段或收藏素材"));
    const dialog = await openDrawer();
    expect(await within(dialog).findByText("第 ② 步还没做:先挑几段")).toBeTruthy(); // R12 §1:空态按当前步说话
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "导出…" }) as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("R12 §6:导出步(车道 A)", () => {
  it("顶部「第 4 步 · 导出」一句;四枚 chip:剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包;剪映不可用时默认素材包、草稿 chip 可见文案带「(待验证)」+ 一句白话", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    expect(within(dialog).getByText("第 4 步 · 导出")).toBeTruthy();
    // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它。
    await act(async () => {
      within(dialog).getByRole("button", { name: "更多方式" }).click();
      await Promise.resolve();
    });
    const group = within(dialog).getByRole("group", { name: "导出方式" });
    // R13 §5 → R14 §9 B:四模式顺序「剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包」;剪映不可用时默认落在素材包。
    expect(within(group).getAllByRole("button").map((chip) => chip.getAttribute("aria-label"))).toEqual(["剪映草稿", "剪映素材包", "导出片段", "完整交付包"]);
    await waitFor(() => expect(within(group).getByRole("button", { name: "剪映素材包" }).getAttribute("aria-pressed")).toBe("true"));
    await click("导出片段", dialog);
    expect(within(group).getByRole("button", { name: "导出片段" }).getAttribute("aria-pressed")).toBe("true");
    const jianying = within(group).getByRole("button", { name: "剪映草稿" });
    expect(jianying.textContent).toBe("剪映草稿(待验证)");
    await click("剪映草稿", dialog);
    expect(within(dialog).getByText(/没检测到剪映/)).toBeTruthy();
    // 剪映模式 = 完整交付包表单 + 草稿强制;不可用时主按钮仍是「开始生成」(走稳定包)。
    expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "开始生成" })).toBeTruthy();
  });

  it("剪映可用:chip 不带「(待验证)」,且默认就落在剪映模式(R13 §5),剪映草稿开关为开", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4", supported: true, reason: "已检测到剪映专业版 11.4" });
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它。
    await act(async () => {
      within(dialog).getByRole("button", { name: "更多方式" }).click();
      await Promise.resolve();
    });
    const jianying = await within(dialog).findByRole("button", { name: "剪映草稿" });
    await waitFor(() => expect(jianying.textContent).toBe("剪映草稿"));
    await waitFor(() => expect(jianying.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect((within(dialog).getByRole("switch", { name: "剪映草稿" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true"));
  });

  it("R13 §5:镜头带「导入剪映继续剪」开的抽屉,剪映不可用也直接落在剪映模式(白话原因 + 降级说明就在眼前)", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      openDeliverAs("jianying");
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: DELIVER_DRAWER_TITLE });
    const jianying = within(dialog).getByRole("button", { name: "剪映草稿" });
    expect(jianying.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByText(/没检测到剪映/)).toBeTruthy();
  });

  it("R13 §5:「导出所选…」进来的抽屉即使剪映可用也停在导出片段(所选清单在那一页)", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4", supported: true, reason: "" });
    render(<WorkspaceShell />);
    await act(async () => {
      requestQuickExport({ clip_ids: [1] });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: DELIVER_DRAWER_TITLE });
    await within(dialog).findByText("001_IMG_0001.mp4");
    expect(within(dialog).getByRole("button", { name: "导出片段" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("「也顺便…」勾联系表:切到完整交付包且联系表开关打开", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.deliver.contact_sheet": "false" });
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    const contact = within(dialog).getByRole("checkbox", { name: /联系表 PDF/ });
    expect((contact as HTMLInputElement).checked).toBe(false);
    await act(async () => {
      contact.click();
      await Promise.resolve();
    });
    expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "完整交付包" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(within(dialog).getByRole("switch", { name: "联系表.pdf" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("有失败项:「只重试失败的」按失败的素材 id 重发 quick_export(同一文件夹)", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Movies" });
    apiMock.getExportStatus.mockResolvedValue({
      ...doneStatus,
      status: "failed",
      stage: "failed",
      completed_items: 2,
      failed_items: 1,
      error: "有一条没导出来",
      items: [
        { clip_id: 1, file_name: "a.mp4", output_name: "a.mp4", status: "done", note: null, warning: false },
        { clip_id: 7, file_name: "b.mp4", output_name: "b.mp4", status: "failed", note: "文件被占用", warning: true },
      ],
    });
    const dialog = await openDrawer();
    const retry = await within(dialog).findByRole("button", { name: "只重试失败的" });
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    // Z-11:带上上一次作业 id,后端据此写回同一个文件夹、沿用原编号。
    await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Movies", { clip_ids: [7], retry_of_job_id: doneStatus.job_id }));
  });

  it("导出完成广播 tripcut:export-done(流水线第 ④ 步当场打勾)", async () => {
    apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Movies" });
    apiMock.quickExport.mockResolvedValue({ ...plan, job_id: 42 });
    const heard = vi.fn();
    window.addEventListener("tripcut:export-done", heard);
    const dialog = await openDrawer();
    await within(dialog).findByText("001_IMG_0001.mp4");
    apiMock.getExportStatus.mockResolvedValue(doneStatus);
    await click("导出到上次文件夹", dialog);
    await waitFor(() => expect(heard).toHaveBeenCalled());
    window.removeEventListener("tripcut:export-done", heard);
  });
});
