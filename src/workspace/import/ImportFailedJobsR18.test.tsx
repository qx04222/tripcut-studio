// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import type { FailedJob } from "../../api";
import { CLEAR_FAILED_JOBS, ImportFailedJobs } from "./ImportFailedJobs";

const rows: FailedJob[] = [
  { id: 811, kind: "analyze_l1", status: "blocked", clip_id: 5, file_name: "DJI_0005.MP4", summary: "读不到这个文件", finished_at: "2026-09-14T08:40:00Z" },
  { id: 812, kind: "proxy", status: "failed", clip_id: 8, file_name: "C0048.MP4", summary: null, finished_at: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listFailedJobs.mockResolvedValue(rows);
  apiMocks.clearFailedJobs.mockResolvedValue(2);
});
afterEach(() => cleanup());

/**
 * R18 车道 settings F8:「清空全部失败」。没有失败任务时整段不画(不要一颗
 * 永远在那里、按了什么都不发生的按钮);清空之后列表空、按钮跟着消失。
 */
describe("F8 清空全部失败", () => {
  it("有失败任务才画这一段,每行说清失败原因", async () => {
    render(<ImportFailedJobs onChanged={vi.fn()} />);
    await screen.findByText("读不到这个文件");
    expect(screen.getByRole("button", { name: CLEAR_FAILED_JOBS })).toBeTruthy();
    // 没有失败原因的那条也要有一句话,不能是空白行。
    expect(screen.getByText(/没说原因/)).toBeTruthy();
  });

  it("一条都没有时整段不画", async () => {
    apiMocks.listFailedJobs.mockResolvedValue([]);
    render(<ImportFailedJobs onChanged={vi.fn()} />);
    await waitFor(() => expect(apiMocks.listFailedJobs).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: CLEAR_FAILED_JOBS })).toBeNull();
  });

  it("按下调一次 clear_failed_jobs,列表立刻空掉并报清了几条", async () => {
    const onChanged = vi.fn();
    render(<ImportFailedJobs onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: CLEAR_FAILED_JOBS }));
    await waitFor(() => expect(apiMocks.clearFailedJobs).toHaveBeenCalledTimes(1));
    // F8 的关键:不是循环 cancel_job —— 那对 blocked 是空操作(见 core/diagnostics.rs)。
    expect(apiMocks.cancelJob).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("button", { name: CLEAR_FAILED_JOBS })).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("2");
    expect(onChanged).toHaveBeenCalled();
  });
});
