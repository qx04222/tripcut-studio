// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => (await import("../testApiMock")).createTestApiMock({}));
vi.mock("../../api", () => apiMock);

import { ImportJobsTab } from "./ImportJobsTab";

const PROGRESS = { total: 21, done: 21, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false, paused_reason: null };
const BATCH = { id: 1, source: "/walk-media", status: "queued", total: 21, done: 21, running: 0, failed: 0, duplicates: 0, imported: 21 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  apiMock.getClipsRevision.mockResolvedValue("rev-1");
  apiMock.getCurrentEpisode.mockResolvedValue({ id: 1 } as never);
  apiMock.listClips.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ id: index + 1, episode_id: 1, status: "ready" }) as never));
  apiMock.getImportProgress.mockResolvedValue(PROGRESS as never);
  apiMock.listImportBatches.mockResolvedValue([BATCH] as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * A16-01(0.8.0 真机):「全部暂停」态下清缓存后,任务页显示 0 / 0 / 0「还没有导入批次」而池仍 21 条。
 * 后端两条读取(get_import_progress / list_batches)都不按暂停过滤,界面上那副样子恰好就是
 * hook 的初始空状态 —— 第一拍轮询没跑或没回。所以:没读回来之前不能冒充「空」;首拍不受
 * visibilityState 门挡;暂停态要在这一页说清「后台已暂停」而数字照旧。
 */
describe("ImportJobsTab(A16-01)", () => {
  it("第一拍数据回来之前显示「正在读取」,不显示「还没有导入批次」与 0 / 0", () => {
    apiMock.getImportProgress.mockReturnValue(new Promise(() => undefined));
    render(<ImportJobsTab onChanged={() => undefined} />);
    expect(screen.queryByText("还没有导入批次")).toBeNull();
    expect(screen.queryByText("已处理 0 / 0")).toBeNull();
    expect(screen.getAllByText(/正在读取/).length).toBeGreaterThan(0);
  });

  it("挂载时 visibilityState 报 hidden 也要跑第一拍(只有定时器停表)", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    render(<ImportJobsTab onChanged={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(apiMock.getImportProgress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("已处理 21 / 21")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(apiMock.getImportProgress).toHaveBeenCalledTimes(1);
  });

  it("「全部暂停」态:总数照旧 21 / 21、批次照旧列出,并提示「后台已暂停」", async () => {
    apiMock.getImportProgress.mockResolvedValue({ ...PROGRESS, paused_reason: "user" } as never);
    render(<ImportJobsTab onChanged={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("已处理 21 / 21")).toBeTruthy();
    expect(screen.getByText("walk-media")).toBeTruthy();
    expect(screen.getByText(/后台已暂停/)).toBeTruthy();
  });
});
