// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { UPDATE_PROGRESS_EVENT } from "../../api";
import { __resetUpdateStoreForTests } from "../update/updateStore";
import { AboutUpdate } from "./AboutUpdate";

const NEW_VERSION = { available: true, version: "0.8.0", notes: "## 0.8.0\n\n- 自动发现新版本\n- 修了导出", pub_date: "2026-09-14T08:00:00Z", current_version: "0.8.0", offline: false, skipped: false };

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpdateStoreForTests();
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.checkForUpdate.mockResolvedValue({ available: false, version: "0.7.0", notes: "", pub_date: "", current_version: "0.8.0", offline: false, skipped: false });
  apiMocks.downloadUpdate.mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount(settings: Record<string, string> = {}) {
  const save = vi.fn(async () => true);
  const view = render(<AboutUpdate version="0.7.0" settings={settings} save={save} />);
  return { ...view, save };
}

/** R17 车道 B:设置 › 关于 的更新区块。 */
describe("AboutUpdate", () => {
  it("「自动更新」开关默认开,关掉写 updater.auto_update=false;「先问我再下载」默认不勾,勾上写 ask_before_download=true", async () => {
    const { save } = mount();
    const toggle = screen.getByRole("switch", { name: "自动更新" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(save).toHaveBeenCalledWith("updater.auto_update", "false"));
    const ask = screen.getByRole("checkbox", { name: "有新版本时先问我再下载" }) as HTMLInputElement;
    expect(ask.checked).toBe(false);
    fireEvent.click(ask);
    await waitFor(() => expect(save).toHaveBeenCalledWith("updater.ask_before_download", "true"));
  });

  it("自动更新关着时开关反映设置,「先问我」勾选框禁用", () => {
    mount({ "updater.auto_update": "false", "updater.ask_before_download": "true" });
    expect(screen.getByRole("switch", { name: "自动更新" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("checkbox", { name: "有新版本时先问我再下载" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("显示当前版本与上次检查;检查前「尚未检查更新。」;「检查更新」→ 已是最新", async () => {
    mount({ "updater.last_check": new Date(Date.now() - 2 * 3_600_000).toISOString() });
    expect(screen.getByText(/当前版本 0\.7\.0/)).toBeTruthy();
    expect(screen.getByText(/上次检查 2 小时前/)).toBeTruthy();
    const status = screen.getByTestId("updater-status");
    expect(status.textContent).toBe("尚未检查更新。");
    expect(status.getAttribute("data-updater-status")).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(screen.getByTestId("updater-status").textContent).toBe("已是最新版本。"));
    expect(screen.getByText(/上次检查 刚刚/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "现在更新" })).toBeNull();
  });

  it("有新版本 → 内联「有新版本 0.8.0」+「现在更新」+「查看更新说明」;下载走同一套流程到「重启完成更新」", async () => {
    apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
    let finish: () => void = () => undefined;
    apiMocks.downloadUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText(/有新版本 0\.8\.0/);
    // 更新说明:markdown 变纯文本段落,默认收起。
    expect(screen.queryByText(/自动发现新版本/)).toBeNull();
    const notesButton = screen.getByRole("button", { name: "查看更新说明" });
    expect(notesButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(notesButton);
    expect(screen.getByText(/• 自动发现新版本/)).toBeTruthy();
    expect(screen.queryByText(/##/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "现在更新" }));
    await waitFor(() => expect(apiMocks.downloadUpdate).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new CustomEvent(UPDATE_PROGRESS_EVENT, { detail: { downloaded: 42, total: 100 } }));
    });
    expect(screen.getByText("正在下载更新 42%")).toBeTruthy();
    expect((screen.getByRole("button", { name: "检查更新" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish();
    });
    const restart = await screen.findByRole("button", { name: "重启完成更新" });
    expect(screen.getByTestId("updater-status").getAttribute("data-updater-status")).toBe("ready");
    fireEvent.click(restart);
    await waitFor(() => expect(apiMocks.restartToUpdate).toHaveBeenCalledTimes(1));
  });

  it("检查失败内联白话原因 + 原文小字 + 「打开下载页」;下载失败可「再试一次」", async () => {
    apiMocks.checkForUpdate.mockRejectedValue(new Error("error sending request: dns error"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText(/检查更新没成功:网络连不上更新服务器/);
    expect(screen.getByText(/dns error/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开下载页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();

    apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
    apiMocks.downloadUpdate.mockRejectedValueOnce(new Error("The signature verification failed"));
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    fireEvent.click(await screen.findByRole("button", { name: "现在更新" }));
    await screen.findByText(/更新没成功:更新包没通过安全校验/);
    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    await screen.findByRole("button", { name: "重启完成更新" });
  });
});
