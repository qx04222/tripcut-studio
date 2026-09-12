// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 整份 api 替身由 `./testApiMock` 从 `src/api.ts` 的真实导出表生成 —— 不再手抄
// 名单,加一条新命令不用改这里(见 testApiMock.ts 顶部)。
const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  vi.clearAllMocks();
  apiMocks.hasMinimaxKey.mockReset().mockResolvedValue(false);
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

async function openSettingsSheet(): Promise<void> {
  await act(async () => {
    const button = screen.getByRole("button", { name: "设置" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
}

async function pressCommandComma(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    await Promise.resolve();
  });
}

/** 打开 sheet 并等到设置载入(页脚状态行不再是「正在读取」)。 */
async function openLoaded(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await openSettingsSheet();
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("设置已从本地项目载入"));
  return dialog;
}

async function goTab(dialog: HTMLElement, name: string): Promise<HTMLElement> {
  await act(async () => {
    within(dialog).getByRole("tab", { name }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

const SHEET_TABS = ["外观", "性能", "旅行时间", "工具链", "分析与 AI", "云端补镜", "隐私与诊断", "帮助与关于", "缓存与重建"];

describe("设置 sheet", () => {
  it("点「设置」打开 sheet,role=dialog aria-modal,标题「设置」,宽 880 且 Esc 关闭", async () => {
    render(<WorkspaceShell />);
    await openSettingsSheet();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.style.width).toBe("880px");
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("⌘, 打开设置 sheet,九个分区 tab 都在,「隐私与诊断」「云端补镜」在树里", async () => {
    render(<WorkspaceShell />);
    await pressCommandComma();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect((await screen.findAllByText("隐私与诊断")).length).toBeGreaterThan(0);
    expect(screen.getByText("云端补镜")).toBeTruthy();
    const tablist = within(dialog).getByRole("tablist", { name: "设置分区" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.querySelector(".settings-sheet-tab-label")!.textContent)).toEqual(SHEET_TABS);
    for (const label of SHEET_TABS) {
      expect(within(tablist).getByRole("tab", { name: label })).toBeTruthy();
    }
  });

  it("页脚有状态行(role=status),左轨九项中文无 eyebrow,「缓存与重建」在最后且 is-danger;↑↓ 在 tab 间移动", async () => {
    const dialog = await openLoaded();
    expect(within(dialog).getByRole("status").textContent).toMatch(/设置已从本地项目载入|正在读取本地设置/);
    const tablist = within(dialog).getByRole("tablist", { name: "设置分区" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.at(-1)!.textContent).toContain("缓存与重建");
    expect(tabs.at(-1)!.className).toContain("is-danger");
    expect(tablist.textContent).not.toMatch(/APPEARANCE|PERFORMANCE|SETTINGS/);
    expect(dialog.textContent).not.toMatch(/\d\d \/ [A-Z]/);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(tabs[0]!, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(within(tablist).getByRole("tab", { name: "性能" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByRole("heading", { level: 3, name: "性能" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(within(tablist).getByRole("tab", { name: "性能" }), { key: "End" });
      await Promise.resolve();
    });
    expect(within(tablist).getByRole("tab", { name: "缓存与重建" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "关闭设置" })).toBeTruthy();
  });

  it("外观分区:主题三段、缩放四段、界面开关(切回旧界面)", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ "ui.workspace_v2": "true" });
    const dialog = await openLoaded();
    expect(within(dialog).getByRole("heading", { level: 3, name: "外观" })).toBeTruthy();
    for (const label of ["跟随系统", "浅色", "深色", "90%", "100%", "115%", "130%"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeTruthy();
    }
    expect(within(dialog).getByRole("button", { name: "跟随系统" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "切回旧界面" })).toBeTruthy();
    await act(async () => {
      within(dialog).getByRole("button", { name: "深色" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("appearance.theme", "dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    delete document.documentElement.dataset.theme;
  });

  it("性能分区:worker 并发 Select、自动代理 Toggle、内存档位", async () => {
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "性能");
    expect(within(panel).getByRole("combobox", { name: "worker 并发" })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: "内存档位" })).toBeTruthy();
    const proxy = within(panel).getByRole("switch", { name: "自动生成 540p 代理" });
    expect(proxy.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      proxy.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("performance.proxy_enabled", "false"));
  });

  it("旅行时间分区:无设备时是空态文案,有设备时每台一行 + 「应用到此设备」", async () => {
    apiMocks.listDeviceClocks.mockResolvedValueOnce([
      {
        device_model: "DJI Pocket 4",
        clip_count: 12,
        journey_offset_ms: 1_500,
        source: "manual",
        confidence: 0.9,
        needs_review: false,
        timezone_conflicts: 0,
      },
    ]);
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "旅行时间");
    expect(within(panel).getByText("DJI Pocket 4")).toBeTruthy();
    expect(within(panel).getByText(/12 条素材 · 人工校正 · 置信度 90%/)).toBeTruthy();
    const input = within(panel).getByLabelText("DJI Pocket 4 偏移（秒）") as HTMLInputElement;
    expect(input.value).toBe("1.5");
    fireEvent.change(input, { target: { value: "2" } });
    await act(async () => {
      within(panel).getByRole("button", { name: "应用到此设备" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setDeviceClockOffset).toHaveBeenCalledWith("DJI Pocket 4", 2_000));
  });

  it("工具链分区:ffmpeg/ffprobe 读数、路径框失焦即保存、「运行自检」", async () => {
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "工具链");
    expect(await within(panel).findByText(/ffmpeg/)).toBeTruthy();
    expect(within(panel).getByText(/ffprobe/)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /自检/ })).toBeTruthy();
    const input = within(panel).getByLabelText("FFmpeg 路径") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " /opt/ffmpeg " } });
    fireEvent.blur(input);
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("tools.ffmpeg_path", "/opt/ffmpeg"));
    expect(within(panel).getByRole("combobox", { name: "Whisper 模型档位" })).toBeTruthy();
  });

  it("分析与 AI:三条阈值 + 六轴权重 range,provider 未锁定时不许启用 L3", async () => {
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "分析与 AI");
    for (const label of ["场景切分 T", "语义相似度", "抖动阈值", "Technical", "Narrative"]) {
      expect(within(panel).getByRole("slider", { name: label })).toBeTruthy();
    }
    await act(async () => {
      within(panel).getByRole("switch", { name: "启用 L3 增强" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).not.toHaveBeenCalledWith("llm_enabled", "true");
    expect(within(dialog).getByRole("status").textContent).toBe("请先明确锁定一个 LLM provider，再启用 L3 增强");
    expect(within(panel).getByRole("combobox", { name: "Provider" })).toBeTruthy();
    expect(within(panel).getByText("尚无调用记录。provider 缺失或开关关闭不会消耗预算。")).toBeTruthy();
  });

  it("隐私与诊断 / 云端补镜 两个冒烟锚点在 sheet 里", async () => {
    const dialog = await openLoaded();
    const privacy = await goTab(dialog, "隐私与诊断");
    expect(within(privacy).getByRole("heading", { level: 3, name: "隐私与诊断" })).toBeTruthy();
    expect(within(privacy).getByRole("button", { name: "打开日志目录" })).toBeTruthy();
    expect(within(privacy).getByText("始终留在本机，绝不上传")).toBeTruthy();
    const generation = await goTab(dialog, "云端补镜");
    expect(within(generation).getByRole("heading", { level: 3, name: "云端补镜（MiniMax）" })).toBeTruthy();
  });

  it("云端补镜:默认关闭、generated/ 持久提示、从不回显 key,保存后只显示「已配置」(迁自 SettingsPage.test R7 Task 7)", async () => {
    apiMocks.hasMinimaxKey.mockResolvedValueOnce(false).mockResolvedValue(true);
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "云端补镜");
    expect(within(panel).getByRole("switch", { name: "启用云端补镜" }).getAttribute("aria-checked")).toBe("false");
    expect(within(panel).getByText("未配置")).toBeTruthy();
    expect(within(panel).getByText(/生成的片段会存到素材库的 generated\/ 目录，原素材目录不会被写入/)).toBeTruthy();
    expect(within(panel).getByText(/扣费以 MiniMax 平台账单为准/)).toBeTruthy();
    expect(within(panel).getByText("本月尚无生成记录。")).toBeTruthy();
    const input = within(panel).getByLabelText("MiniMax API Key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("粘贴 MiniMax API Key");
    fireEvent.change(input, { target: { value: "sk-test-secret-value" } });
    await act(async () => {
      within(panel).getByRole("button", { name: "保存" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setMinimaxKey).toHaveBeenCalledWith("sk-test-secret-value"));
    expect(await within(panel).findByText("已配置")).toBeTruthy();
    expect(dialog.innerHTML).not.toContain("sk-test-secret-value");
    expect((within(panel).getByLabelText("MiniMax API Key") as HTMLInputElement).value).toBe("");
  });

  it("月度预算输入 900 被夹到 500 并报告", async () => {
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "云端补镜");
    const budget = within(panel).getByLabelText("月度预算（USD）");
    fireEvent.change(budget, { target: { value: "900" } });
    fireEvent.blur(budget);
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("minimax_monthly_budget_usd", "500"));
    expect(within(panel).getByText(/上限 500 美元/)).toBeTruthy();
  });

  it("帮助与关于:「检查更新」按钮 + 常驻状态行;检查前没有安装/重启按钮;版本与许可清单在", async () => {
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "帮助与关于");
    expect(within(panel).getByRole("button", { name: "检查更新" })).toBeTruthy();
    const status = within(panel).getByTestId("updater-status");
    expect(status.getAttribute("data-updater-status")).toBe("idle");
    expect(status.textContent).toBe("尚未检查更新。");
    expect(panel.textContent).toContain("minisign");
    expect(panel.querySelector('[data-updater-action="install"]')).toBeNull();
    expect(panel.querySelector('[data-updater-action="restart"]')).toBeNull();
    expect(within(panel).queryByRole("button", { name: /下载并安装|立即重启/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "打开中文帮助" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "打开安装向导" })).toBeTruthy();
    expect(within(panel).getByText("应用版本")).toBeTruthy();
    expect(within(panel).getByText("开源许可清单")).toBeTruthy();
  });

  it("缓存与重建:两次点击才执行,第一次提示确认;危险动作在独立卡里", async () => {
    const dialog = await openLoaded();
    const panel = await goTab(dialog, "缓存与重建");
    const button = within(panel).getByRole("button", { name: "清空缓存并重建" });
    expect(button.closest(".settings-sheet-danger")).toBeTruthy();
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(apiMocks.clearCacheAndRebuild).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("status").textContent).toContain("请再次点击确认");
    await act(async () => {
      within(panel).getByRole("button", { name: "再次点击确认清空" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.clearCacheAndRebuild).toHaveBeenCalled());
    expect(panel.textContent).toContain("评级、片段和原始素材不会被删除");
  });

  it("sheet 里没有任何英文 kicker / 序号水印(九个分区逐个看)", async () => {
    const dialog = await openLoaded();
    for (const name of SHEET_TABS) {
      await goTab(dialog, name);
      expect(dialog.textContent).not.toMatch(
        /\b(SETTINGS|APPEARANCE|PERFORMANCE|TOOLCHAIN|ANALYSIS|MINIMAX|PRIVACY|DIAGNOSTICS|HELP|ABOUT|CACHE|REBUILD|JOURNEY TIME|OPTIONAL LLM|OPTIONAL CLOUD GENERATION)\b/,
      );
    }
  });
});
