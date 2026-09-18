// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 0, chapters: 0 })),
}));
vi.mock("../api", () => apiMocks);
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: vi.fn(async () => undefined) }));
// 卡片的勾 / 当前步与顶栏导航同一套数据:直接喂 usePipeline 的输出。
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

import { MonitorIdle, OnboardingCard } from "./OnboardingCard";
import { STEPS_SEEN_KEY } from "./onboarding";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

beforeEach(() => {
  __resetWorkspaceForTests();
  pipelineMock.state = derivePipeline(base);
  apiMocks.getSettings.mockReset().mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

/** R11 简化专项 #1 → R12 §1:首启四步引导是空工作区里的一张轻卡片,不是模态。 */
describe("OnboardingCard", () => {
  it("库空且没看过:四步各一句,第 ① 步 aria-current;唯一的 primary 是「开始使用」,点它打开导入抽屉", async () => {
    render(<OnboardingCard clipCount={0} loading={false} />);
    const card = await screen.findByRole("group", { name: "四步上手" });
    expect(card.getAttribute("aria-modal")).toBeNull();
    expect(card.closest("[role='dialog']")).toBeNull();
    // R19 U-03:四步改成动作句(onboarding.ts 的 ONBOARDING_STEPS)。
    for (const text of ["选文件夹", "软件挑 / 你按 F", "拖顺序", "交给剪映"]) expect(screen.getByText(text)).toBeTruthy();
    expect(card.querySelectorAll("li")).toHaveLength(4);
    expect(card.querySelector("li[aria-current='step']")?.textContent).toContain("选文件夹");
    const start = screen.getByRole("button", { name: "开始使用" });
    expect(start.className).toContain("ui-button--primary");
    expect(card.querySelectorAll(".ui-button--primary").length).toBe(1);
    // 旧三步卡的三颗按钮不再存在(AX 名释放)。
    for (const name of ["选择素材文件夹", "自动挑选", "导出片段"]) expect(screen.queryByRole("button", { name })).toBeNull();
    start.click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
  });

  it("勾与当前步来自流水线数据:① 完成打勾、② 当前", async () => {
    pipelineMock.state = derivePipeline({ ...base, clipCount: 3 });
    render(<OnboardingCard clipCount={0} loading={false} />);
    const card = await screen.findByRole("group", { name: "四步上手" });
    const items = card.querySelectorAll("li");
    expect(items[0].className).toContain("onboarding-step--done");
    expect(items[0].querySelector("svg[data-icon='check']")).not.toBeNull();
    expect(items[1].getAttribute("aria-current")).toBe("step");
  });

  it("「关闭引导」收起卡片并写 onboarding.steps_seen=true", async () => {
    render(<OnboardingCard clipCount={0} loading={false} />);
    const close = await screen.findByRole("button", { name: "关闭引导" });
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("group", { name: "四步上手" })).toBeNull();
    expect(apiMocks.setSetting).toHaveBeenCalledWith(STEPS_SEEN_KEY, "true");
  });

  it("已看过(steps_seen=true)不渲染;库里有素材时静默记 seen 且不渲染", async () => {
    apiMocks.getSettings.mockResolvedValue({ [STEPS_SEEN_KEY]: "true" });
    const { unmount } = render(<OnboardingCard clipCount={0} loading={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("group", { name: "四步上手" })).toBeNull();
    unmount();

    apiMocks.getSettings.mockResolvedValue({});
    render(<OnboardingCard clipCount={5} loading={false} />);
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith(STEPS_SEEN_KEY, "true"));
    expect(screen.queryByRole("group", { name: "四步上手" })).toBeNull();
  });

  it("MonitorIdle:卡片不可见时落回监视器原句「从左侧媒体池选一条素材」", async () => {
    apiMocks.getSettings.mockResolvedValue({ [STEPS_SEEN_KEY]: "true" });
    render(<MonitorIdle clipCount={0} loading={false} />);
    expect(await screen.findByText("从左侧媒体池选一条素材")).toBeTruthy();
  });
});

describe("MonitorIdle 持有引导状态", () => {
  it("在 MonitorIdle 里点「关闭引导」:卡片消失、占位句回来(不是一片空白)", async () => {
    render(<MonitorIdle clipCount={0} loading={false} />);
    const close = await screen.findByRole("button", { name: "关闭引导" });
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("group", { name: "四步上手" })).toBeNull();
    expect(screen.getByText("从左侧媒体池选一条素材")).toBeTruthy();
  });
});
