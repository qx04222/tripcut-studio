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
import { SettingsFormContext } from "./SettingsFormContext";
import { RESTORE_BUILTIN, ToolsSection } from "./ToolsSection";
import type { SettingsForm } from "./useSettingsForm";

function mount(settings: Record<string, string>) {
  const savePath = vi.fn(async () => undefined);
  const setDraft = vi.fn();
  const form = {
    settings,
    status: null,
    componentStatuses: [],
    busy: false,
    rollbackNotice: null,
    setDraft,
    savePath,
    saveWhisperTier: vi.fn(async () => undefined),
    refreshStatus: vi.fn(async () => undefined),
    rollbackTool: vi.fn(async () => undefined),
    runSelfCheck: vi.fn(async () => undefined),
  } as unknown as SettingsForm;
  render(
    <SettingsFormContext.Provider value={form}>
      <ToastHost />
      <ToolsSection />
    </SettingsFormContext.Provider>,
  );
  return { savePath, setDraft };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastsForTests();
  apiMocks.listDisplayLuts.mockResolvedValue([]);
});
afterEach(() => cleanup());

/**
 * R18 车道 settings F7:三个路径框各一颗「恢复内置」——清空 = 用内置。
 * 框里本来就是空的时候按钮禁用(没什么可恢复),避免一颗永远能按却什么都不做的按钮。
 */
describe("F7 恢复内置", () => {
  it("三个路径框各有一颗「恢复内置」,填了路径才能按", () => {
    mount({ "tools.ffmpeg_path": "/opt/homebrew/bin/ffmpeg", "tools.ffprobe_path": "", "tools.whisper_path": "" });
    const buttons = screen.getAllByRole("button", { name: /^恢复内置/ });
    expect(buttons).toHaveLength(3);
    expect(screen.getByRole("button", { name: `${RESTORE_BUILTIN} 视频处理组件` }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: `${RESTORE_BUILTIN} 媒体信息组件` }).hasAttribute("disabled")).toBe(true);
  });

  it("按下后把这一把键存成空串并给一条 toast", async () => {
    const { savePath, setDraft } = mount({ "tools.whisper_path": "/somewhere/whisper-cli", "tools.ffmpeg_path": "", "tools.ffprobe_path": "" });
    fireEvent.click(screen.getByRole("button", { name: `${RESTORE_BUILTIN} 转写组件` }));
    expect(setDraft).toHaveBeenCalledWith("tools.whisper_path", "");
    await waitFor(() => expect(savePath).toHaveBeenCalledWith("tools.whisper_path", ""));
    expect(savePath).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("status")).textContent).toContain("转写组件已恢复内置");
  });
});
