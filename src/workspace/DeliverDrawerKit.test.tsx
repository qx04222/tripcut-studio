// R14 车道 B(§9 B):交付抽屉的「剪映素材包」模式 —— 剪映不可用时永远走得通的交接路。
// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { EpisodeSummary, ExportStatus, KitExportOutcome } from "../api";
import { JIANYING_BUNDLE_ID } from "../api";
import { __resetExportModeForTests, openDeliverAs } from "./deliver/exportModeRequest";
import { EXPORT_MODES_R14, KIT_LEAD_LINE, defaultExportMode, isKitDone, kitDoneLine, kitFolderLine } from "./deliver/kitExportModel";
import { __resetQuickExportForTests } from "./deliver/quickExportModel";
import { __resetToastsForTests } from "./ui/toastStore";
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
  output_path: "/Users/me/Desktop/EP05_剪映素材包_2026-09-14",
  mode: "kit",
};

const plan: KitExportOutcome = {
  job_id: null,
  dir: "/Users/me/Desktop/EP05_剪映素材包_2026-09-14",
  files: ["01_海边_IMG_0003.mp4", "02_海边_IMG_0002.mp4", "03_山里_IMG_0001.mp4"],
  order_file: "顺序.txt",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
  __resetExportModeForTests();
  __resetToastsForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4.13189", supported: false, reason: "这个版本还没人工核对过" });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
  apiMock.planJianyingKit.mockResolvedValue(plan);
  apiMock.exportJianyingKit.mockResolvedValue({ ...plan, job_id: 42 });
  apiMock.planQuickExport.mockResolvedValue({ job_id: null, dir: "", files: ["001_x.mp4"], skipped: [] });
  apiMock.pickExportFolder.mockResolvedValue(null);
  apiMock.openApp.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function openDrawer(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "导出" });
  // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它。
  const more = await within(dialog).findByRole("button", { name: "更多方式" });
  await act(async () => {
    more.click();
    await Promise.resolve();
  });
  return dialog;
}

async function click(name: string, root: HTMLElement | typeof screen): Promise<void> {
  await act(async () => {
    (root === screen ? screen : within(root as HTMLElement)).getByRole("button", { name }).click();
    await Promise.resolve();
  });
}

describe("kitExportModel 纯函数", () => {
  it("四枚 chip 顺序:剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包;默认:可用 → 草稿,不可用 → 素材包,未知 → null", () => {
    expect(EXPORT_MODES_R14).toEqual(["jianying", "kit", "quick", "full"]);
    expect(defaultExportMode(null)).toBeNull();
    expect(defaultExportMode({ installed_version: "11.3.0", supported: true, reason: "" })).toBe("jianying");
    expect(defaultExportMode({ installed_version: "11.4.13189", supported: false, reason: "" })).toBe("kit");
  });

  it("文案:完成一句「已导出 n 个片段」(有失败补一句);页脚「导出到 <文件夹>」;isKitDone 只认本次 kit 作业", () => {
    expect(kitDoneLine(doneStatus)).toBe("已导出 3 个片段");
    expect(kitDoneLine({ ...doneStatus, failed_items: 1 })).toBe("已导出 3 个片段 · 1 个没导出来");
    expect(kitFolderLine("/Users/me/Desktop")).toBe("导出到 Desktop");
    expect(kitFolderLine(null)).toMatch(/第一次导出/);
    expect(isKitDone(doneStatus, 42)).toBe(true);
    expect(isKitDone({ ...doneStatus, mode: "quick" }, 42)).toBe(false);
    expect(isKitDone(doneStatus, 41)).toBe(false);
  });
});

