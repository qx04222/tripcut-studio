// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import type { EpisodeSummary, ExportStatus, PlatformPreset } from "../../api";
import { useDeliverForm } from "./useDeliverForm";
import { useExportProgress } from "./useExportProgress";

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

function useBoth() {
  const p = useExportProgress();
  return useDeliverForm(p);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue(platformPresets);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "未检测" });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.pickExportFolder.mockResolvedValue("/Volumes/DELIVERY");
  apiMock.startExport.mockResolvedValue({ ...idleStatus, job_id: 7, status: "running", stage: "queued" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDeliverForm", () => {
  it("override 默认等于本集平台;等于时 startExport 不传 platform", async () => {
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.overridePlatform).toBe("xiaohongshu"));
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    await act(async () => {
      await result.current.generate();
    });
    expect(apiMock.startExport).toHaveBeenCalledWith("/Volumes/DELIVERY", undefined, true, 60);
  });

  it("改成别的平台才把 overridePlatform 传给 startExport", async () => {
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.overridePlatform).toBe("xiaohongshu"));
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.setOverridePlatform("douyin"));
    await act(async () => {
      await result.current.generate();
    });
    expect(apiMock.startExport.mock.calls[0]![1]).toBe("douyin");
  });

  it("联系表默认勾选,关掉后传 false", async () => {
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.includeContactSheet).toBe(true));
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.setIncludeContactSheet(false));
    await act(async () => {
      await result.current.generate();
    });
    expect(apiMock.startExport.mock.calls[0]![2]).toBe(false);
  });

  it("平台预设无预算时默认「完整」(null);有预算时取不超预算的最大档", async () => {
    apiMock.listPlatformPresets.mockResolvedValue([]);
    const a = renderHook(useBoth);
    await waitFor(() => expect(a.result.current.episodePlatform).toBe("xiaohongshu"));
    expect(a.result.current.targetSeconds).toBeNull();
    apiMock.listPlatformPresets.mockResolvedValue(platformPresets); // 90s 预算
    const b = renderHook(useBoth);
    await waitFor(() => expect(b.result.current.targetSeconds).toBe(60));
  });

  it("选了目录才 startExport;取消选目录不报错也不生成", async () => {
    apiMock.pickExportFolder.mockResolvedValue(null);
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    await act(async () => {
      await result.current.generate();
    });
    expect(apiMock.startExport).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.destination).toBeNull();
  });

  it("startExport 抛错落在 error 上", async () => {
    apiMock.startExport.mockRejectedValue(new Error("磁盘满"));
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    await act(async () => {
      await result.current.generate();
    });
    expect(result.current.error).toContain("磁盘满");
  });

  it("剪映草稿失败自动降级为稳定包,notice 说明原因", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4", supported: true, reason: "" });
    apiMock.generateJianyingDraft.mockRejectedValue(new Error("字幕自检失败"));
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.jianying.supported).toBe(true));
    await act(async () => {
      await result.current.generateNative();
    });
    expect(apiMock.startExport).toHaveBeenCalledTimes(1);
    expect(result.current.nativeNotice).toContain("已降级并开始生成稳定交付包");
    expect(result.current.nativeNotice).toContain("字幕自检失败");
  });

  it("剪映草稿成功:nativeResult 带回读结果,不动稳定包", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4", supported: true, reason: "" });
    apiMock.generateJianyingDraft.mockResolvedValue({
      draft_name: "EP05_旅剪",
      output_path: "/Users/me/JianyingPro Drafts/EP05_旅剪",
      message: "草稿已生成并通过回读自检",
      item_count: 4,
    } as never);
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.jianying.supported).toBe(true));
    await act(async () => {
      await result.current.generateNative();
    });
    expect(result.current.nativeResult?.draft_name).toBe("EP05_旅剪");
    expect(apiMock.startExport).not.toHaveBeenCalled();
  });

  it("剪映不受支持时 canGenerateNative=false,reason 原样透出", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({
      installed_version: "11.4.13169",
      supported: false,
      reason: "剪映 11.4.13169 尚未人工核对,暂不生成原生草稿",
    });
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.jianying.reason).toContain("11.4.13169"));
    expect(result.current.canGenerateNative).toBe(false);
  });

  it("取消:cancelExport(job_id) 后 refresh;打开文件夹:revealExport(job_id)", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, job_id: 9, status: "running", stage: "remuxing" });
    const { result } = renderHook(() => {
      const progress = useExportProgress();
      return { progress, form: useDeliverForm(progress) };
    });
    // canGenerate 在首轮轮询回来之前就已是 false(空状态 selected_count=0),要等的是 job 本身。
    await waitFor(() => expect(result.current.progress.jobId).toBe(9));
    expect(result.current.form.canGenerate).toBe(false);
    await act(async () => {
      await result.current.form.cancel();
    });
    expect(apiMock.cancelExport).toHaveBeenCalledWith(9);
    await act(async () => {
      await result.current.form.reveal();
    });
    expect(apiMock.revealExport).toHaveBeenCalledWith(9);
  });

  it("tripcut:action deliver-export 触发 generate", async () => {
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("tripcut:action", { detail: "deliver-export" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.startExport).toHaveBeenCalledTimes(1));
  });

  it("挂载即广播 deliver-availability,卸载广播 false", async () => {
    const seen: boolean[] = [];
    window.addEventListener("tripcut:deliver-availability", (e) => seen.push((e as CustomEvent<boolean>).detail));
    const { unmount } = renderHook(useBoth);
    await waitFor(() => expect(seen).toContain(true));
    unmount();
    expect(seen.at(-1)).toBe(false);
  });

  it("tripcut:episode-changed 重取平台,并清掉上一集的 nativeResult", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4", supported: true, reason: "" });
    apiMock.generateJianyingDraft.mockResolvedValue({ draft_name: "D", output_path: "/x", message: "ok", item_count: 1 } as never);
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.jianying.supported).toBe(true));
    await act(async () => {
      await result.current.generateNative();
    });
    expect(result.current.nativeResult).not.toBeNull();
    apiMock.getCurrentEpisode.mockResolvedValue({ ...episode, target_platform: "douyin" });
    await act(async () => {
      window.dispatchEvent(new Event("tripcut:episode-changed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.episodePlatform).toBe("douyin"));
    expect(result.current.nativeResult).toBeNull();
  });
});
