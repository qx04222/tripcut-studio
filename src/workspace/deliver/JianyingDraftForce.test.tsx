// @vitest-environment jsdom
// R14 §9 A(车道 A):剪映草稿「待验证」态的试验开关 + 结果卡三步 + 「可以用 / 打不开」回流。
import { act } from "react";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import type { EpisodeSummary, ExportStatus, JianyingAvailability, JianyingDraftResult } from "../../api";
import { JIANYING_BUNDLE_ID } from "../../api";
import { __resetToastsForTests, getToastSnapshot } from "../ui/toastStore";
import { DeliverForm } from "./DeliverForm";
import { JianyingResultCard } from "./DeliverResultCard";
import { HUMAN_CHECK_FAIL_TOAST, HUMAN_CHECK_OK_TOAST, JIANYING_AVAILABILITY_CHANGED_EVENT } from "./jianyingHumanCheck";
import { draftContentLine } from "./deliverModel";
import { jianyingUnavailableLine } from "./quickExportModel";
import { useDeliverForm } from "./useDeliverForm";
import { useExportProgress } from "./useExportProgress";

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

const pending: JianyingAvailability = {
  installed_version: "11.4.13189", supported: false, usable: false, whitelisted: false, human_check: "none", force_allowed: true,
  reason: "这个剪映版本(11.4.13189)还没核对过;可以试着生成一份草稿,再到剪映里看能不能打开",
};
const verified: JianyingAvailability = { ...pending, supported: true, usable: true, human_check: "ok", reason: "剪映 11.4.13189 已确认可用" };
const unknown: JianyingAvailability = { ...pending, installed_version: "12.0.0", force_allowed: false };

const experimentalResult: JianyingDraftResult = {
  status: "created", output_path: "/tmp/root/旅剪项目_剪映草稿_试验_1_ABC", draft_path: "/tmp/root/旅剪项目_剪映草稿_试验_1_ABC",
  draft_name: "旅剪项目_剪映草稿_试验_1_ABC", jianying_version: "11.4.13189", selected_count: 4, subtitle_count: 0, chapter_marks: 0, has_music: false,
  message: "试验草稿已写出", experimental: true,
};

function useHarness() {
  const progress = useExportProgress();
  return useDeliverForm(progress);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastsForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getSettings.mockResolvedValue({});
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getJianyingAvailability.mockResolvedValue(pending);
});
afterEach(() => cleanup());

