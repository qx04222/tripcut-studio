// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { StatusPause } from "./StatusPause";
import { StatusStrip } from "./StatusStrip";

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getJobsPaused.mockResolvedValue(false);
  apiMocks.setJobsPaused.mockImplementation(async (paused: boolean) => paused);
});
afterEach(cleanup);

/** R16 P1-6:状态条「全部暂停 / 继续」。 */
describe("StatusPause", () => {
  it("挂载读当前态;点「全部暂停」调 setJobsPaused(true) 并换成「继续」+「后台已暂停」", async () => {
    render(<StatusPause />);
    const button = await screen.findByRole("button", { name: "全部暂停" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    await waitFor(() => expect(apiMocks.setJobsPaused).toHaveBeenCalledWith(true));
    await screen.findByRole("button", { name: "继续后台任务" });
    expect(screen.getByText("后台已暂停")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续后台任务" }));
    await waitFor(() => expect(apiMocks.setJobsPaused).toHaveBeenCalledWith(false));
    await screen.findByRole("button", { name: "全部暂停" });
  });

  it("后端说已暂停时直接画「继续」", async () => {
    apiMocks.getJobsPaused.mockResolvedValue(true);
    render(<StatusPause />);
    await screen.findByRole("button", { name: "继续后台任务" });
  });

  // A16-06(0.8.0 真机):按态可见文案只有「继续」两个字,业主看不出它是「继续后台任务」;
  // 可见文案与 AX 名一致。「后台已暂停」那句仍在。
  it("按态可见文案是「继续后台任务」,与 AX 名一致", async () => {
    apiMocks.getJobsPaused.mockResolvedValue(true);
    render(<StatusPause />);
    const button = await screen.findByRole("button", { name: "继续后台任务" });
    expect(button.textContent).toBe("继续后台任务");
    expect(screen.getByText("后台已暂停")).toBeTruthy();
  });

  it("状态条里主按钮旁就是它", async () => {
    render(<StatusStrip />);
    await screen.findByRole("button", { name: "全部暂停" });
    expect(screen.getByRole("button", { name: "查看后台任务详情" })).toBeTruthy();
  });
});
