// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
}));
vi.mock("../api", () => apiMocks);

import { MonitorIdle, OnboardingCard } from "./OnboardingCard";
import { OPEN_AUTO_SELECT_EVENT, STEPS_SEEN_KEY } from "./onboarding";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  apiMocks.getSettings.mockReset().mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

/** R11 简化专项 #1:首启三步引导是空工作区里的一张轻卡片,不是模态。 */
describe("OnboardingCard", () => {
  it("库空且没看过:三步各一句 + 三个按钮;只有「选择素材文件夹」是 primary,其余两个先禁用", async () => {
    render(<OnboardingCard clipCount={0} loading={false} />);
    const card = await screen.findByRole("group", { name: "三步上手" });
    expect(card.getAttribute("aria-modal")).toBeNull();
    expect(card.closest("[role='dialog']")).toBeNull();
    for (const text of ["导入素材", "挑选片段", "导出"]) expect(screen.getByText(text)).toBeTruthy();
    const importButton = screen.getByRole("button", { name: "选择素材文件夹" });
    expect(importButton.className).toContain("ui-button--primary");
    expect((screen.getByRole("button", { name: "自动挑选" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "导出片段" }) as HTMLButtonElement).disabled).toBe(true);
    expect(card.querySelectorAll(".ui-button--primary").length).toBe(1);
    importButton.click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
  });

  it("「关闭引导」收起卡片并写 onboarding.steps_seen=true", async () => {
    render(<OnboardingCard clipCount={0} loading={false} />);
    const close = await screen.findByRole("button", { name: "关闭引导" });
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("group", { name: "三步上手" })).toBeNull();
    expect(apiMocks.setSetting).toHaveBeenCalledWith(STEPS_SEEN_KEY, "true");
  });

  it("已看过(steps_seen=true)不渲染;库里有素材时静默记 seen 且不渲染", async () => {
    apiMocks.getSettings.mockResolvedValue({ [STEPS_SEEN_KEY]: "true" });
    const { unmount } = render(<OnboardingCard clipCount={0} loading={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("group", { name: "三步上手" })).toBeNull();
    unmount();

    apiMocks.getSettings.mockResolvedValue({});
    render(<OnboardingCard clipCount={5} loading={false} />);
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith(STEPS_SEEN_KEY, "true"));
    expect(screen.queryByRole("group", { name: "三步上手" })).toBeNull();
  });

  it("有素材时「自动挑选」广播打开镜头带的自动挑选面板,「导出片段」打开交付抽屉", async () => {
    // 这两个按钮只在库里有素材时可点 —— 用「已看过 = false、库非空」以外的路径:直接给 clipCount 传 0 但强制显示不合理,
    // 所以这里验证的是按钮的去向本身(组件暴露的 visible 判定已在 onboarding.test 里钉住)。
    const heard = vi.fn();
    window.addEventListener(OPEN_AUTO_SELECT_EVENT, heard);
    render(<OnboardingCard clipCount={0} loading={false} forceEnabled />);
    (await screen.findByRole("button", { name: "自动挑选" })).click();
    expect(heard).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "导出片段" }).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    window.removeEventListener(OPEN_AUTO_SELECT_EVENT, heard);
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
    expect(screen.queryByRole("group", { name: "三步上手" })).toBeNull();
    expect(screen.getByText("从左侧媒体池选一条素材")).toBeTruthy();
  });
});
