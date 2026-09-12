// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 整份 api 替身由 `./testApiMock` 从 `src/api.ts` 的真实导出表生成 —— 不再手抄
// 名单,加一条新命令不用改这里(见 testApiMock.ts 顶部)。
const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { EpisodeSummary, ExportStatus, PlatformPreset } from "../api";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

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
  target_platform: "xiaohongshu",
  canvas_orientation: "portrait",
};

const platformPresets: PlatformPreset[] = [
  {
    platform: "xiaohongshu",
    display_name: "小红书",
    portrait: [1080, 1440],
    landscape: [1920, 1080],
    duration_budget_ticks: 90_000_000,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
];

const idleStatus: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 4,
  selected_segment_count: 3,
  selected_whole_count: 1,
  total_duration_seconds: 185,
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

beforeEach(() => {
  // 只清调用记录,实现保留:上一条用例点过「生成交付包」后 startExport 的调用不能漏到下一条。
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue(platformPresets);
  apiMock.getJianyingAvailability.mockResolvedValue({
    installed_version: null,
    supported: false,
    reason: "未检测到剪映",
  });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.pickExportFolder.mockResolvedValue(null);
  apiMock.startExport.mockResolvedValue(idleStatus);
});
afterEach(cleanup);

async function openDeliverDrawer(): Promise<void> {
  await act(async () => {
    const button = screen.getByRole("button", { name: "生成交付包" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
}

describe("交付抽屉", () => {
  it("点「生成交付包」从右侧滑入,抽屉内有「本次交付平台」(冒烟 drawer.deliver.platform)", async () => {
    render(<WorkspaceShell />);
    await openDeliverDrawer();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(await screen.findByText("本次交付平台")).toBeTruthy();
  });

  it("Esc 关闭交付抽屉(真机冒烟 sheet.settings.* 连环失败的第一嫌疑)", async () => {
    // R8 收尾轮真机冒烟:交付抽屉打开后按 Esc 没关,而它是 `aria-modal="true"`,
    // 于是顶栏整个从 AX 树里消失,后面找「设置」的每一步都点不中 —— 三条
    // sheet.settings.* 连环 FAIL。这条用例把"抽屉该不该响应 Esc"钉在代码层面。
    render(<WorkspaceShell />);
    await openDeliverDrawer();
    await screen.findByRole("dialog", { name: "生成交付包" });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "生成交付包" })).toBeNull();
  });

  it("抽屉有一个可见的「关闭」按钮 —— Esc 不能是唯一出口", async () => {
    // 真机实测(R8 收尾轮):交付抽屉打开后按 Esc 没关,而抽屉是 aria-modal,
    // 顶栏整个从 AX 树里消失 —— 键盘那条路一断,用户和探针都出不去了。
    // 抽屉/sheet 以前**一个可见的关闭控件都没有**,遮罩也不可点。
    render(<WorkspaceShell />);
    await openDeliverDrawer();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    const close = within(dialog).getByRole("button", { name: "关闭" });
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "生成交付包" })).toBeNull();
  });

  it("点抽屉外的遮罩也能关", async () => {
    render(<WorkspaceShell />);
    await openDeliverDrawer();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    const overlay = dialog.parentElement;
    expect(overlay).not.toBeNull();
    await act(async () => {
      fireEvent.mouseDown(overlay!);
      fireEvent.click(overlay!);
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "生成交付包" })).toBeNull();
  });

  it("抽屉内有「联系表」(冒烟 drawer.deliver.contact,硬断言)", async () => {
    render(<WorkspaceShell />);
    await openDeliverDrawer();
    await screen.findByRole("dialog", { name: "生成交付包" });
    expect((await screen.findAllByText(/联系表/)).length).toBeGreaterThan(0);
  });
});

