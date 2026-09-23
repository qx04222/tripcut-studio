// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/?jianying=pending" }
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import type { EpisodeSummary, ExportStatus, JianyingDraftResult } from "../../api";
import type * as ApiModule from "../../api";
import { DeliverDrawer } from "../DeliverDrawer";
import { __resetWorkspaceForTests } from "../WorkspaceStore";
import { __resetToastsForTests } from "../ui/toastStore";
import { FORCE_DRAFT_LABEL, SUBTITLES_ON_TIMELINE_LABEL } from "./DeliverForm";
import { FOLDER_ACCESS_HINT, JianyingResultCard } from "./DeliverResultCard";
import { __resetExportModeForTests, openDeliverAs } from "./exportModeRequest";

const episode: EpisodeSummary = {
  id: 5, title: "EP05", theme: "", episode_number: 5, status: "active", created_at: "2026-09-01T00:00:00Z", archived_at: null,
  clip_count: 4, favorite_count: 2, export_count: 0, target_platform: "general", canvas_orientation: "landscape",
};
const idleStatus: ExportStatus = {
  job_id: null, status: "idle", stage: "idle", selected_count: 4, selected_segment_count: 3, selected_whole_count: 1,
  total_duration_seconds: 185, completed_items: 0, failed_items: 0, items: [], output_path: null, error: null,
  contact_sheet_glyph_fallbacks: null, contact_sheet_cover_failures: null, rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null, rough_cut_actual_tb_num: null, rough_cut_actual_tb_den: null,
};
const draft: JianyingDraftResult = {
  status: "created", output_path: "/mock/draft", draft_name: "测试草稿", jianying_version: "11.4.13189",
  selected_count: 4, subtitle_count: 7, chapter_marks: 0, has_music: false, message: "草稿已生成(mock)",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests({ workspaceMode: "video" });
  __resetExportModeForTests();
  __resetToastsForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getSettings.mockResolvedValue({});
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4.13189", supported: true, force_allowed: true, reason: "已检测到剪映" });
  apiMock.generateJianyingDraft.mockResolvedValue(draft);
  apiMock.generateJianyingDraftForced.mockResolvedValue({ ...draft, experimental: true });
});
afterEach(() => {
  cleanup();
  __resetToastsForTests();
});

async function openDraftDrawer() {
  act(() => openDeliverAs("jianying"));
  render(<DeliverDrawer />);
  return screen.findByRole("switch", { name: SUBTITLES_ON_TIMELINE_LABEL });
}

