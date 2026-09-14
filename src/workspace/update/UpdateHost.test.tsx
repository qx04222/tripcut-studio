// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { ToastHost } from "../ui/Toast";
import { __resetToastsForTests } from "../ui/toastStore";
import { UpdateHost } from "./UpdateHost";
import { __resetUpdateStoreForTests, getUpdateSnapshot } from "./updateStore";

const NEW_VERSION = { available: true, version: "0.8.0", notes: "- 修了导出", pub_date: "2026-09-14T08:00:00Z", current_version: "0.8.0", offline: false, skipped: false };

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpdateStoreForTests();
  __resetToastsForTests();
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.downloadAndInstallUpdate.mockResolvedValue(undefined);
  apiMocks.bridgeUpdateProgressEvents.mockResolvedValue(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(delay = 0) {
  return render(
    <>
      <ToastHost />
      <UpdateHost autoCheckDelayMs={delay} />
    </>,
  );
}

/** R17 车道 B:启动后自动升级 → 一条不打扰的提示。 */
describe("UpdateHost", () => {
  it("启动 30 秒后才查;默认静默下载完成后出「更新已下载 0.8.0 · 重启完成更新 / 稍后 / 跳过这个版本」", async () => {
    vi.useFakeTimers();
    mount(30_000);
    await act(async () => {
      vi.advanceTimersByTime(29_000);
      await Promise.resolve();
    });
    expect(apiMocks.checkForUpdate).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(apiMocks.checkForUpdate).toHaveBeenCalledTimes(1));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("更新已下载 0.8.0");
    expect(screen.getByRole("button", { name: "重启完成更新" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "稍后" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "跳过这个版本" })).toBeTruthy();
    // 没有「有新版本」那条——默认不问,直接下。
    expect(toast.textContent).not.toContain("有新版本");
    fireEvent.click(screen.getByRole("button", { name: "重启完成更新" }));
    await waitFor(() => expect(apiMocks.restartToUpdate).toHaveBeenCalledTimes(1));
  });

  it("「先问我再下载」开着:出「有新版本 0.8.0 · 现在更新 / 稍后 / 跳过这个版本」;跳过写设置", async () => {
    apiMocks.getSettings.mockResolvedValue({ "updater.ask_before_download": "true" });
    mount();
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("有新版本 0.8.0");
    expect(apiMocks.downloadAndInstallUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "跳过这个版本" }));
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("updater.skipped_version", "0.8.0"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(getUpdateSnapshot().phase).toBe("idle");
  });

  it("「现在更新」走同一套下载;下载失败出「更新没成功:网络连不上更新服务器 · 打开下载页」", async () => {
    apiMocks.getSettings.mockResolvedValue({ "updater.ask_before_download": "true" });
    apiMocks.downloadAndInstallUpdate.mockRejectedValue(new Error("connection reset by peer"));
    apiMocks.openExternalUrl.mockRejectedValue(new Error("no such command"));
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    mount();
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "现在更新" }));
    await waitFor(() => expect(apiMocks.downloadAndInstallUpdate).toHaveBeenCalledTimes(1));
    const failed = await screen.findByText(/更新没成功:网络连不上更新服务器/);
    expect(failed.closest('[role="status"]')?.className).toContain("ui-toast--danger");
    fireEvent.click(screen.getByRole("button", { name: "打开下载页" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith("https://github.com/qx04222/tripcut-studio/releases/latest", "_blank", "noopener"));
    opened.mockRestore();
  });

  it("自动更新关掉 / 离线时什么都不出;「稍后」清掉上次检查时间", async () => {
    apiMocks.getSettings.mockResolvedValue({ "updater.auto_update": "false" });
    mount();
    await waitFor(() => expect(apiMocks.getSettings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMocks.checkForUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();

    apiMocks.getSettings.mockResolvedValue({});
    mount();
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("updater.last_check", ""));
    expect(screen.queryByRole("status")).toBeNull();
    expect(getUpdateSnapshot().phase).toBe("ready");
  });
});
