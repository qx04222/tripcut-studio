// @vitest-environment jsdom
// R11 §1.2 / §3(车道 C):设置 → 外观 里的两行播放器开关(默认开,关掉写表并同步进程内快照)。
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { __resetPlayerPrefsForTests, getPlayerPrefs, loadPlayerPrefs } from "./playerPrefs";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

async function openAppearance(): Promise<HTMLElement> {
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
    // R13 §2:播放器偏好住在「播放与导出」分区(SettingsSheet.test 有搬迁表)。
    within(dialog).getByRole("tab", { name: "播放与导出" }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

beforeEach(() => {
  __resetWorkspaceForTests();
  __resetPlayerPrefsForTests();
  vi.clearAllMocks();
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("R11 播放器偏好开关", () => {
  it("「选中素材从最精彩处开播」默认开、「播完自动播下一条」默认关(R12 §5);拨动写 ui.player.* 并同步给监视器", async () => {
    const panel = await openAppearance();
    const startAtBest = within(panel).getByRole("switch", { name: "选中素材从最精彩处开播" });
    const autoAdvance = within(panel).getByRole("switch", { name: "播完自动播下一条" });
    expect(startAtBest.getAttribute("aria-checked")).toBe("true");
    expect(autoAdvance.getAttribute("aria-checked")).toBe("false");
    await loadPlayerPrefs();
    expect(getPlayerPrefs()).toMatchObject({ startAtBest: true, autoAdvance: false });
    await act(async () => {
      startAtBest.click();
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.player.start_at_best", "false");
    expect(getPlayerPrefs().startAtBest).toBe(false);
    await waitFor(() => expect(startAtBest.getAttribute("aria-checked")).toBe("false"));
    await act(async () => {
      autoAdvance.click();
      await Promise.resolve();
    });
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.player.auto_advance", "true");
    expect(getPlayerPrefs().autoAdvance).toBe(true);
  });
});