describe("R14 §9 A 试验开关", () => {
  it("chip 白话(V14-03):待验证版本一句话「先导出素材包,或试着生成」,不再说「先用完整交付包」;未知版本兜底是素材包", () => {
    expect(jianyingUnavailableLine("11.4.13189", true)).toBe(
      "这个剪映版本(11.4.13189)还没核对过草稿格式。可以先导出素材包,或试着生成一份草稿在剪映里打开看看。",
    );
    expect(jianyingUnavailableLine("11.4.13189")).toContain("先用「剪映素材包」");
    expect(jianyingUnavailableLine("12.0.0", false)).not.toContain("试着生成");
    expect(jianyingUnavailableLine(null)).toContain("剪映素材包");
    for (const line of [jianyingUnavailableLine("11.4.13189", true), jianyingUnavailableLine("11.4.13189"), jianyingUnavailableLine(null)]) {
      expect(line).not.toContain("完整交付包");
    }
  });

  it("待验证版本:表单给一句白话 + 「仍然试着生成」,点了走 force 生成并拿到 experimental 结果", async () => {
    apiMock.generateJianyingDraftForced.mockResolvedValue(experimentalResult);
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(result.current.jianying.force_allowed).toBe(true));
    render(<DeliverForm form={result.current} useJianyingDraft={false} onUseJianyingDraftChange={() => undefined} />);
    expect(screen.getByText(/还没核对过/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "仍然试着生成" });
    expect(button.textContent).toContain("试验");
    fireEvent.click(button);
    await waitFor(() => expect(apiMock.generateJianyingDraftForced).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.nativeResult?.experimental).toBe(true));
    // 试验失败不降级成稳定包(那是普通路径的行为),只报错。
    expect(apiMock.pickExportFolder).not.toHaveBeenCalled();
  });

  it("未知版本没有「仍然试着生成」;已验证版本也没有(直接走正常开关)", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue(unknown);
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(result.current.jianying.installed_version).toBe("12.0.0"));
    const view = render(<DeliverForm form={result.current} useJianyingDraft={false} onUseJianyingDraftChange={() => undefined} />);
    expect(screen.queryByRole("button", { name: "仍然试着生成" })).toBeNull();
    view.unmount();

    apiMock.getJianyingAvailability.mockResolvedValue(verified);
    const second = renderHook(useHarness);
    await waitFor(() => expect(second.result.current.jianying.supported).toBe(true));
    render(<DeliverForm form={second.result.current} useJianyingDraft onUseJianyingDraftChange={() => undefined} />);
    expect(screen.queryByRole("button", { name: "仍然试着生成" })).toBeNull();
    expect((screen.getByLabelText("剪映草稿") as HTMLInputElement).disabled).toBe(false);
  });

  it("试验结果卡:三步带草稿名、「打开剪映」走 openApp、「可以用」写 ok 并 toast + 广播可用性", async () => {
    apiMock.setJianyingHumanCheck.mockResolvedValue(verified);
    const heard: JianyingAvailability[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<JianyingAvailability>).detail);
    window.addEventListener(JIANYING_AVAILABILITY_CHANGED_EVENT, listener);
    render(<JianyingResultCard result={experimentalResult} />);
    const steps = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("打开剪映");
    expect(steps[1]).toContain(experimentalResult.draft_name);
    expect(steps[2]).toContain("可以用");
    fireEvent.click(screen.getByRole("button", { name: "打开剪映" }));
    expect(apiMock.openApp).toHaveBeenCalledWith(JIANYING_BUNDLE_ID);
    fireEvent.click(screen.getByRole("button", { name: "可以用" }));
    await waitFor(() => expect(apiMock.setJianyingHumanCheck).toHaveBeenCalledWith("11.4.13189", "ok"));
    await waitFor(() => expect(getToastSnapshot()?.text).toBe(HUMAN_CHECK_OK_TOAST));
    expect(heard).toEqual([verified]);
    // 记上之后两个按钮换成一句「已记下」,不能再连点。
    await waitFor(() => expect(screen.queryByRole("button", { name: "可以用" })).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("已记下「可以用」");
    window.removeEventListener(JIANYING_AVAILABILITY_CHANGED_EVENT, listener);
  });

  it("「打不开」写 fail 并 toast;非试验结果卡没有这三步和按钮", async () => {
    apiMock.setJianyingHumanCheck.mockResolvedValue({ ...pending, human_check: "fail" });
    render(<JianyingResultCard result={experimentalResult} />);
    fireEvent.click(screen.getByRole("button", { name: "打不开" }));
    await waitFor(() => expect(apiMock.setJianyingHumanCheck).toHaveBeenCalledWith("11.4.13189", "fail"));
    await waitFor(() => expect(getToastSnapshot()?.text).toBe(HUMAN_CHECK_FAIL_TOAST));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已记下「打不开」"));
    cleanup();
    render(<JianyingResultCard result={{ ...experimentalResult, experimental: false, draft_name: "旅剪项目_剪映草稿_ABC" }} />);
    expect(screen.queryByRole("button", { name: "可以用" })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("V14-05 结果卡说清内容:「n 章(看素材名前缀) · 已带配乐 · m 段」,正常卡与试验卡都有", () => {
    expect(draftContentLine({ chapter_marks: 7, has_music: true, selected_count: 11 })).toBe("7 章(看素材名前缀) · 已带配乐 · 11 段");
    expect(draftContentLine({ chapter_marks: 0, has_music: false, selected_count: 4 })).toBe("没分章 · 未带配乐 · 4 段");
    render(<JianyingResultCard result={{ ...experimentalResult, chapter_marks: 7, has_music: true, selected_count: 11 }} />);
    expect(screen.getByText("7 章(看素材名前缀) · 已带配乐 · 11 段")).toBeTruthy();
    cleanup();
    render(<JianyingResultCard result={{ ...experimentalResult, experimental: false, chapter_marks: 2, has_music: false, selected_count: 3 }} />);
    expect(screen.getByText("2 章(看素材名前缀) · 未带配乐 · 3 段")).toBeTruthy();
  });

  it("可用性广播 → useDeliverForm 立刻换成新可用性(抽屉里的开关随之解锁)", async () => {
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(result.current.jianying.supported).toBe(false));
    act(() => {
      window.dispatchEvent(new CustomEvent(JIANYING_AVAILABILITY_CHANGED_EVENT, { detail: verified }));
    });
    expect(result.current.jianying.supported).toBe(true);
    await waitFor(() => expect(result.current.canGenerateNative).toBe(true)); // 主按钮「生成剪映草稿」随之可用
  });
});
