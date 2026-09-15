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
import { AboutSection, EXPORT_DIAGNOSTICS_BUNDLE } from "./AboutSection";
import { SettingsFormContext } from "./SettingsFormContext";
import type { SettingsForm } from "./useSettingsForm";

function mount() {
  const form = {
    settings: {},
    appInfo: { version: "0.9.0", db_schema_version: 41, worker_count: 4, read_only: false },
    busy: false,
    save: vi.fn(async () => true),
    openLogs: vi.fn(async () => undefined),
  } as unknown as SettingsForm;
  render(
    <SettingsFormContext.Provider value={form}>
      <ToastHost />
      <AboutSection />
    </SettingsFormContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetToastsForTests();
});
afterEach(() => cleanup());

/** R18 车道 settings M-04:设置 › 关于 的「导出诊断包…」。 */
describe("M-04 导出诊断包", () => {
  it("成功后 toast 要把「里面没有什么」说出来", async () => {
    apiMocks.exportDiagnosticsBundle.mockResolvedValue({ path: "~/Desktop/旅剪诊断.zip", log_files: 3, failed_jobs: 2 });
    mount();
    fireEvent.click(screen.getByRole("button", { name: EXPORT_DIAGNOSTICS_BUNDLE }));
    await waitFor(() => expect(apiMocks.exportDiagnosticsBundle).toHaveBeenCalledTimes(1));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("3 份日志");
    expect(toast.textContent).toContain("没有原片、转写和 GPS");
  });

  it("用户在保存面板上按取消(后端回 null)时不报喜也不报错", async () => {
    apiMocks.exportDiagnosticsBundle.mockResolvedValue(null);
    mount();
    fireEvent.click(screen.getByRole("button", { name: EXPORT_DIAGNOSTICS_BUNDLE }));
    await waitFor(() => expect(apiMocks.exportDiagnosticsBundle).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("失败时把「现在怎么办」原样摆出来", async () => {
    apiMocks.exportDiagnosticsBundle.mockRejectedValue(new Error("打包没成功。现在怎么办:换一个你有写入权限的位置再导一次,比如桌面。"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: EXPORT_DIAGNOSTICS_BUNDLE }));
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("现在怎么办");
  });
});
