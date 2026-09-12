// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import type { ExportStatus } from "../../api";
import { useExportProgress } from "./useExportProgress";

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
  apiMock.getExportStatus.mockReset();
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useExportProgress", () => {
  it("空闲 2s 一轮,进行中 750ms 一轮", async () => {
    vi.useFakeTimers();
    apiMock.getExportStatus.mockResolvedValue(idleStatus);
    renderHook(() => useExportProgress());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(apiMock.getExportStatus).toHaveBeenCalledTimes(2);
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, status: "running", stage: "remuxing", job_id: 9 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const before = apiMock.getExportStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(apiMock.getExportStatus.mock.calls.length).toBe(before + 1);
    vi.useRealTimers();
  });

  it("tripcut:episode-changed 清空 job 并重取", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, job_id: 9, status: "done", stage: "complete" });
    const { result } = renderHook(() => useExportProgress());
    await waitFor(() => expect(result.current.jobId).toBe(9));
    apiMock.getExportStatus.mockResolvedValue(idleStatus);
    act(() => {
      window.dispatchEvent(new Event("tripcut:episode-changed"));
    });
    await waitFor(() => expect(result.current.jobId).toBeNull());
  });

  it("active 跟随 status;轮询失败把错误留在 error 上,下一轮成功后清掉", async () => {
    const { result } = renderHook(() => useExportProgress());
    await waitFor(() => expect(result.current.status.selected_count).toBe(4));
    expect(result.current.active).toBe(false);
    apiMock.getExportStatus.mockRejectedValueOnce(new Error("离线"));
    await act(async () => {
      await result.current.refresh().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).toContain("离线"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
  });
});
