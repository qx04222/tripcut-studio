// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { ToastHost } from "../ui/Toast";
import { __resetToastsForTests } from "../ui/toastStore";
import { SettingsFormContext } from "./SettingsFormContext";
import { RERUN_WATCHDOG_MS, ToolsSection } from "./ToolsSection";
import type { SettingsForm } from "./useSettingsForm";

function mount(overrides: Partial<SettingsForm> = {}) {
  const form = {
    settings: {},
    status: null,
    componentStatuses: [],
    busy: false,
    rollbackNotice: null,
    setDraft: vi.fn(),
    savePath: vi.fn(async () => true),
    saveWhisperTier: vi.fn(async () => true),
    refreshStatus: vi.fn(async () => undefined),
    rollbackTool: vi.fn(async () => undefined),
    runSelfCheck: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SettingsForm;
  return render(
    <SettingsFormContext.Provider value={form}>
      <ToastHost />
      <ToolsSection />
    </SettingsFormContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastsForTests();
  apiMocks.listDisplayLuts.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * A16-04(0.8.0 真机):设置 › 工具与模型 的「重新计算时刻分」/「重新识别画面文字」按下
 * 无 toast 无任务。任何一次按下都必须有一条 toast:排了 n 条 / 没有需要重算的 / 失败白话 /
 * 后端迟迟不回也要说一声;并且不能被别的操作(清缓存、自检)的 busy 静默禁用。
 */
describe("整集重算(A16-04)", () => {
  it("排了 n 条 → 「已排队 n 条」", async () => {
    apiMocks.enqueueMomentsBackfill.mockResolvedValue(7);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "重新计算时刻分" }));
    await screen.findByText(/已排队 7 条素材重新计算时刻分/);
  });

  it("没有需要重算的 → 「没有需要重新识别的素材」", async () => {
    apiMocks.enqueueOcrForEpisode.mockResolvedValue(0);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "重新识别画面文字" }));
    await screen.findByText(/没有需要重新识别的素材/);
  });

  it("后端拒绝 → 失败白话进 toast", async () => {
    apiMocks.enqueueMomentsBackfill.mockRejectedValue(new Error("数据库正忙"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "重新计算时刻分" }));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("数据库正忙");
  });

  it("别的操作 busy 时两个按钮仍可按(不再被无声禁用),按下照样出 toast", async () => {
    apiMocks.enqueueMomentsBackfill.mockResolvedValue(2);
    mount({ busy: true } as Partial<SettingsForm>);
    const button = screen.getByRole("button", { name: "重新计算时刻分" });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    await screen.findByText(/已排队 2 条/);
  });

  it("后端迟迟不回 → 到时也要说一声,不能一直没动静", async () => {
    vi.useFakeTimers();
    apiMocks.enqueueOcrForEpisode.mockReturnValue(new Promise<number>(() => undefined));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "重新识别画面文字" }));
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(RERUN_WATCHDOG_MS + 10);
    });
    const toast = screen.getByRole("status");
    expect(toast.textContent).toMatch(/还没回话|稍后/);
  });
});