describe("交付抽屉原生内容(R9 Task 6b)", () => {
  async function openDialog(): Promise<HTMLElement> {
    render(<WorkspaceShell />);
    await openDeliverDrawer();
    return screen.findByRole("dialog", { name: "生成交付包" });
  }

  it("不再包装旧 DeliverPage:没有英文 kicker", async () => {
    const dialog = await openDialog();
    await within(dialog).findByRole("combobox", { name: "本次交付平台" });
    expect(dialog.textContent).not.toMatch(/DELIVERY ITEMS|ESTIMATED|STABLE PACKAGE|NATIVE DRAFT/);
    expect(dialog.querySelector(".deliver-panel")).toBeNull();
  });

  it("表单四行:本次交付平台 Select、参考粗剪时长 Select、联系表.pdf switch、剪映草稿 switch(不支持时禁用并显示原因)", async () => {
    const dialog = await openDialog();
    const platform = (await within(dialog).findByRole("combobox", { name: "本次交付平台" })) as HTMLSelectElement;
    expect(platform.tagName).toBe("SELECT");
    await waitFor(() => expect(platform.value).toBe("xiaohongshu"));
    expect(within(dialog).getByRole("combobox", { name: "参考粗剪时长" })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "联系表.pdf" }).getAttribute("aria-checked")).toBe("true");
    const jianying = within(dialog).getByRole("switch", { name: "剪映草稿" });
    await waitFor(() => expect((jianying as HTMLButtonElement).disabled).toBe(true));
    expect(within(dialog).getByText("未检测")).toBeTruthy();
  });

  it("参考粗剪时长按本集平台预算预选(小红书 90s → 60 秒)", async () => {
    const dialog = await openDialog();
    const target = (await within(dialog).findByRole("combobox", { name: "参考粗剪时长" })) as HTMLSelectElement;
    await waitFor(() => expect(target.value).toBe("60"));
    expect([...target.options].map((option) => option.textContent)).toEqual(["完整", "30 秒", "60 秒", "3 分钟"]);
  });

  it("交付项汇总是一行", async () => {
    const dialog = await openDialog();
    expect(await within(dialog).findByText("4 项 · 3 段精选片段 · 1 条整条收藏 · 预计 3:05")).toBeTruthy();
  });

  it("主按钮「生成交付包」primary;点它选目录并 startExport", async () => {
    apiMock.pickExportFolder.mockResolvedValue("/Volumes/DELIVERY");
    const dialog = await openDialog();
    const button = within(dialog).getByRole("button", { name: "生成交付包" });
    expect(button.className).toContain("ui-button--primary");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.startExport).toHaveBeenCalled());
  });

  it("剪映草稿开关打开时,主按钮走 generateJianyingDraft(不先 startExport)", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({
      installed_version: "11.4.0",
      supported: true,
      reason: "已检测到剪映专业版 11.4",
    });
    apiMock.generateJianyingDraft.mockResolvedValue({
      status: "created",
      output_path: "/Users/me/JianyingPro Drafts/EP05",
      draft_name: "EP05",
      jianying_version: "11.4.0",
      selected_count: 4,
      subtitle_count: 0,
      message: "草稿已生成并通过回读自检",
    });
    const dialog = await openDialog();
    const jianying = within(dialog).getByRole("switch", { name: "剪映草稿" });
    await waitFor(() => expect((jianying as HTMLButtonElement).disabled).toBe(false));
    expect(within(dialog).getByText("已检测到剪映专业版 11.4")).toBeTruthy();
    await act(async () => {
      jianying.click();
      await Promise.resolve();
    });
    expect(jianying.getAttribute("aria-checked")).toBe("true");
    const button = within(dialog).getByRole("button", { name: "生成交付包" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.generateJianyingDraft).toHaveBeenCalled());
    expect(apiMock.startExport).not.toHaveBeenCalled();
    expect(await within(dialog).findByText("剪映草稿已生成")).toBeTruthy();
    expect(within(dialog).getByText("EP05")).toBeTruthy();
  });

  it("剪映 11.4.13169 待人工核对:开关禁用,拒绝原因原样透出", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({
      installed_version: "11.4.13169",
      supported: false,
      reason: "剪映 11.4.13169 尚未人工核对,暂不生成原生草稿",
    });
    const dialog = await openDialog();
    expect(await within(dialog).findByText("剪映 11.4.13169 尚未人工核对,暂不生成原生草稿")).toBeTruthy();
    expect((within(dialog).getByRole("switch", { name: "剪映草稿" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("进行中显示进度卡:阶段名 + progressbar + 每项状态 Badge + 取消", async () => {
    apiMock.getExportStatus.mockResolvedValue({
      ...idleStatus,
      job_id: 9,
      status: "running",
      stage: "remuxing",
      completed_items: 1,
      failed_items: 1,
      items: [
        { clip_id: 1, file_name: "A.MP4", output_name: "001_A.MP4", status: "done", note: null, warning: false },
        { clip_id: 2, file_name: "B.MP4", output_name: "002_B.MP4", status: "failed", note: "解码失败", warning: false },
      ],
    });
    const dialog = await openDialog();
    expect(await within(dialog).findByText("整理精选片段")).toBeTruthy();
    expect(within(dialog).getByRole("progressbar")).toBeTruthy();
    expect(within(dialog).getByText("失败").closest(".ui-badge")!.className).toContain("ui-badge--danger");
    expect(within(dialog).getByText("解码失败")).toBeTruthy();
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await act(async () => {
      cancel.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.cancelExport).toHaveBeenCalledWith(9));
  });

  it("完成后结果卡:交付完成 + 路径 + 「打开文件夹」调 revealExport", async () => {
    apiMock.getExportStatus.mockResolvedValue({
      ...idleStatus,
      job_id: 9,
      status: "done",
      stage: "complete",
      output_path: "/Volumes/DELIVERY/EP05",
    });
    const dialog = await openDialog();
    expect(await within(dialog).findByText("交付完成")).toBeTruthy();
    expect(within(dialog).getByText("/Volumes/DELIVERY/EP05")).toBeTruthy();
    await act(async () => {
      within(dialog).getByRole("button", { name: "打开文件夹" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.revealExport).toHaveBeenCalledWith(9));
  });

  it("失败后结果卡:交付失败 + 错误原文(role=alert)", async () => {
    apiMock.getExportStatus.mockResolvedValue({
      ...idleStatus,
      job_id: 9,
      status: "failed",
      stage: "failed",
      error: "目标卷已拔出",
    });
    const dialog = await openDialog();
    expect(await within(dialog).findByText("交付失败")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain("目标卷已拔出");
  });

  it("没有交付项时主按钮禁用,状态行说明去哪里保存精选", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, selected_count: 0, selected_segment_count: 0, selected_whole_count: 0 });
    const dialog = await openDialog();
    expect(await within(dialog).findByText(/还没有交付项/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "生成交付包" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("「交付包里有什么」是折叠段,默认收起,没有 01/02/03 水印", async () => {
    const dialog = await openDialog();
    const details = dialog.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("交付包里有什么");
    expect(dialog.querySelector(".deliver-part-index")).toBeNull();
    expect(dialog.querySelector(".deliver-content-card span")).toBeNull();
  });
});
