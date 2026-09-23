// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ playerSetPreviewQuality: vi.fn(async () => {}) }));
vi.mock("../../api", () => mocks);
import { PerformanceSection } from "./PerformanceSection";
import { SettingsFormContext } from "./SettingsFormContext";
import type { SettingsForm } from "./useSettingsForm";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount(settings: Record<string, string> = {}, saved = true) {
  const save = vi.fn(async () => saved);
  render(<SettingsFormContext.Provider value={{ settings, status: null, save } as unknown as SettingsForm}>
    <PerformanceSection />
  </SettingsFormContext.Provider>);
  return save;
}
it("四个选项默认自动，保存成功后通知播放器", async () => {
  const save = mount();
  const select = screen.getByRole("combobox", { name: "预览画质" }) as HTMLSelectElement;
  expect(select.value).toBe("auto");
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
    ["auto", "自动(推荐):看原片,掉帧才改播代理"], ["high", "高画质:1080p 代理"],
    ["original", "原片:直接读原文件"], ["performance", "性能优先:540p 代理"],
  ]);
  fireEvent.change(select, { target: { value: "high" } });
  expect(save).toHaveBeenCalledWith("performance.preview_quality", "high");
  await waitFor(() => expect(mocks.playerSetPreviewQuality).toHaveBeenCalledWith("high"));
});
it("代理关闭时禁用并说明原因", () => {
  mount({ "performance.proxy_enabled": "false" });
  expect((screen.getByRole("combobox", { name: "预览画质" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText(/预览用小文件已关闭，所有档位均读取原片/)).toBeTruthy();
});
it("保存失败不切换，播放器未开时静默", async () => {
  mount({}, false);
  fireEvent.change(screen.getByRole("combobox", { name: "预览画质" }), { target: { value: "original" } });
  await Promise.resolve();
  expect(mocks.playerSetPreviewQuality).not.toHaveBeenCalled();
  cleanup(); mount(); mocks.playerSetPreviewQuality.mockRejectedValueOnce(new Error("未开"));
  fireEvent.change(screen.getByRole("combobox", { name: "预览画质" }), { target: { value: "original" } });
  await waitFor(() => expect(mocks.playerSetPreviewQuality).toHaveBeenCalledWith("original"));
});
