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

import { openSettings } from "./openSettings";
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

/**
 * R13 §2:设置页改成剪映式六分区,没有「高级…」折叠。九个旧分区 + 「快捷键」(下面 SECTION_HOME 的搬迁表)
 * 一段不少;测试按「分区 → 段」走到旧分区所在的 `[data-section]` 块,断言原样迁过来。
 */
const SHEET_TABS = ["项目与缓存", "快捷键", "播放与导出", "性能", "工具与模型", "关于"];
const SECTION_HOME = {
  cache: "项目与缓存",
  timeline: "项目与缓存",
  keymap: "快捷键",
  appearance: "播放与导出",
  performance: "性能",
  tools: "工具与模型",
  generation: "工具与模型",
  analysis: "工具与模型",
  about: "关于",
  privacy: "关于",
} as const;

async function goSection(dialog: HTMLElement, id: keyof typeof SECTION_HOME): Promise<HTMLElement> {
  const panel = await goTab(dialog, SECTION_HOME[id]);
  expect(panel.querySelector("details.settings-sheet-advanced")).toBeNull();
  return panel.querySelector<HTMLElement>(`[data-section="${id}"]`)!;
}

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
  // 文件里的第一条要冷启动整棵壳 + 懒加载设置 sheet,全量并行跑时曾超过默认 1 s;只给它 5 s,不改全局。
  }, 5_000);

  it("⌘, 打开设置 sheet,六个分区 tab 都在,「隐私与诊断」「云端补镜」在树里(左轨快捷入口)", async () => {
    render(<WorkspaceShell />);
    await pressCommandComma();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect((await screen.findAllByText("隐私与诊断")).length).toBeGreaterThan(0);
    expect(screen.getByText("云端补镜")).toBeTruthy();
    // 冻结的两个冒烟锚点不再是 tab —— 是左轨底部的两颗按钮,点一下直落对应分区。
    expect(within(dialog).getByRole("button", { name: "隐私与诊断" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "云端补镜" })).toBeTruthy();
    const tablist = within(dialog).getByRole("tablist", { name: "设置分区" });
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.querySelector(".settings-sheet-tab-label")!.textContent)).toEqual(SHEET_TABS);
    for (const label of SHEET_TABS) {
      expect(within(tablist).getByRole("tab", { name: label })).toBeTruthy();
    }
  });

  it("页脚有状态行(role=status),左轨六项中文无 eyebrow;↑↓ Home End 在 tab 间移动;「缓存与重建」在项目与缓存里仍是 danger 卡", async () => {
    const dialog = await openLoaded();
    expect(within(dialog).getByRole("status").textContent).toMatch(/设置已从本地项目载入|正在读取本地设置/);
    const tablist = within(dialog).getByRole("tablist", { name: "设置分区" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tablist.textContent).not.toMatch(/APPEARANCE|PERFORMANCE|SETTINGS/);
    expect(dialog.textContent).not.toMatch(/\d\d \/ [A-Z]/);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(tabs[0]!, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(within(tablist).getByRole("tab", { name: "快捷键" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByRole("table", { name: "快捷键表" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(within(tablist).getByRole("tab", { name: "快捷键" }), { key: "End" });
      await Promise.resolve();
    });
    expect(within(tablist).getByRole("tab", { name: "关于" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "打开日志目录" })).toBeTruthy();
    // R13 §2:「缓存与重建」搬到「项目与缓存」(Home 回到第一块),仍是 danger 卡。
    await act(async () => {
      fireEvent.keyDown(within(tablist).getByRole("tab", { name: "关于" }), { key: "Home" });
      await Promise.resolve();
    });
    expect(within(tablist).getByRole("tab", { name: "项目与缓存" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "清空缓存并重建" }).closest(".settings-sheet-danger")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "关闭设置" })).toBeTruthy();
  });

  it("R13 §2:六个分区各有一句「这里管什么」,没有任何「高级…」折叠;段按搬迁表各在其位", async () => {
    const dialog = await openLoaded();
    for (const tab of SHEET_TABS) {
      const panel = await goTab(dialog, tab);
      expect(panel.querySelector("details.settings-sheet-advanced")).toBeNull();
      expect(panel.textContent).not.toContain("高级…");
      expect(panel.querySelector(".settings-sheet-intro")!.textContent!.length).toBeGreaterThan(8);
    }
    for (const [id, tab] of Object.entries(SECTION_HOME)) {
      const panel = await goTab(dialog, tab);
      expect(panel.querySelector(`[data-section="${id}"]`), id).toBeTruthy();
    }
    // 「项目与缓存」的头两段:缓存与设备时钟。
    const project = await goTab(dialog, "项目与缓存");
    expect(within(project).getByRole("heading", { level: 3, name: "缓存与重建" })).toBeTruthy();
    // Z-18(R13 压测):说清预览用小文件大概占多大。
    expect(within(project).getByText(/预览用小文件.*不超过原片大小/)).toBeTruthy();
    expect(within(project).getByRole("heading", { level: 3, name: "设备时钟校正" })).toBeTruthy();
  });

  it("播放与导出分区:主题四段(R13 加剪映风格深色)、缩放四段、导出文件夹;界面开关(切回旧界面)在性能分区", async () => {
    // 壳里不止 sheet 一处读 getSettings(监视器的三步引导也读一次),Once 会被抢走 —— 用常驻值,末尾还原。
    apiMocks.getSettings.mockResolvedValue({ "ui.workspace_v2": "true", "ui.export.last_dir": "/Volumes/T7/导出" });
    const dialog = await openLoaded();
    await goTab(dialog, "播放与导出");
    expect(within(dialog).getByRole("heading", { level: 3, name: "播放与导出" })).toBeTruthy();
    for (const label of ["跟随系统", "浅色", "深色", "剪映风格深色", "90%", "100%", "115%", "130%"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeTruthy();
    }
    expect(within(dialog).getByRole("button", { name: "跟随系统" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByText("导出文件夹")).toBeTruthy();
    expect(within(dialog).getByText(/\/Volumes\/T7\/导出/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "更改…" })).toBeTruthy();
    const performance = await goSection(dialog, "performance");
    expect(within(performance).getByRole("button", { name: "切回旧界面" })).toBeTruthy();
    apiMocks.getSettings.mockResolvedValue({});
    await goTab(dialog, "播放与导出");
    await act(async () => {
      within(dialog).getByRole("button", { name: "深色" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("appearance.theme", "dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    delete document.documentElement.dataset.theme;
  });

  it("性能分区:后台并行任务数 Select、轻量预览文件 Toggle、内存档位(R11 术语清扫:worker 并发 / 540p 代理 → 白话)", async () => {
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "performance");
    expect(within(panel).getByRole("combobox", { name: "后台同时处理几条" })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: "内存档位" })).toBeTruthy();
    const proxy = within(panel).getByRole("switch", { name: "预览用小文件" });
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
    const panel = await goSection(dialog, "timeline");
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
    const panel = await goSection(dialog, "tools");
    expect(await within(panel).findByText(/ffmpeg/)).toBeTruthy();
    expect(within(panel).getByText(/ffprobe/)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /自检/ })).toBeTruthy();
    const input = within(panel).getByLabelText("视频处理组件的位置") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " /opt/ffmpeg " } });
    fireEvent.blur(input);
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("tools.ffmpeg_path", "/opt/ffmpeg"));
    expect(within(panel).getByRole("combobox", { name: "转写模型" })).toBeTruthy();
    // R11 简化专项 #1:原首启弹窗的工具链引导住在这里 —— 齐全时一行「全部就绪」。
    expect(within(panel).getByText("安装检查")).toBeTruthy();
    expect(within(panel).getByText("全部就绪")).toBeTruthy();
  });

  it("分析与 AI:三条阈值 + 六轴权重 range,provider 未锁定时不许启用 L3", async () => {
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "analysis");
    for (const label of ["场景切分 T", "语义相似度", "抖动阈值", "Technical", "Narrative"]) {
      expect(within(panel).getByRole("slider", { name: label })).toBeTruthy();
    }
    await act(async () => {
      within(panel).getByRole("switch", { name: "启用增强分析" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).not.toHaveBeenCalledWith("llm_enabled", "true");
    expect(within(dialog).getByRole("status").textContent).toBe("请先明确锁定一个 LLM provider,再启用增强分析");
    expect(within(panel).getByRole("combobox", { name: "Provider" })).toBeTruthy();
    expect(within(panel).getByText("尚无调用记录。provider 缺失或开关关闭不会消耗预算。")).toBeTruthy();
  });

  it("隐私与诊断 / 云端补镜 两个冒烟锚点在 sheet 里", async () => {
    const dialog = await openLoaded();
    // 左轨快捷入口「隐私与诊断」直落 关于 → 隐私与诊断(R13:不再有高级折叠,直接在段里)。
    await act(async () => {
      within(dialog).getByRole("button", { name: "隐私与诊断" }).click();
      await Promise.resolve();
    });
    expect(within(dialog).getByRole("tab", { name: "关于", selected: true })).toBeTruthy();
    expect(dialog.querySelector("details.settings-sheet-advanced")).toBeNull();
    const privacy = dialog.querySelector<HTMLElement>('[data-section="privacy"]')!;
    expect(within(privacy).getByRole("heading", { level: 3, name: "隐私与诊断" })).toBeTruthy();
    expect(within(privacy).getByText("始终留在本机，绝不上传")).toBeTruthy();
    // 「打开日志目录」在关于段里。
    const about = dialog.querySelector<HTMLElement>('[data-section="about"]')!;
    expect(within(about).getByRole("button", { name: "打开日志目录" })).toBeTruthy();
    await act(async () => {
      within(dialog).getByRole("button", { name: "云端补镜" }).click();
      await Promise.resolve();
    });
    expect(within(dialog).getByRole("tab", { name: "工具与模型", selected: true })).toBeTruthy();
    const generation = dialog.querySelector<HTMLElement>('[data-section="generation"]')!;
    expect(within(generation).getByRole("heading", { level: 3, name: "云端补镜（MiniMax）" })).toBeTruthy();
  });

  it("云端补镜:默认关闭、generated/ 持久提示、从不回显 key,保存后只显示「已配置」(迁自 SettingsPage.test R7 Task 7)", async () => {
    apiMocks.hasMinimaxKey.mockResolvedValueOnce(false).mockResolvedValue(true);
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "generation");
    expect(within(panel).getByRole("switch", { name: "启用云端补镜" }).getAttribute("aria-checked")).toBe("false");
    expect(within(panel).getByText("未配置")).toBeTruthy();
    expect(within(panel).getByText(/生成的片段会存到素材库的 generated\/ 目录，原素材目录不会被写入/)).toBeTruthy();
    expect(within(panel).getByText(/扣费以 MiniMax 平台账单为准/)).toBeTruthy();
    expect(within(panel).getByText("本月尚无生成记录。")).toBeTruthy();
    const input = within(panel).getByLabelText("MiniMax 密钥") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("粘贴 MiniMax 密钥");
    fireEvent.change(input, { target: { value: "sk-test-secret-value" } });
    await act(async () => {
      within(panel).getByRole("button", { name: "保存" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setMinimaxKey).toHaveBeenCalledWith("sk-test-secret-value"));
    expect(await within(panel).findByText("已配置")).toBeTruthy();
    expect(dialog.innerHTML).not.toContain("sk-test-secret-value");
    expect((within(panel).getByLabelText("MiniMax 密钥") as HTMLInputElement).value).toBe("");
  });

  it("月度预算输入 900 被夹到 500 并报告", async () => {
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "generation");
    const budget = within(panel).getByLabelText("月度预算（USD）");
    fireEvent.change(budget, { target: { value: "900" } });
    fireEvent.blur(budget);
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("minimax_monthly_budget_usd", "500"));
    expect(within(panel).getByText(/上限 500 美元/)).toBeTruthy();
  });

  it("帮助与关于:「检查更新」按钮 + 常驻状态行;检查前没有安装/重启按钮;版本与许可清单在", async () => {
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "about");
    expect(within(panel).getByRole("button", { name: "检查更新" })).toBeTruthy();
    const status = within(panel).getByTestId("updater-status");
    expect(status.getAttribute("data-updater-status")).toBe("idle");
    expect(status.textContent).toBe("尚未检查更新。");
    expect(panel.textContent).toContain("已校验签名");
    expect(panel.querySelector('[data-updater-action="install"]')).toBeNull();
    expect(panel.querySelector('[data-updater-action="restart"]')).toBeNull();
    expect(within(panel).queryByRole("button", { name: /下载并安装|立即重启/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "打开中文帮助" })).toBeTruthy();
    // R11 简化专项 #1:「打开安装向导」在新壳里没有监听者(向导只在旧壳挂载),按钮撤掉;
    // 工具链引导改为常驻 设置 → 工具链 的「安装检查」卡(见下面的工具链用例)。
    expect(within(panel).queryByRole("button", { name: "打开安装向导" })).toBeNull();
    expect(within(panel).getByText("应用版本")).toBeTruthy();
    expect(within(panel).getByText("开源许可清单")).toBeTruthy();
  });

  it("R13 §3:关于分区有「重置新手引导」,点它把七把 guide.<id>.viewed 写回 false", async () => {
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "about");
    await act(async () => {
      within(panel).getByRole("button", { name: "重置新手引导" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("guide.nav.viewed", "false"));
    for (const id of ["heat", "autoselect", "shot", "gap", "export", "autoplay"]) {
      expect(apiMocks.setSetting).toHaveBeenCalledWith(`guide.${id}.viewed`, "false");
    }
  });

  it("缓存与重建:两次点击才执行,第一次提示确认;危险动作在独立卡里", async () => {
    const dialog = await openLoaded();
    const panel = await goSection(dialog, "cache");
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

  it("sheet 里没有任何英文 kicker / 序号水印(十个分区段逐个看)", async () => {
    const dialog = await openLoaded();
    for (const id of Object.keys(SECTION_HOME) as (keyof typeof SECTION_HOME)[]) {
      await goSection(dialog, id);
      expect(dialog.textContent).not.toMatch(
        /\b(SETTINGS|APPEARANCE|PERFORMANCE|TOOLCHAIN|ANALYSIS|MINIMAX|PRIVACY|DIAGNOSTICS|HELP|ABOUT|CACHE|REBUILD|JOURNEY TIME|OPTIONAL LLM|OPTIONAL CLOUD GENERATION)\b/,
      );
    }
  });
});

describe("R10 U-14:openSettings(section) 直接落到分区", () => {
  it("openSettings(\"analysis\") 打开 sheet 且落到「工具与模型 → 分析与 AI」;顶栏按钮仍落到第一块「项目与缓存」", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      openSettings("analysis");
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    // R13 §2:分析与 AI 住在 工具与模型,不再有高级折叠;直落时分区选中、段直接可见。
    expect(within(dialog).getByRole("tab", { name: "工具与模型", selected: true })).toBeTruthy();
    expect(dialog.querySelector("details.settings-sheet-advanced")).toBeNull();
    expect(within(dialog).getByRole("heading", { level: 3, name: "分析与 AI" })).toBeTruthy();
    await act(async () => {
      within(dialog).getByRole("button", { name: "关闭设置" }).click();
      await Promise.resolve();
    });
    await openSettingsSheet();
    const again = await screen.findByRole("dialog", { name: "设置" });
    expect(within(again).getByRole("tab", { name: "项目与缓存", selected: true })).toBeTruthy();
  });
});
