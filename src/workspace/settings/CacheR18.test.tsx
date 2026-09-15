// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { ToastHost } from "../ui/Toast";
import { __resetToastsForTests } from "../ui/toastStore";
import { AUTO_CLEAN_CHOICES, CACHE_LOCATION, CacheSection, cacheLocationLabel } from "./CacheSection";
import { SettingsFormContext } from "./SettingsFormContext";
import type { SettingsForm } from "./useSettingsForm";

function mount(settings: Record<string, string> = {}) {
  const save = vi.fn(async () => true);
  const form = {
    settings,
    status: null,
    cacheConfirm: false,
    busy: false,
    save,
    clearCache: vi.fn(async () => undefined),
  } as unknown as SettingsForm;
  render(
    <SettingsFormContext.Provider value={form}>
      <ToastHost />
      <CacheSection />
    </SettingsFormContext.Provider>,
  );
  return save;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastsForTests();
});
afterEach(() => cleanup());

/** R18 车道 settings F5 / F6:缓存位置一行 + 自动清理一档。 */
describe("F5 更改缓存位置", () => {
  it("没搬过时显示内置位置;搬过之后显示实际路径", () => {
    mount({});
    expect(screen.getByText(cacheLocationLabel(""))).toBeTruthy();
    cleanup();
    mount({ "cache.custom_dir": "/Volumes/外接盘/TripCut缓存" });
    expect(screen.getByText("/Volumes/外接盘/TripCut缓存")).toBeTruthy();
  });

  it("「更改…」先选文件夹再搬;用户取消选择就什么都不做", async () => {
    apiMocks.pickCacheFolder.mockResolvedValue(null);
    mount({});
    fireEvent.click(screen.getByRole("button", { name: CACHE_LOCATION.change }));
    await waitFor(() => expect(apiMocks.pickCacheFolder).toHaveBeenCalledTimes(1));
    expect(apiMocks.relocateCacheDir).not.toHaveBeenCalled();
  });

  it("选了文件夹就调搬迁;失败时把「现在怎么办」原样摆出来", async () => {
    apiMocks.pickCacheFolder.mockResolvedValue("/Volumes/外接盘");
    apiMocks.relocateCacheDir.mockRejectedValue(new Error("这块盘装不下缓存:要 8.8 GB,只剩 1.0 GB。现在怎么办:先清理缓存"));
    mount({});
    fireEvent.click(screen.getByRole("button", { name: CACHE_LOCATION.change }));
    await waitFor(() => expect(apiMocks.relocateCacheDir).toHaveBeenCalledWith("/Volumes/外接盘"));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("现在怎么办");
  });
});

describe("F6 缓存自动清理", () => {
  it("默认「从不」,选一档就存天数", () => {
    const save = mount({});
    const select = screen.getByLabelText(CACHE_LOCATION.autoClean) as HTMLSelectElement;
    expect(select.value).toBe("0");
    expect(AUTO_CLEAN_CHOICES.map(([value]) => value)).toEqual(["0", "15", "30", "60", "90"]);
    fireEvent.change(select, { target: { value: "30" } });
    expect(save).toHaveBeenCalledWith("cache.auto_clean_days", "30");
  });
});
