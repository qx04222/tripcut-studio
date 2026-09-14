// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import type { ClipListItem } from "../api";
import { InspectorRetryAnalysis } from "./InspectorRetryAnalysis";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const clip = (overrides: Partial<ClipListItem>): ClipListItem => ({ id: 3, file_name: "A.MOV", analysis_status: "done", motion_status: "done", ...overrides }) as ClipListItem;

/** R16 P2-4:检查器技术检查段「重新分析这条」。 */
describe("InspectorRetryAnalysis", () => {
  it("失败时是主按钮;点了调 retryClipAnalysis 并报已重新排队", async () => {
    apiMocks.retryClipAnalysis.mockResolvedValue({ clip_id: 3, reset: 1, enqueued: 0 });
    render(<InspectorRetryAnalysis clip={clip({ analysis_status: "failed" })} />);
    const button = screen.getByRole("button", { name: "重新分析这条" });
    expect(button.className).toContain("primary");
    fireEvent.click(button);
    await waitFor(() => expect(apiMocks.retryClipAnalysis).toHaveBeenCalledWith(3));
    await screen.findByText("已重新排队,分析在后台继续。");
  });

  it("两个 0 = 已经分析完;后端拒绝原话进提示;进行中禁用", async () => {
    apiMocks.retryClipAnalysis.mockResolvedValueOnce({ clip_id: 3, reset: 0, enqueued: 0 });
    const { unmount } = render(<InspectorRetryAnalysis clip={clip({})} />);
    fireEvent.click(screen.getByRole("button", { name: "重新分析这条" }));
    await screen.findByText("这条已经分析完,不用重跑。");
    apiMocks.retryClipAnalysis.mockRejectedValueOnce(new Error("原片不在原来的位置"));
    fireEvent.click(screen.getByRole("button", { name: "重新分析这条" }));
    await screen.findByText(/原片不在原来的位置/);
    unmount();
    render(<InspectorRetryAnalysis clip={clip({ analysis_status: "running" })} />);
    expect((screen.getByRole("button", { name: "重新分析这条" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
