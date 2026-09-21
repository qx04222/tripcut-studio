// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ autoSelectEpisodeWith: vi.fn(async () => ({ batch_id: "photo-batch", run_id: "photo-run", created: [], fell_back: false })), undoAutoSelect: vi.fn(async () => 2), listAutoSelectRun: vi.fn(async () => ({ rows: [], params: {}, batch_id: "photo-batch" })) }));
vi.mock("../api", async (original) => ({ ...(await original()), ...api }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => ({ clips: [], episode: { scopeId: 4 } }), refreshClipsFeed: vi.fn(async () => undefined) }));
import { PhotoAutoSelect } from "./PhotoAutoSelect";
import { __resetWorkspaceForTests } from "./WorkspaceStore";
beforeEach(() => __resetWorkspaceForTests());
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("照片工作台显示按张数和照片质量描述的一句话示例", () => {
  render(<PhotoAutoSelect />);
  const input = screen.getByRole("textbox", { name: "一句话挑片" }) as HTMLInputElement;
  expect(input.placeholder).toBe("例如：挑 20 张，优先清晰、构图完整，按拍摄时间排序");
});
it("一句话挑照片始终强制 photo 与张数，不把视频时长预算带进去", async () => {
  render(<PhotoAutoSelect />);
  fireEvent.change(screen.getByRole("textbox", { name: "一句话挑片" }), { target: { value: "挑 7 张清晰的照片" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "一句话挑片" }), { key: "Enter" });
  await waitFor(() => expect(api.autoSelectEpisodeWith).toHaveBeenCalledTimes(1));
  const options = (api.autoSelectEpisodeWith.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(options).toMatchObject({ mediaKind: "photo", photoCount: 7 });
  expect(options).not.toHaveProperty("budgetSecs");
});
it("历史集只读时输入禁用，回车不会调用自动挑选", async () => {
  __resetWorkspaceForTests({ viewingEpisode: { id: 2, title: "历史集" } });
  render(<PhotoAutoSelect />);
  const input = screen.getByRole("textbox", { name: "一句话挑片" }) as HTMLInputElement;
  expect(input.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "挑 7 张照片" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await Promise.resolve();
  expect(api.autoSelectEpisodeWith).not.toHaveBeenCalled();
});
