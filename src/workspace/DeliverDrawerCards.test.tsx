// R19 车道 deliver(U-06/P-04,规格 §3 deliver 行、§7 Q-6 已拍板三卡;J-10)。
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
import { HANDOFF_DOWNGRADE_LINE, HANDOFF_KIT_TOAST } from "./deliver/deliverCards";
import { __resetExportModeForTests } from "./deliver/exportModeRequest";
import { __resetQuickExportForTests } from "./deliver/quickExportModel";
import { __resetToastsForTests } from "./ui/toastStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";
import { __resetPhotoOrderPersistenceForTests, savePhotoOrder } from "./photoOrderSettings";

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

const plan: KitExportOutcome = {
  job_id: null,
  dir: "/Users/me/Desktop/EP05_剪映素材包_2026-09-14",
  files: ["01_海边_IMG_0003.mp4"],
  order_file: "顺序.txt",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
  __resetExportModeForTests();
  __resetToastsForTests();
  __resetPhotoOrderPersistenceForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
  apiMock.planJianyingKit.mockResolvedValue(plan);
  apiMock.planQuickExport.mockResolvedValue({ job_id: null, dir: "", files: ["001_x.mp4"], skipped: [] });
  apiMock.pickExportFolder.mockResolvedValue(null);
});
afterEach(cleanup);

async function openDrawer(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    await Promise.resolve();
  });
  return screen.findByRole("dialog", { name: "导出" });
}

describe("交付抽屉首屏三卡(U-06/P-04)", () => {
  it("首屏恰好三张卡:交给剪映 / 导出视频文件 / 整包交付,外加「更多方式」", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "未检测到剪映" });
    const dialog = await openDrawer();
    const group = within(dialog).getByRole("group", { name: "交付方式" });
    const cards = within(group).getAllByRole("button").filter((button) => button.getAttribute("aria-label") !== "更多方式");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["交给剪映", "导出视频文件", "整包交付"]);
    expect(within(dialog).getByRole("button", { name: "更多方式" })).toBeTruthy();
    // 既有四模式 chip 选择器这时不在首屏。
    expect(within(dialog).queryByRole("group", { name: "导出方式" })).toBeNull();
  });

  it("J-10:剪映不可用时首屏补一行灰字,说明「交给剪映」实际会落在哪条路", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4.13189", supported: false, reason: "这个版本还没人工核对过" });
    const dialog = await openDrawer();
    await waitFor(() => expect(within(dialog).getByText(HANDOFF_DOWNGRADE_LINE)).toBeTruthy());
  });

  it("剪映可用时不显示 J-10 灰字", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.3.0", supported: true, reason: "" });
    const dialog = await openDrawer();
    await within(dialog).findByRole("group", { name: "交付方式" });
    expect(within(dialog).queryByText(HANDOFF_DOWNGRADE_LINE)).toBeNull();
  });

  it("未核对版本机器上点「交给剪映」一次直接落素材包 + toast「顺序 = 编号」,无需再选", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4.13189", supported: false, reason: "这个版本还没人工核对过" });
    const dialog = await openDrawer();
    await act(async () => {
      within(dialog).getByRole("button", { name: "交给剪映" }).click();
      await Promise.resolve();
    });
    await within(dialog).findByRole("list", { name: "将导出的文件" });
    expect(await screen.findByText(HANDOFF_KIT_TOAST)).toBeTruthy();
  });

  it("剪映可用时点「交给剪映」落在剪映草稿(完整交付包表单 + 草稿强制),不弹 toast", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.3.0", supported: true, reason: "" });
    const dialog = await openDrawer();
    await act(async () => {
      within(dialog).getByRole("button", { name: "交给剪映" }).click();
      await Promise.resolve();
    });
    expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
    expect(screen.queryByText(HANDOFF_KIT_TOAST)).toBeNull();
  });

  it("点「导出视频文件」直接落在快速导出清单", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "" });
    const dialog = await openDrawer();
    await act(async () => {
      within(dialog).getByRole("button", { name: "导出视频文件" }).click();
      await Promise.resolve();
    });
    expect(within(dialog).queryByText("本次交付平台")).toBeNull();
    expect(await within(dialog).findByText("001_x.mp4")).toBeTruthy();
  });

  it("点「整包交付」直接落在完整交付包表单", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "" });
    const dialog = await openDrawer();
    await act(async () => {
      within(dialog).getByRole("button", { name: "整包交付" }).click();
      await Promise.resolve();
    });
    expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
  });

  it("「更多方式」展开后是既有四模式 chip 选择器,冻结 AX 名不变", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "" });
    const dialog = await openDrawer();
    await act(async () => {
      within(dialog).getByRole("button", { name: "更多方式" }).click();
      await Promise.resolve();
    });
    const group = within(dialog).getByRole("group", { name: "导出方式" });
    expect(within(group).getAllByRole("button").map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "剪映草稿",
      "剪映素材包",
      "导出片段",
      "完整交付包",
    ]);
  });
});