describe("交付抽屉 · 剪映素材包(R14 §9 B)", () => {
  it("剪映不可用:四枚 chip 按顺序,默认落在「剪映素材包」;面板一句话 + 编号清单 + 页脚「导出到 Desktop」;主按钮 AX 名固定", async () => {
    const dialog = await openDrawer();
    const group = within(dialog).getByRole("group", { name: "导出方式" });
    expect(within(group).getAllByRole("button").map((chip) => chip.getAttribute("aria-label"))).toEqual(["剪映草稿", "剪映素材包", "导出片段", "完整交付包"]);
    await waitFor(() => expect(within(group).getByRole("button", { name: "剪映素材包" }).getAttribute("aria-pressed")).toBe("true"));
    expect(within(dialog).getByText(KIT_LEAD_LINE)).toBeTruthy();
    const list = await within(dialog).findByRole("list", { name: "将导出的文件" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(plan.files);
    expect(within(dialog).getByText("导出到 Desktop")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "导出剪映素材包到上次文件夹" }).textContent).toBe("导出素材包");
    expect(within(dialog).getByRole("button", { name: "更改文件夹" })).toBeTruthy();
    expect(within(dialog).queryByText("本次交付平台")).toBeNull();
    expect(dialog.textContent).not.toMatch(/remux|H\.264|tick|VFR/i);
  });

  it("剪映可用:chip 顺序不变,默认仍是「剪映草稿」;点「剪映素材包」也能切过去", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.3.0", supported: true, reason: "" });
    const dialog = await openDrawer();
    const group = within(dialog).getByRole("group", { name: "导出方式" });
    expect(within(group).getAllByRole("button").map((chip) => chip.getAttribute("aria-label"))).toEqual(["剪映草稿", "剪映素材包", "导出片段", "完整交付包"]);
    await waitFor(() => expect(within(group).getByRole("button", { name: "剪映草稿" }).getAttribute("aria-pressed")).toBe("true"));
    await click("剪映素材包", dialog);
    expect(await within(dialog).findByText(KIT_LEAD_LINE)).toBeTruthy();
  });

  it("V14-03 待验证版本:切到「剪映草稿」后顶行一句话「先导出素材包,或试着生成」,不再说「先用完整交付包」", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({
      installed_version: "11.4.13189", supported: false, usable: false, whitelisted: false, human_check: "none", force_allowed: true,
      reason: "这个剪映版本(11.4.13189)还没核对过;可以试着生成一份草稿,再到剪映里看能不能打开",
    });
    const dialog = await openDrawer();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "剪映草稿" }).textContent).toContain("待验证"));
    await click("剪映草稿", dialog);
    const hint = within(dialog).getAllByRole("status").find((node) => node.classList.contains("deliver-mode-hint"))!;
    expect(hint.textContent).toBe("这个剪映版本(11.4.13189)还没核对过草稿格式。可以先导出素材包,或试着生成一份草稿在剪映里打开看看。");
    expect(dialog.textContent).not.toContain("完整交付包」,草稿功能验证后开放");
  });

  it("镜头带按钮 openDeliverAs(\"kit\") 开的抽屉直接落在素材包模式(可用性还没回来也不等)", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      openDeliverAs("kit");
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    expect(within(dialog).getByRole("button", { name: "剪映素材包" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("导出:记过文件夹 → exportJianyingKit(该目录);完成 → toast「已导出 3 个片段」+「打开剪映」→ openApp(剪映);结果卡三步", async () => {
    apiMock.getExportStatus.mockImplementation(async (jobId: number | null) => (jobId === 42 ? doneStatus : idleStatus));
    const dialog = await openDrawer();
    await within(dialog).findByRole("list", { name: "将导出的文件" });
    await click("导出剪映素材包到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.exportJianyingKit).toHaveBeenCalledWith("/Users/me/Desktop"));
    expect(apiMock.pickExportFolder).not.toHaveBeenCalled();
    expect(apiMock.quickExport).not.toHaveBeenCalled();
    const toast = await screen.findByText("已导出 3 个片段", { selector: ".ui-toast-text" });
    const host = toast.closest(".ui-toast") as HTMLElement;
    await click("打开剪映", host);
    expect(apiMock.openApp).toHaveBeenCalledWith(JIANYING_BUNDLE_ID);
    // J-07:素材包不是原生项目,「打开剪映」顺手把所在文件夹也带出来(不用再去 Finder 摸)。
    expect(apiMock.revealExport).toHaveBeenCalledWith(42);
    // 结果卡:三步 + 「打开剪映」+「在 Finder 中显示」。
    const steps = within(dialog).getByRole("list", { name: "接下来在剪映里" });
    const lines = within(steps).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/新建.*草稿/);
    expect(lines[1]).toMatch(/全选.*拖进时间线/);
    expect(lines[2]).toMatch(/顺序.*镜头带/);
    expect(within(dialog).getByRole("button", { name: "打开剪映" })).toBeTruthy();
    await click("在 Finder 中显示", dialog);
    expect(apiMock.revealExport).toHaveBeenCalledWith(42);
  });

  it("第一次导出:没记过文件夹 → 弹一次面板 → exportJianyingKit(该目录) → 记进 ui.export.last_dir", async () => {
    apiMock.getSettings.mockResolvedValue({});
    apiMock.pickExportFolder.mockResolvedValue("/Users/me/Movies");
    const dialog = await openDrawer();
    await within(dialog).findByRole("list", { name: "将导出的文件" });
    expect(within(dialog).getByRole("button", { name: "导出剪映素材包到上次文件夹" }).textContent).toBe("导出素材包…");
    await click("导出剪映素材包到上次文件夹", dialog);
    await waitFor(() => expect(apiMock.exportJianyingKit).toHaveBeenCalledWith("/Users/me/Movies"));
    expect(apiMock.pickExportFolder).toHaveBeenCalledTimes(1);
    expect(apiMock.setSetting).toHaveBeenCalledWith("ui.export.last_dir", "/Users/me/Movies");
  });

  it("镜头带上还没有片段:空态一句话说清现在怎么办,主按钮禁用", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 0, selected_segment_count: 0, selected_whole_count: 0 });
    apiMock.planJianyingKit.mockRejectedValue(new Error("镜头带上还没有镜头"));
    const dialog = await openDrawer();
    expect(await within(dialog).findByText("镜头带上还没有片段")).toBeTruthy();
    expect(within(dialog).getByText(/一键排入/)).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "导出剪映素材包到上次文件夹" }) as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("R19 §6 交付:点「交给剪映」一次即出素材包", () => {
  async function openCards(): Promise<HTMLElement> {
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    return await screen.findByRole("dialog", { name: "导出" });
  }

  it("剪映版本未核对 + 记过文件夹:点卡即 exportJianyingKit(上次目录),不弹面板、不用再点第二颗按钮", async () => {
    apiMock.getExportStatus.mockImplementation(async (jobId: number | null) => (jobId === 42 ? doneStatus : idleStatus));
    const dialog = await openCards();
    await click("交给剪映", dialog);
    await waitFor(() => expect(apiMock.exportJianyingKit).toHaveBeenCalledWith("/Users/me/Desktop"));
    expect(apiMock.exportJianyingKit).toHaveBeenCalledTimes(1);
    expect(apiMock.pickExportFolder).not.toHaveBeenCalled();
    expect(await screen.findByText("已导出 3 个片段", { selector: ".ui-toast-text" })).toBeTruthy();
  });

  it("没记过文件夹:点卡只落到素材包详情页(主按钮「导出素材包…」),不自己弹面板", async () => {
    apiMock.getSettings.mockResolvedValue({});
    const dialog = await openCards();
    await click("交给剪映", dialog);
    await within(dialog).findByRole("list", { name: "将导出的文件" });
    expect(within(dialog).getByRole("button", { name: "导出剪映素材包到上次文件夹" }).textContent).toBe("导出素材包…");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(apiMock.exportJianyingKit).not.toHaveBeenCalled();
    expect(apiMock.pickExportFolder).not.toHaveBeenCalled();
  });

  it("「更多方式」再点「剪映素材包」chip 进来的不自动导(只有那张卡是一次即出)", async () => {
    const dialog = await openDrawer();
    await within(dialog).findByRole("list", { name: "将导出的文件" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(apiMock.exportJianyingKit).not.toHaveBeenCalled();
  });
});
