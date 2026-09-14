// @vitest-environment jsdom
// R16 车道 A:设置页各行 —— P2-5 整集重算、P2-8 导出文件夹「清除」、P2-11 重置新手引导、P2-12 恢复默认布局、P2-13 复制诊断信息。
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { SETTINGS_ACTIONS } from "./copy";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

async function openTab(name: string): Promise<HTMLElement> {
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
    within(dialog).getByRole("tab", { name }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  __resetWorkspaceForTests();
  __resetToastsForTests();
  vi.clearAllMocks();
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
  apiMocks.setFirstRunDone.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("P2-5 工具与模型 › 整集重算", () => {
  it("「重新计算时刻分」→ enqueue_moments_backfill;「重新识别画面文字」→ enqueue_ocr_for_episode;toast 说排了几条;文案提到耗时", async () => {
    apiMocks.enqueueMomentsBackfill.mockResolvedValue(12);
    apiMocks.enqueueOcrForEpisode.mockResolvedValue(0);
    const panel = await openTab("工具与模型");
    expect(panel.textContent).toContain("几分钟到十几分钟");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: SETTINGS_ACTIONS.recomputeMoments }));
    });
    await waitFor(() => expect(apiMocks.enqueueMomentsBackfill).toHaveBeenCalledTimes(1));
    await settle();
    expect(getToastSnapshot()?.text).toContain("已排队 12 条素材重新计算时刻分");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: SETTINGS_ACTIONS.rerunOcr }));
    });
    await waitFor(() => expect(apiMocks.enqueueOcrForEpisode).toHaveBeenCalledTimes(1));
    await settle();
    expect(getToastSnapshot()?.text).toContain("没有需要重新识别的素材");
  });
});