// R21 照片线(业主拍板:照片不套视频那一套):视频交付抽屉不再感知照片;照片工作台的抽屉只有「导出精选照片」。
it("视频交付三卡不再提照片,「交给剪映」照旧落素材包 / 草稿", async () => {
  apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 8, selected_photo_count: 5 });
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.3.0", supported: true, reason: "" });
  const dialog = await openDrawer();
  await waitFor(() => {
    for (const name of ["交给剪映", "导出视频文件", "整包交付"]) {
      expect(within(dialog).getByRole("button", { name }).textContent).not.toContain("照片");
    }
  });
  await act(async () => { within(dialog).getByRole("button", { name: "整包交付" }).click(); });
  expect(await within(dialog).findByText("本次交付平台")).toBeTruthy();
  expect(within(dialog).queryByText(/含伴随文件/)).toBeNull();
  expect(within(dialog).queryByText(/照片不计时长预算/)).toBeNull();
  expect((within(dialog).getByRole("switch", { name: "剪映草稿" }) as HTMLButtonElement).disabled).toBe(false);
});

it("混合选择的快速导出仍规划并执行视频，不再出现照片阻止", async () => {
  apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 8, selected_photo_count: 5 });
  apiMock.quickExport.mockResolvedValue({ job_id: 71, dir: "/Users/me/Desktop", files: ["001_x.mp4"], skipped: [] });
  const dialog = await openDrawer();
  await act(async () => { within(dialog).getByRole("button", { name: "导出视频文件" }).click(); });
  expect(await within(dialog).findByText("001_x.mp4")).toBeTruthy();
  expect(within(dialog).queryByText(/photo_not_supported|本集含 5 张照片/)).toBeNull();
  const exportButton = within(dialog).getByRole("button", { name: "导出到上次文件夹" });
  expect((exportButton as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { exportButton.click(); });
  await waitFor(() => expect(apiMock.quickExport).toHaveBeenCalledWith("/Users/me/Desktop", null));
});

