// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 断言**复制**自 `src/ImportPageRuntime.test.tsx:107-160` 与 `src/ImportManagement.test.tsx`
// (规格 §5:旧测试不动,hook 自己再钉一份)。
const apiMock = await vi.hoisted(async () => (await import("../testApiMock")).createTestApiMock({}));
vi.mock("../../api", () => apiMock);

import { useImportJobs } from "./useImportJobs";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  apiMock.getClipsRevision.mockResolvedValue("rev-1");
  apiMock.listClips.mockResolvedValue([]);
  apiMock.getCurrentEpisode.mockResolvedValue({ id: 1 } as never);
  apiMock.listImportBatches.mockResolvedValue([
    { id: 7, source: "/fixture/card", status: "scanning", total: 2, done: 0, running: 1, failed: 0, duplicates: 0, imported: 1 },
  ]);
  apiMock.previewImportRemoval.mockResolvedValue({ clips: 1, favorites: 2, selections: 1, cache_entries: 3 });
});
afterEach(() => {
  // 没开 vitest globals,testing-library 不会自动 cleanup —— 不手动卸载,上一例的轮询会串进下一例。
  cleanup();
  vi.useRealTimers();
});

describe("useImportJobs(迁自 ImportPageRuntime.test / ImportManagement.test)", () => {
  it("revision 不变时跳过 listClips,只刷进度", async () => {
    const { result } = renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(apiMock.listClips).toHaveBeenCalledTimes(1);
    expect(apiMock.getImportProgress).toHaveBeenCalledTimes(2);
    expect(result.current.refreshError).toBeNull();
  });

  it("revision 变了就整表重拉", async () => {
    apiMock.getClipsRevision.mockResolvedValueOnce("rev-1").mockResolvedValueOnce("rev-2");
    renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(apiMock.listClips).toHaveBeenCalledTimes(2);
  });

  it("getClipsRevision 抛错回落全量,不卡死", async () => {
    apiMock.getClipsRevision.mockRejectedValue(new Error("boom"));
    renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(apiMock.listClips).toHaveBeenCalledTimes(2);
  });

  it("刷新失败显示 refreshError,下一轮成功即清除", async () => {
    apiMock.listClips.mockRejectedValueOnce(new Error("数据库忙"));
    const { result } = renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.refreshError).toContain("数据库忙");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.refreshError).toBeNull();
  });

  it("页面隐藏时停表,可见后立刻补跑", async () => {
    renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(apiMock.getImportProgress).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(apiMock.getImportProgress).toHaveBeenCalledTimes(2);
  });

  it("卸载后不再轮询", async () => {
    const { unmount } = renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(apiMock.getImportProgress).toHaveBeenCalledTimes(1);
  });

  it("arm 先预览不删;cancelConfirmation 后仍不删", async () => {
    const { result } = renderHook(() => useImportJobs());
    await act(async () => { result.current.arm({ batch_id: null, clip_ids: [5], all: false }); await vi.advanceTimersByTimeAsync(0); });
    expect(apiMock.previewImportRemoval).toHaveBeenCalledWith({ batch_id: null, clip_ids: [5], all: false });
    expect(result.current.confirmation?.preview.clips).toBe(1);
    act(() => result.current.cancelConfirmation());
    expect(result.current.confirmation).toBeNull();
    expect(apiMock.removeImportedMaterial).not.toHaveBeenCalled();
  });

  it("停止本批只 cancel,不删已入库;onChanged 被调", async () => {
    const onChanged = vi.fn();
    const { result } = renderHook(() => useImportJobs({ onChanged }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.cancelBatch(7); });
    expect(apiMock.cancelImportBatch).toHaveBeenCalledWith(7);
    expect(apiMock.removeImportedMaterial).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(result.current.notice).toContain("已入库素材保留");
  });

  it("撤销本批只针对该批,通知带实际删除数", async () => {
    apiMock.removeImportedMaterial.mockResolvedValue(1);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useImportJobs({ onChanged }));
    await act(async () => { result.current.arm({ batch_id: 7, clip_ids: [], all: false }); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await result.current.confirmRemoval(); });
    expect(apiMock.removeImportedMaterial).toHaveBeenCalledWith({ batch_id: 7, clip_ids: [], all: false });
    expect(result.current.confirmation).toBeNull();
    expect(result.current.notice).toContain("已移除 1 条素材");
    expect(onChanged).toHaveBeenCalled();
  });

  it("R15:清空当前集后本地素材立刻清空,不等下一轮轮询", async () => {
    apiMock.listClips.mockResolvedValue([
      { id: 11, episode_id: 1, status: "ready" } as never,
      { id: 12, episode_id: 1, status: "ready" } as never,
    ]);
    apiMock.removeImportedMaterial.mockResolvedValue(2);
    const { result } = renderHook(() => useImportJobs({ pollMs: 1500 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.clips).toHaveLength(2);
    await act(async () => { result.current.arm({ batch_id: null, clip_ids: [], all: true }); await vi.advanceTimersByTimeAsync(0); });
    // 命令返回后、下一轮轮询之前,池里已经空了;文案说缓存在后台清理。
    apiMock.listClips.mockClear();
    await act(async () => { await result.current.confirmRemoval(); });
    expect(result.current.clips).toHaveLength(0);
    expect(result.current.notice).toContain("缓存文件在后台清理");
  });

  it("清理重复/失败提示:文案沿用,onChanged 被调", async () => {
    const onChanged = vi.fn();
    const { result } = renderHook(() => useImportJobs({ onChanged }));
    await act(async () => { await result.current.dismissNotices(); });
    expect(apiMock.dismissImportNotices).toHaveBeenCalled();
    expect(result.current.notice).toContain("已清理重复/失败提示");
    expect(onChanged).toHaveBeenCalled();
  });

  it("进度 / 就绪素材 / 两条分析进度按当前集算", async () => {
    apiMock.getImportProgress.mockResolvedValue({ total: 3, done: 2, failed: 1, running: 0, waiting_for_permit: 0, paused_for_memory: false });
    apiMock.listClips.mockResolvedValue([
      { id: 1, episode_id: 1, status: "ready", analysis: {}, analysis_status: "done", motion: {}, motion_status: "running" },
      { id: 2, episode_id: 1, status: "duplicate", analysis: null, analysis_status: null, motion: null, motion_status: null },
      { id: 3, episode_id: 2, status: "ready", analysis: {}, analysis_status: "done", motion: {}, motion_status: "done" },
    ] as never);
    const { result } = renderHook(() => useImportJobs());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.progress.done).toBe(2);
    expect(result.current.clips).toHaveLength(2);
    expect(result.current.readyClips.map((clip) => clip.id)).toEqual([1]);
    expect(result.current.quality).toEqual({ done: 1, running: 0, failed: 0, waiting: 0 });
    expect(result.current.motion).toEqual({ done: 0, running: 1, failed: 0, waiting: 0 });
  });
});
