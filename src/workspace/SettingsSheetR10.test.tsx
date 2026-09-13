// @vitest-environment jsdom
// R10 U-24:设置「工具链」卡的 Whisper 模型导入(模型缺失态:官方地址 / SHA-256 / 目标路径 / 「导入模型文件…」)。
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import type { ComponentStatus, SettingsStatus } from "../api";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
const MODEL_SHA = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69";
const MODEL_PATH = "/Users/x/Library/Application Support/TripCutStudio/models/ggml-large-v3-turbo.bin";

const whisperModel: ComponentStatus = {
  id: "whisper-model",
  title: "Whisper 模型 (large-v3-turbo)",
  installed: false,
  detail: "缺失",
  installable: false,
  approx_size_mb: 1600,
  has_previous: false,
  previous_version: null,
  recovered_from_rolling: false,
  download_url: MODEL_URL,
  expected_sha256: MODEL_SHA,
  target_path: MODEL_PATH,
};

async function baseStatus(): Promise<SettingsStatus> {
  return (await apiMocks.getSettingsStatus.getMockImplementation()!()) as SettingsStatus;
}

async function openToolsPanel(): Promise<HTMLElement> {
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
    // R11 简化专项 #2:工具链并入「工具与模型」分区(SettingsSheet.test 有搬迁表)。
    within(dialog).getByRole("tab", { name: "工具与模型" }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

beforeEach(async () => {
  __resetWorkspaceForTests();
  vi.clearAllMocks();
  apiMocks.hasMinimaxKey.mockReset().mockResolvedValue(false);
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
  apiMocks.getComponentStatuses.mockResolvedValue([whisperModel]);
  const status = await baseStatus();
  apiMocks.getSettingsStatus.mockResolvedValue({ ...status, whisper: { ...status.whisper, model_available: false } });
});
afterEach(cleanup);

describe("R10 U-24:Whisper 模型缺失态", () => {
  it("显示官方地址(可复制)、期望 SHA-256、目标路径与「导入模型文件…」", async () => {
    const panel = await openToolsPanel();
    const card = await within(panel).findByRole("group", { name: "Whisper 模型文件" });
    expect(within(card).getByText(MODEL_URL)).toBeTruthy();
    expect(within(card).getByText(MODEL_SHA)).toBeTruthy();
    expect(within(card).getByText(MODEL_PATH)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "复制下载地址" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "导入模型文件…" })).toBeTruthy();
  });

  it("模型已安装时不显示缺失态卡", async () => {
    const status = await baseStatus();
    apiMocks.getSettingsStatus.mockResolvedValue({ ...status, whisper: { ...status.whisper, model_available: true } });
    const panel = await openToolsPanel();
    await within(panel).findByText("模型已安装");
    expect(within(panel).queryByRole("group", { name: "Whisper 模型文件" })).toBeNull();
  });

  it("「导入模型文件…」:选文件 → importWhisperModel,忙态 aria-busy,成功后重新检测并提示", async () => {
    apiMocks.pickWhisperModelFile.mockResolvedValue("/Users/x/Downloads/ggml-large-v3-turbo.bin");
    let finish: (value: unknown) => void = () => undefined;
    apiMocks.importWhisperModel.mockReturnValue(new Promise((resolve) => { finish = resolve; }) as never);
    const panel = await openToolsPanel();
    const card = await within(panel).findByRole("group", { name: "Whisper 模型文件" });
    const button = within(card).getByRole("button", { name: "导入模型文件…" });
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.importWhisperModel).toHaveBeenCalledWith("/Users/x/Downloads/ggml-large-v3-turbo.bin");
    expect(within(card).getByRole("button", { name: "正在校验并导入…" }).getAttribute("aria-busy")).toBe("true");
    const calls = apiMocks.getSettingsStatus.mock.calls.length;
    await act(async () => {
      finish({ tier: "large-v3-turbo", file_name: "ggml-large-v3-turbo.bin", target_path: MODEL_PATH, sha256: MODEL_SHA, matches_active_tier: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.getSettingsStatus.mock.calls.length).toBeGreaterThan(calls));
    expect(within(card).getByRole("status").textContent).toContain("已导入 ggml-large-v3-turbo.bin");
  });

  it("摘要不匹配:错误原文以 role=alert 显示,按钮恢复可点", async () => {
    apiMocks.pickWhisperModelFile.mockResolvedValue("/Users/x/Downloads/wrong.bin");
    apiMocks.importWhisperModel.mockRejectedValue(new Error("SHA-256 不匹配:期望 1fc70f77… 或 1be3a9b2…"));
    const panel = await openToolsPanel();
    const card = await within(panel).findByRole("group", { name: "Whisper 模型文件" });
    await act(async () => {
      within(card).getByRole("button", { name: "导入模型文件…" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((await within(card).findByRole("alert")).textContent).toContain("SHA-256 不匹配");
    expect((within(card).getByRole("button", { name: "导入模型文件…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("取消文件选择:不调 importWhisperModel,也不报错", async () => {
    apiMocks.pickWhisperModelFile.mockResolvedValue(null);
    const panel = await openToolsPanel();
    const card = await within(panel).findByRole("group", { name: "Whisper 模型文件" });
    await act(async () => {
      within(card).getByRole("button", { name: "导入模型文件…" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.importWhisperModel).not.toHaveBeenCalled();
    expect(within(card).queryByRole("alert")).toBeNull();
  });
});