describe("R24 字幕写进时间线", () => {
  it("默认关闭,主按钮仍以无参方式生成草稿", async () => {
    const toggle = await openDraftDrawer();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(apiMock.generateJianyingDraft.mock.calls).toEqual([[]]));
  });

  it("开启后主按钮传字幕选项,生成期间开关禁用", async () => {
    let finish!: (result: JianyingDraftResult) => void;
    apiMock.generateJianyingDraft.mockReturnValueOnce(new Promise<JianyingDraftResult>((resolve) => { finish = resolve; }));
    const toggle = await openDraftDrawer();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(apiMock.generateJianyingDraft.mock.calls).toEqual([[{ subtitlesOnTimeline: true }]]));
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ...draft, subtitles_on_timeline: true, timeline_subtitle_count: 7 }));
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("字幕已写进时间线:7 条")).toBeTruthy();
    // R27 真机:原片在桌面等受保护文件夹时剪映首开会弹 macOS 授权框,结果卡要提前说
    expect(screen.getByText(FOLDER_ACCESS_HINT)).toBeTruthy();
  });

  it.each([false, true])("待验证版本也显示开关,开启=%s 时强制生成传对应参数", async (enabled) => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4.13189", supported: false, force_allowed: true, reason: "待核对" });
    const toggle = await openDraftDrawer();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    if (enabled) fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: FORCE_DRAFT_LABEL }));
    await waitFor(() => expect(apiMock.generateJianyingDraftForced.mock.calls).toEqual(enabled ? [[{ subtitlesOnTimeline: true }]] : [[]]));
    expect(apiMock.generateJianyingDraft).not.toHaveBeenCalled();
  });

  it("不可用且禁止 force 时不渲染开关", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, force_allowed: false, reason: "未检测到剪映" });
    act(() => openDeliverAs("jianying"));
    render(<DeliverDrawer />);
    await screen.findByText("未检测到剪映");
    expect(screen.queryByRole("switch", { name: SUBTITLES_ON_TIMELINE_LABEL })).toBeNull();
  });

  it("打开后再关闭开关,生成恢复无参调用", async () => {
    const toggle = await openDraftDrawer();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(apiMock.generateJianyingDraft.mock.calls).toEqual([[]]));
  });

  it("关闭抽屉后重新打开默认关闭,字幕选择不写 settings", async () => {
    const toggle = await openDraftDrawer();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导出" })).toBeNull());
    act(() => openDeliverAs("jianying"));
    const reopened = await screen.findByRole("switch", { name: SUBTITLES_ON_TIMELINE_LABEL });
    expect(reopened.getAttribute("aria-checked")).toBe("false");
    expect(apiMock.setSetting).not.toHaveBeenCalled();
  });

  it.each([false, true])("普通/试验结果卡 experimental=%s 显示字幕条数", (experimental) => {
    render(<JianyingResultCard result={{ ...draft, experimental, subtitles_on_timeline: true, timeline_subtitle_count: 7 }} />);
    expect(screen.getByText("字幕已写进时间线:7 条")).toBeTruthy();
  });

  it.each([undefined, false])("字幕字段为 %s 时普通/试验结果卡均不增加字幕行", (enabled) => {
    const result = enabled === undefined ? draft : { ...draft, subtitles_on_timeline: enabled, timeline_subtitle_count: 0 };
    const view = render(<JianyingResultCard result={result} />);
    expect(screen.queryByText(/字幕已写进时间线/)).toBeNull();
    view.rerender(<JianyingResultCard result={{ ...result, experimental: true }} />);
    expect(screen.queryByText(/字幕已写进时间线/)).toBeNull();
  });
});

describe("R24 草稿 API invoke 参数兼容性", () => {
  it.each([undefined, {}, { subtitlesOnTimeline: false }, { subtitlesOnTimeline: true }])("普通草稿 options=%j 保持精确调用参数", async (options) => {
    const actual = await vi.importActual<typeof ApiModule>("../../api");
    if (options === undefined) await actual.generateJianyingDraft();
    else await actual.generateJianyingDraft(options);
    expect(invoke.mock.calls).toEqual(options?.subtitlesOnTimeline === true
      ? [["generate_jianying_draft", { subtitlesOnTimeline: true }]]
      : [["generate_jianying_draft"]]);
  });

  it.each([undefined, {}, { subtitlesOnTimeline: false }, { subtitlesOnTimeline: true }])("强制草稿 options=%j 保持精确调用参数", async (options) => {
    const actual = await vi.importActual<typeof ApiModule>("../../api");
    if (options === undefined) await actual.generateJianyingDraftForced();
    else await actual.generateJianyingDraftForced(options);
    expect(invoke.mock.calls).toEqual(options?.subtitlesOnTimeline === true
      ? [["generate_jianying_draft", { force: true, subtitlesOnTimeline: true }]]
      : [["generate_jianying_draft", { force: true }]]);
  });
});

describe("R24 devMock 字幕结果", () => {
  it.each([undefined, false, true])("最终生效 handler 在 subtitlesOnTimeline=%s 时返回对应计数", async (enabled) => {
    const { __resetMockForTests, handleMockCommand } = await import("../../devMock/fixture");
    __resetMockForTests();
    const result = handleMockCommand("generate_jianying_draft", { force: true, subtitlesOnTimeline: enabled }) as JianyingDraftResult;
    expect(result.subtitles_on_timeline).toBe(enabled === true);
    expect(result.timeline_subtitle_count).toBe(enabled === true ? 7 : 0);
    expect(result.experimental).toBe(true);
    expect(() => handleMockCommand("generate_jianying_draft", { subtitlesOnTimeline: enabled })).toThrow(/已停止原生草稿路径/);
  });
});
