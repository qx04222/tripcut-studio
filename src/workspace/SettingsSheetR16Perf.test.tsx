// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  vi.clearAllMocks();
  apiMocks.hasMinimaxKey.mockReset().mockResolvedValue(false);
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

async function openPerformance(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    const button = screen.getByRole("button", { name: "设置" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("设置已从本地项目载入"));
  await act(async () => {
    within(dialog).getByRole("tab", { name: "性能" }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel").querySelector<HTMLElement>('[data-section="performance"]')!;
}

/**
 * R16 车道 E(§3 ①):设置 › 性能 的「省电 / 低配模式」三态开关。
 * 新 AX 名:combobox「省电 / 低配模式」(选项 自动 / 开 / 关),写 `performance.low_spec_mode`。
 */
describe("设置 › 性能 · 省电 / 低配模式(R16)", () => {
  it("默认「自动」,切到「开」写 performance.low_spec_mode=on;文案不出现内部术语", async () => {
    const panel = await openPerformance();
    const select = within(panel).getByRole("combobox", { name: "省电 / 低配模式" }) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["自动", "开", "关"]);
    await act(async () => {
      fireEvent.change(select, { target: { value: "on" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("performance.low_spec_mode", "on"));
    for (const jargon of ["worker", "sidecar", "OCR", "CLIP", "whisper", "decode"]) {
      expect(panel.textContent ?? "").not.toMatch(new RegExp(jargon, "i"));
    }
  });

  it("预览小文件上限:默认 10 GB,帮助文案显示「现在占 / 上限」,切到 20 写 performance.proxy_cache_limit_gb=20", async () => {
    // 壳里不止 sheet 读 getSettingsStatus(工具链横幅也读),Once 会被抢走 —— 用常驻值,末尾还原。
    const baseStatus = await apiMocks.getSettingsStatus();
    apiMocks.getSettingsStatus.mockResolvedValue({
      ...baseStatus,
      cache: { database_bytes: 0, disk_bytes: 0, proxy_bytes: 3 * 1024 ** 3, proxy_limit_bytes: 10 * 1024 ** 3 },
    });
    const panel = await openPerformance();
    const select = within(panel).getByRole("combobox", { name: "预览小文件最多占" }) as HTMLSelectElement;
    expect(select.value).toBe("10");
    expect(panel.textContent).toContain("现在占 3.00 GB / 上限 10.0 GB");
    await act(async () => {
      fireEvent.change(select, { target: { value: "20" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("performance.proxy_cache_limit_gb", "20"));
    apiMocks.getSettingsStatus.mockResolvedValue(baseStatus);
  });

  it("「只在我不用电脑时做后台工作」开关:默认关,打开写 performance.background_only_when_idle=true", async () => {
    const panel = await openPerformance();
    const toggle = within(panel).getByRole("switch", { name: "只在我不用电脑时做后台工作" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("performance.background_only_when_idle", "true"));
  });

  it("后端已存 off 时下拉显示「关」", async () => {
    apiMocks.getSettings.mockResolvedValue({ "performance.low_spec_mode": "off" });
    const panel = await openPerformance();
    const select = within(panel).getByRole("combobox", { name: "省电 / 低配模式" }) as HTMLSelectElement;
    expect(select.value).toBe("off");
    apiMocks.getSettings.mockResolvedValue({});
  });
});
