// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { UPDATE_PROGRESS_EVENT } from "../../api";
import { UpdateTopChip } from "./UpdateTopChip";
import { __resetUpdateStoreForTests, runUpdateCheck, runUpdateDownload } from "./updateStore";

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpdateStoreForTests();
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.checkForUpdate.mockResolvedValue({ available: true, version: "0.8.2", notes: "", pub_date: "", current_version: "0.8.1", offline: false, skipped: false });
});
afterEach(cleanup);

/** 业主:顶栏最右端、设置旁边的新版本提醒,点击即更新。 */
describe("UpdateTopChip", () => {
  it("平时不渲染;发现新版本显示「新版本 x」,点击开始下载;下载中念进度;下完变「重启完成更新」", async () => {
    const { container } = render(<UpdateTopChip />);
    expect(container.textContent).toBe("");

    await act(async () => {
      await runUpdateCheck("manual");
    });
    const available = screen.getByRole("button", { name: "新版本 0.8.2" });

    let finish: () => void = () => undefined;
    apiMocks.downloadAndInstallUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let downloading!: Promise<unknown>;
    act(() => {
      fireEvent.click(available);
      downloading = runUpdateDownload();
    });
    expect(apiMocks.downloadAndInstallUpdate).toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new CustomEvent(UPDATE_PROGRESS_EVENT, { detail: { downloaded: 42, total: 100 } }));
    });
    expect(screen.getByRole("status").textContent).toContain("42%");
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => {
      finish();
      await downloading;
    });
    fireEvent.click(screen.getByRole("button", { name: "重启完成更新" }));
    expect(apiMocks.restartToUpdate).toHaveBeenCalledTimes(1);
  });
});