describe("照片工作台的导出抽屉(R21 照片线)", () => {
  const photoPlan: KitExportOutcome = { job_id: null, dir: "/Users/me/Desktop/EP05_精选照片_2026-09-20", files: ["01_one.jpg", "02_two.jpg"], order_file: "顺序.txt" };
  async function openPhotoDrawer(): Promise<HTMLElement> {
    apiMock.planSelectedPhotos.mockResolvedValue(photoPlan);
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    return screen.findByRole("dialog", { name: "导出" });
  }

  it("三张视频交付卡不渲染,只有「导出精选照片」+ 编号清单", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 2, selected_segment_count: 0, selected_whole_count: 0, selected_photo_count: 2 });
    const dialog = await openPhotoDrawer();
    expect(await within(dialog).findByText("01_one.jpg")).toBeTruthy();
    for (const name of ["交给剪映", "导出视频文件", "整包交付", "更多方式"]) {
      expect(within(dialog).queryByRole("button", { name })).toBeNull();
    }
    expect(within(dialog).queryByRole("group", { name: "交付方式" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "导出方式" })).toBeNull();
    expect(within(dialog).getByRole("region", { name: "导出精选照片" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/剪映|镜头带|章节|交付|素材包|整包|粗剪|镜头表/);
  });

  it("导出精选照片:等精选带顺序落库后才启动;保存失败显示错误且不按旧顺序导出", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 2, selected_segment_count: 0, selected_whole_count: 0, selected_photo_count: 2 });
    apiMock.exportSelectedPhotos.mockResolvedValue({ ...photoPlan, job_id: 9 });
    const dialog = await openPhotoDrawer();
    await within(dialog).findByText("01_one.jpg");
    let finishSave: () => void = () => undefined;
    apiMock.setSetting.mockImplementation((key: string) => key === "ui.photo.order.5"
      ? new Promise<void>((resolve) => { finishSave = resolve; })
      : Promise.resolve());
    const pendingSave = savePhotoOrder("ui.photo.order.5", [2, 1]);
    await waitFor(() => expect(apiMock.setSetting).toHaveBeenCalledWith("ui.photo.order.5", "[2,1]"));
    const button = within(dialog).getByRole("button", { name: "导出精选照片到上次文件夹" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(apiMock.exportSelectedPhotos).not.toHaveBeenCalled();
    await act(async () => { finishSave(); await pendingSave; });
    await waitFor(() => expect(apiMock.exportSelectedPhotos).toHaveBeenCalledWith("/Users/me/Desktop"));
  });

  it("导出精选照片:顺序保存失败 → 显示错误,不启动后端", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 2, selected_segment_count: 0, selected_whole_count: 0, selected_photo_count: 2 });
    let rejectSave: (failure: Error) => void = () => undefined;
    apiMock.setSetting.mockImplementation((key: string) => key === "ui.photo.order.5"
      ? new Promise<void>((_resolve, reject) => { rejectSave = reject; })
      : Promise.resolve());
    const pendingSave = savePhotoOrder("ui.photo.order.5", [2, 1]);
    await waitFor(() => expect(apiMock.setSetting).toHaveBeenCalledWith("ui.photo.order.5", "[2,1]"));
    const dialog = await openPhotoDrawer();
    await within(dialog).findByText("01_one.jpg");
    const button = within(dialog).getByRole("button", { name: "导出精选照片到上次文件夹" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { button.click(); await Promise.resolve(); });
    await act(async () => { rejectSave(new Error("disk full")); await pendingSave.catch(() => undefined); });
    expect(await within(dialog).findByText(/照片顺序未保存/)).toBeTruthy();
    expect(apiMock.exportSelectedPhotos).not.toHaveBeenCalled();
  });
});

it("零素材整包首屏与详情明确暂无交付项且保持禁用", async () => {
  apiMock.getExportStatus.mockResolvedValue({
    ...idleStatus,
    selected_count: 0,
    selected_segment_count: 0,
    selected_whole_count: 0,
    selected_photo_count: 0,
  });
  const dialog = await openDrawer();
  const fullCard = within(dialog).getByRole("button", { name: "整包交付" });
  expect(fullCard.textContent).toContain("暂无交付项 · 请先挑选素材");
  expect(fullCard.textContent).not.toContain("照片 + 镜头表 + 说明");

  await act(async () => { fullCard.click(); });

  expect(await within(dialog).findByText("当前没有已选视频，本次暂无交付项")).toBeTruthy();
  expect(within(dialog).getByText("暂无交付项 · 请先挑选素材")).toBeTruthy();
  expect(within(dialog).queryByText("当前只选了照片，本次不生成参考粗剪")).toBeNull();
  expect((within(dialog).getByRole("button", { name: "开始生成" }) as HTMLButtonElement).disabled).toBe(true);
});
